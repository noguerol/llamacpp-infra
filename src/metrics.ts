// Server-side metrics poller: fetches the active endpoint's /metrics (or
// JSON stats) every poll interval and reports a ServerMetricsState snapshot
// to the speed tracker (speed.ts), which owns the widget.
//
// The widget's live per-token speed comes from client-side stream
// measurement (speed.ts); this poller only supplements it with what the
// server reports — e.g. other clients busy on the endpoint while pi is
// idle. It degrades silently when the server has no --metrics endpoint.

import { debugLog, PROVIDER_NAME, shared } from "./core.ts";
import { httpGet } from "./scan.ts";
import type { ExtensionContext, MetricsEndpointDiscovered, ServerMetricsState } from "./types.ts";

const METRICS_CANDIDATE_PATHS = ["/metrics", "/v1/metrics", "/api/v1/metrics", "/stats"];
const METRICS_FETCH_TIMEOUT_MS = 3000;
/** Retry a failed discovery this long after it first failed. */
const DISCOVERY_FAIL_COOLDOWN_MS = 60_000;

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

/** Derive the ServerMetricsState snapshot from raw parsed metrics. */
function toServerState(
	raw: Map<string, number>,
	deltaSec: number,
	prev: { raw: Map<string, number> } | undefined,
): ServerMetricsState {
	const promptNow = counterValue(raw, ["prompt_tokens_total"]);
	const genNow = counterValue(raw, ["predicted_tokens_total", "tokens_predicted_total"]);
	let promptTps: number | undefined;
	let genTps: number | undefined;
	if (prev && deltaSec > 0) {
		const promptPrev = counterValue(prev.raw, ["prompt_tokens_total"]);
		const genPrev = counterValue(prev.raw, ["predicted_tokens_total", "tokens_predicted_total"]);
		if (promptNow !== undefined && promptPrev !== undefined && promptNow > promptPrev)
			promptTps = (promptNow - promptPrev) / deltaSec;
		if (genNow !== undefined && genPrev !== undefined && genNow > genPrev)
			genTps = (genNow - genPrev) / deltaSec;
	}
	// Fallback: server-provided average-rate gauges.
	if (promptTps === undefined) promptTps = raw.get("prompt_tokens_seconds");
	if (genTps === undefined) genTps = raw.get("predicted_tokens_seconds") ?? raw.get("tokens_predicted_seconds");
	const processing = Math.round(raw.get("requests_processing") ?? counterValue(raw, ["num_requests_running"]) ?? 0);
	return {
		processing,
		...(promptTps !== undefined && promptTps > 0 ? { promptTps } : {}),
		...(genTps !== undefined && genTps > 0 ? { genTps } : {}),
	};
}

export interface MetricsDeps {
	/** Whether the extension is still active (post-shutdown guard). */
	isActive: () => boolean;
	/** Current poll interval (ms) — read fresh from settings. */
	pollIntervalMs: () => number;
	/** Whether the metrics widget is enabled in settings. */
	enabled: () => boolean;
	/** Report a server snapshot (null when nothing to report). */
	onServerState: (ctx: ExtensionContext | undefined, st: ServerMetricsState | null) => void;
}

export function createMetrics(deps: MetricsDeps) {
	let timer: ReturnType<typeof setInterval> | undefined;
	const endpoints = new Map<string, MetricsEndpointDiscovered>();
	const discoveryFails = new Map<string, number>();
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

	async function poll(ctx: ExtensionContext | undefined): Promise<void> {
		if (!deps.isActive()) return;
		try {
			const model = ctx?.model;
			if (!deps.enabled() || model?.provider !== PROVIDER_NAME) {
				currentKey = undefined;
				deps.onServerState(ctx, null);
				return;
			}

			const baseUrl = model.baseUrl ?? shared.modelBaseUrls.get(model.id);
			if (!baseUrl) {
				currentKey = undefined;
				deps.onServerState(ctx, null);
				return;
			}
			const parsed = new URL(baseUrl);
			const key = `${parsed.hostname}:${parsed.port}`;
			if (key !== currentKey) {
				currentKey = key;
				currentBaseUrl = baseUrl;
				prev.delete(key);
			}

			let endpoint = endpoints.get(key);
			if (!endpoint) {
				const failedAt = discoveryFails.get(key);
				if (failedAt !== undefined && Date.now() - failedAt < DISCOVERY_FAIL_COOLDOWN_MS) return;
				endpoint = await discoverMetricsEndpoint(baseUrl);
				if (endpoint) {
					endpoints.set(key, endpoint);
					discoveryFails.delete(key);
				} else {
					discoveryFails.set(key, Date.now());
					debugLog(`no metrics endpoint for ${key}; retrying in ${DISCOVERY_FAIL_COOLDOWN_MS}ms`);
				}
			}
			if (!endpoint) {
				deps.onServerState(ctx, null);
				return;
			}

			const res = await httpGet(endpoint.url, METRICS_FETCH_TIMEOUT_MS);
			if (res.status < 200 || res.status >= 300) {
				debugLog(`metrics HTTP ${res.status} from ${endpoint.url}`);
				deps.onServerState(ctx, null);
				return;
			}
			let raw: Map<string, number>;
			if (endpoint.format === "prometheus") raw = parsePrometheusMetrics(res.body);
			else {
				try {
					raw = parseJsonMetrics(JSON.parse(res.body));
				} catch {
					deps.onServerState(ctx, null);
					return;
				}
			}

			const now = Date.now();
			const prevSnap = prev.get(key);
			const deltaSec = prevSnap ? (now - prevSnap.ts) / 1000 : 0;
			prev.set(key, { raw, ts: now });

			deps.onServerState(ctx, toServerState(raw, deltaSec, prevSnap));
		} catch (err) {
			if (!deps.isActive()) return;
			const msg = err instanceof Error ? err.message : String(err);
			debugLog(`metrics poll failed: ${msg}`);
			deps.onServerState(ctx, null);
		}
	}

	function start(ctx: ExtensionContext | undefined): void {
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
		currentKey = undefined;
		deps.onServerState(ctx, null);
	}

	/** Reset state when the user switches to a different endpoint. */
	function resetForModelSwitch(): void {
		currentKey = undefined;
		prev.clear();
	}

	return { start, stop, resetForModelSwitch };
}
