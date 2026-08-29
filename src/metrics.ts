// Live metrics engine (Prometheus/JSON over HTTP). Self-contained: takes a
// small deps object describing what it needs from the host extension.

import { debugLog, METRICS_WIDGET_ID, PROVIDER_NAME, shared } from "./core.ts";
import { httpGet } from "./scan.ts";
import type { ExtensionContext, MetricsEndpointDiscovered, ThemeFg } from "./types.ts";

const METRICS_CANDIDATE_PATHS = ["/metrics", "/v1/metrics", "/api/v1/metrics", "/stats"];
const METRICS_FETCH_TIMEOUT_MS = 3000;

const safeFg: ThemeFg = (_color, text) => text;

function isPrometheusFormat(text: string): boolean {
	const lines = text.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length < 3) return false;
	let promCount = 0;
	for (const line of lines) {
		const t = line.trim();
		if (t.startsWith("#")) {
			promCount++;
			continue;
		}
		if (/^[a-zA-Z_:][a-zA-Z0-9_:]*\s*[{\[]?/.test(t)) promCount++;
	}
	return promCount >= Math.floor(lines.length * 0.5);
}

function parsePrometheusMetrics(text: string): Map<string, number> {
	const metrics = new Map<string, number>();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const withLabels = trimmed.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\s*\{[^}]*\}\s+([\d.eE+-]+)/);
		if (withLabels) {
			const value = parseFloat(withLabels[2]);
			if (!isNaN(value)) metrics.set(withLabels[1], (metrics.get(withLabels[1]) ?? 0) + value);
			continue;
		}
		const parts = trimmed.split(/\s+/);
		if (parts.length >= 2) {
			const name = parts[0].replace(/^llamacpp:/, "");
			const value = parseFloat(parts[1]);
			if (!isNaN(value)) metrics.set(name, (metrics.get(name) ?? 0) + value);
		}
	}
	return metrics;
}

function parseJsonMetrics(data: unknown): Map<string, number> {
	const metrics = new Map<string, number>();
	function extract(obj: unknown, prefix = ""): void {
		if (typeof obj === "number") metrics.set(prefix, obj);
		else if (Array.isArray(obj)) obj.forEach((v, i) => extract(v, `${prefix}[${i}]`));
		else if (typeof obj === "object" && obj !== null) {
			for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
				extract(val, prefix ? `${prefix}.${key}` : key);
			}
		}
	}
	extract(data);
	return metrics;
}

function counterValue(m: Map<string, number>, names: string[]): number | undefined {
	for (const n of names) {
		const v = m.get(n);
		if (typeof v === "number") return v;
	}
	return undefined;
}

function buildMetricsLine(
	raw: Map<string, number>,
	deltaSec: number,
	prev: { raw: Map<string, number> } | undefined,
	fg: ThemeFg,
): string[] {
	const promptNow = counterValue(raw, ["prompt_tokens_total"]);
	const genNow = counterValue(raw, ["predicted_tokens_total", "tokens_predicted_total"]);
	let promptTps: number | undefined;
	let genTps: number | undefined;
	if (prev && deltaSec > 0) {
		const promptPrev = counterValue(prev.raw, ["prompt_tokens_total"]);
		const genPrev = counterValue(prev.raw, ["predicted_tokens_total", "tokens_predicted_total"]);
		if (promptNow !== undefined && promptPrev !== undefined && promptNow >= promptPrev && promptNow > promptPrev)
			promptTps = (promptNow - promptPrev) / deltaSec;
		if (genNow !== undefined && genPrev !== undefined && genNow >= genPrev && genNow > genPrev)
			genTps = (genNow - genPrev) / deltaSec;
	}
	if (promptTps === undefined) promptTps = raw.get("prompt_tokens_seconds");
	if (genTps === undefined) genTps = raw.get("predicted_tokens_seconds") ?? raw.get("tokens_predicted_seconds");

	const processing = raw.get("requests_processing") ?? counterValue(raw, ["num_requests_running"]) ?? 0;

	const parts: string[] = [fg("accent", "📊")];
	if (promptTps !== undefined && promptTps > 0) {
		const c = promptTps > 500 ? "success" : promptTps > 20 ? "warning" : "muted";
		parts.push(fg(c, `⚡ ${Math.round(promptTps)} t/s`));
	}
	if (genTps !== undefined && genTps > 0) {
		const c = genTps > 100 ? "success" : genTps > 10 ? "warning" : "muted";
		parts.push(fg(c, `🔥 ${Math.round(genTps)} t/s`));
	}
	if (processing > 0) parts.push(fg("success", `▶ ${processing}`));
	if (parts.length === 1) parts.push(fg("muted", "⏸ idle"));
	return [parts.join(" · ")];
}

export interface MetricsDeps {
	/** Whether the extension is still active (post-shutdown guard). */
	isActive: () => boolean;
	/** Whether the ctx has a UI (with stale-ctx safety). */
	hasUI: (ctx: ExtensionContext | undefined) => ctx is ExtensionContext;
	/** Current poll interval (ms) — read fresh from settings. */
	pollIntervalMs: () => number;
	/** Whether the metrics widget is enabled in settings. */
	enabled: () => boolean;
}

export function createMetrics(deps: MetricsDeps) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let widgetVisible = false;
	const endpoints = new Map<string, MetricsEndpointDiscovered>();
	const prev = new Map<string, { raw: Map<string, number>; ts: number }>();
	let currentKey: string | undefined;
	let currentBaseUrl: string | undefined;

	async function discoverMetricsEndpoint(baseUrl: string): Promise<MetricsEndpointDiscovered | undefined> {
		const rootUrl = baseUrl.replace(/\/v1\/?$/, "");
		for (const path of METRICS_CANDIDATE_PATHS) {
			const url = `${rootUrl}${path}`;
			try {
				const res = await httpGet(url, METRICS_FETCH_TIMEOUT_MS);
				if (res.status < 200 || res.status >= 300) continue;
				const isJson = (res.contentType ?? "").includes("json");
				const looksPrometheus = isPrometheusFormat(res.body);
				const format: "prometheus" | "json" = isJson ? "json" : looksPrometheus ? "prometheus" : "json";
				debugLog(`metrics endpoint discovered: ${url} (${format})`);
				return { url, format };
			} catch {
				continue;
			}
		}
		return undefined;
	}

	function renderWidget(lines: string[] | undefined, ctx: ExtensionContext) {
		if (!deps.hasUI(ctx)) return;
		if (lines === undefined) {
			if (widgetVisible) {
				ctx.ui.setWidget(METRICS_WIDGET_ID, undefined);
				widgetVisible = false;
			}
			return;
		}
		ctx.ui.setWidget(METRICS_WIDGET_ID, lines, { placement: "belowEditor" });
		widgetVisible = true;
	}

	async function poll(ctx: ExtensionContext): Promise<void> {
		if (!deps.isActive()) return;
		try {
			const model = ctx.model;
			if (!deps.enabled() || model?.provider !== PROVIDER_NAME) {
				renderWidget(undefined, ctx);
				currentKey = undefined;
				return;
			}

			const baseUrl = model.baseUrl ?? shared.modelBaseUrls.get(model.id);
			if (!baseUrl) {
				renderWidget(undefined, ctx);
				return;
			}
			const parsed = new URL(baseUrl);
			const key = `${parsed.hostname}:${parsed.port}`;
			if (key !== currentKey) {
				currentKey = key;
				currentBaseUrl = baseUrl;
				prev.clear();
			}

			let endpoint = endpoints.get(key);
			if (!endpoint) {
				endpoint = await discoverMetricsEndpoint(baseUrl);
				if (endpoint) endpoints.set(key, endpoint);
			}
			if (!endpoint) {
				renderWidget([safeFg("muted", "📊 no metrics endpoint")], ctx);
				return;
			}

			const res = await httpGet(endpoint.url, METRICS_FETCH_TIMEOUT_MS);
			if (res.status < 200 || res.status >= 300) {
				renderWidget([safeFg("muted", `📊 metrics HTTP ${res.status}`)], ctx);
				return;
			}
			let raw: Map<string, number>;
			if (endpoint.format === "prometheus") raw = parsePrometheusMetrics(res.body);
			else {
				try {
					raw = parseJsonMetrics(JSON.parse(res.body));
				} catch {
					renderWidget([safeFg("muted", "📊 metrics parse error")], ctx);
					return;
				}
			}

			const now = Date.now();
			const prevSnap = prev.get(key);
			const deltaSec = prevSnap ? (now - prevSnap.ts) / 1000 : 0;
			prev.set(key, { raw, ts: now });

			const fg = deps.hasUI(ctx) ? ((ctx.ui.theme?.fg)?.bind(ctx.ui.theme) ?? safeFg) : safeFg;
			renderWidget(buildMetricsLine(raw, deltaSec, prevSnap, fg), ctx);
		} catch (err) {
			if (!deps.isActive()) return;
			const msg = err instanceof Error ? err.message : String(err);
			debugLog(`metrics poll failed: ${msg}`);
			const fg = deps.hasUI(ctx) ? ((ctx.ui.theme?.fg)?.bind(ctx.ui.theme) ?? safeFg) : safeFg;
			renderWidget([fg("muted", "📊 ⏸ idle")], ctx);
		}
	}

	function start(ctx: ExtensionContext): void {
		if (!deps.isActive() || timer) return;
		void poll(ctx);
		timer = setInterval(() => {
			if (deps.isActive()) void poll(ctx);
		}, deps.pollIntervalMs());
		timer?.unref?.();
	}

	function stop(ctx?: ExtensionContext): void {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (ctx) renderWidget(undefined, ctx);
	}

	/** Reset state when the user switches to a different endpoint. */
	function resetForModelSwitch(): void {
		currentKey = undefined;
		prev.clear();
	}

	return { start, stop, resetForModelSwitch };
}