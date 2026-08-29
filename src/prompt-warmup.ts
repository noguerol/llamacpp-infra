// Header warmup: pre-cache the system prompt KV on llama.cpp-family servers
// so the first real request hits the cache (TTFT ~40s → ~0.3s on big headers).
// Templates are captured from the real payload (byte-identical) and persisted
// in ~/.pi/agent/warmup-<provider>.json. Everything is fire-and-forget;
// failures are silent. Env vars: PI_WARMUP=0, PI_WARMUP_FALLBACK=0,
// PI_WARMUP_TIMEOUT_MS, PI_WARMUP_COOLDOWN_MS, PI_WARMUP_DEBUG=1.

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { URL } from "node:url";

const KIND_LLAMACPP = "llamacpp";
const KIND_LUCEBOX = "lucebox";
const KIND_DS4 = "ds4";
const KIND_ZINC = "zinc";
const KIND_LMSTUDIO = "lmstudio";

const SAVE_DEBOUNCE_MS = 5_000;
const MAX_TEMPLATES = 30;
const MAX_AGE_MS = 14 * 24 * 3600 * 1000;
const PLACEHOLDER_USER = "hi";

function envBool(name: string, def: boolean): boolean {
	const v = process.env[name];
	if (v === undefined) return def;
	return v === "1" || v.toLowerCase() === "true";
}

function envInt(name: string, def: number): number {
	const v = process.env[name];
	if (v === undefined) return def;
	const n = parseInt(v, 10);
	return isNaN(n) || n <= 0 ? def : n;
}

const GLOBAL_ENABLED = envBool("PI_WARMUP", true);
const FALLBACK_ENABLED = envBool("PI_WARMUP_FALLBACK", true);
const WARMUP_TIMEOUT_MS = envInt("PI_WARMUP_TIMEOUT_MS", 180_000);
const COOLDOWN_MS = envInt("PI_WARMUP_COOLDOWN_MS", 15_000);
const DEBUG_LOG_ENABLED = envBool("PI_WARMUP_DEBUG", false);

function warmupEnabledFor(kind: string | undefined): boolean {
	return kind !== KIND_ZINC;
}

function cachePromptSupported(kind: string | undefined): boolean {
	return kind !== KIND_ZINC && kind !== KIND_LMSTUDIO;
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
	if (!baseUrl) return "";
	return baseUrl.replace(/\/+$/, "");
}

interface WarmMessage {
	role: string;
	content: unknown;
}

interface WarmTemplate {
	model: string;
	baseUrl: string;
	cwd: string;
	systemMessages: WarmMessage[];
	tools?: unknown[];
	kind: string;
	capturedAt: number;
}

interface WarmupBody {
	model: string;
	messages: WarmMessage[];
	tools?: unknown[];
	max_tokens: number;
	temperature: number;
	stream: boolean;
	cache_prompt?: boolean;
}

interface WarmupResult {
	status: number;
	body: string;
}

export type WarmupEvent =
	| { type: "start"; model: string }
	| { type: "done"; model: string; ms: number; tokens?: number }
	| { type: "abort"; model: string; ms: number }
	| { type: "error"; model: string; ms: number; error: string };

/** Footer status indicator for warmup progress (☕ start / ☕ Xs ✓ done / ☕ ⚠ err). */
export class WarmupStatus {
	private ui: { setStatus: (key: string, text: string | undefined) => void } | undefined;
	private key: string;
	private doneClearMs: number;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(key = "warmup", doneClearMs = 3000) {
		this.key = key;
		this.doneClearMs = doneClearMs;
	}

	bind(ui: { setStatus: (key: string, text: string | undefined) => void }): void {
		this.ui = ui;
	}

	private clearSoon(ms: number): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.ui?.setStatus(this.key, undefined);
		}, ms);
		this.timer.unref?.();
	}

	private clearNow(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.ui?.setStatus(this.key, undefined);
	}

	handle(ev: WarmupEvent): void {
		if (!this.ui) return;
		switch (ev.type) {
			case "start":
				this.clearNow();
				this.ui.setStatus(this.key, "☕");
				break;
			case "done": {
				const secs = (ev.ms / 1000).toFixed(1);
				this.ui.setStatus(this.key, `☕ ${secs}s ✓`);
				this.clearSoon(this.doneClearMs);
				break;
			}
			case "abort":
				this.clearNow();
				break;
			case "error":
				this.ui.setStatus(this.key, "☕ ⚠");
				this.clearSoon(this.doneClearMs);
				break;
		}
	}

	dispose(): void {
		this.clearNow();
		this.ui = undefined;
	}
}

export interface PromptWarmerOptions {
	provider: string;
	cacheFile?: string;
	kindFor?: (baseUrl: string) => string | undefined;
	requestModelFor?: (modelId: string) => string;
	onEvent?: (ev: WarmupEvent) => void;
	log?: (msg: string) => void;
}

// HTTP: IPv4 only (Tailscale LAN names resolve IPv6-first with unroutable
// link-local), Connection: close (pasta/podman keep-alive quirks), AbortSignal
// for the first real request aborting the in-flight warmup.
function warmupRequest(
	baseUrl: string,
	body: WarmupBody,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<WarmupResult> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const url = new URL(normalizeBaseUrl(baseUrl) + "/chat/completions");
		const options: http.RequestOptions = {
			hostname: url.hostname,
			port: url.port || (url.protocol === "https:" ? 443 : 80),
			path: url.pathname + url.search,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				"User-Agent": "pi-warmup/1.0",
				Connection: "close",
			},
			timeout: timeoutMs,
			family: 4,
			agent: false,
		};

		const req = http.request(options, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => {
				if (settled) return;
				settled = true;
				resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") });
			});
			res.on("error", (e) => {
				if (settled) return;
				settled = true;
				reject(e);
			});
		});

		req.on("error", (e) => {
			if (settled) return;
			settled = true;
			reject(e);
		});

		req.on("timeout", () => {
			if (settled) return;
			settled = true;
			req.destroy();
			const err: NodeJS.ErrnoException = new Error(`Warmup timeout after ${timeoutMs}ms`);
			err.code = "WARMUP_TIMEOUT";
			reject(err);
		});

		const onAbort = () => {
			if (settled) return;
			settled = true;
			req.destroy();
			const err: NodeJS.ErrnoException = new Error("Warmup aborted (primer mensaje del usuario)");
			err.code = "ABORT_ERR";
			reject(err);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		req.on("close", () => signal.removeEventListener("abort", onAbort));

		req.write(JSON.stringify(body));
		req.end();
	});
}

function parsePromptTokens(body: string): number | undefined {
	try {
		const usage = (JSON.parse(body) as { usage?: { prompt_tokens?: number } })?.usage;
		if (typeof usage?.prompt_tokens === "number") return usage.prompt_tokens;
	} catch {
		// ignorar
	}
	return undefined;
}

export class PromptWarmer {
	readonly provider: string;
	private cacheFile: string;
	private kindFor: (baseUrl: string) => string | undefined;
	private requestModelFor: (modelId: string) => string;
	private onEvent?: (ev: WarmupEvent) => void;
	private log: (msg: string) => void;

	private templates = new Map<string, WarmTemplate>();
	private inFlight = new Map<string, AbortController>();
	private lastWarmed = new Map<string, number>();
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private enabled: boolean;

	constructor(opts: PromptWarmerOptions) {
		this.provider = opts.provider;
		this.cacheFile = opts.cacheFile ?? path.join(homedir(), ".pi", "agent", `warmup-${opts.provider}.json`);
		this.kindFor = opts.kindFor ?? (() => KIND_LLAMACPP);
		this.requestModelFor = opts.requestModelFor ?? ((id: string) => id);
		this.onEvent = opts.onEvent;
		// Silent by default: stderr writes corrupt pi's TUI render. Only log
		// with PI_WARMUP_DEBUG=1 or if the caller passes an explicit logger.
		this.log = opts.log ?? (DEBUG_LOG_ENABLED ? (msg: string) => console.debug(msg) : () => {});
		this.enabled = GLOBAL_ENABLED && envBool(`PI_WARMUP_${opts.provider.toUpperCase()}`, true);
		this.load();
	}

	private key(modelId: string, baseUrl: string, cwd: string): string {
		return `${baseUrl}|${modelId}|${cwd}`;
	}

	private kind(baseUrl: string): string | undefined {
		try {
			return this.kindFor(baseUrl);
		} catch {
			return undefined;
		}
	}

	private resolveRequestModel(modelId: string): string {
		try {
			return this.requestModelFor(modelId) || modelId;
		} catch {
			return modelId;
		}
	}

	/** Fire-and-forget warmup for the active model in session_start / model_select. */
	warmupForModel(
		model: { id: string; provider?: string; baseUrl?: string } | undefined,
		systemPrompt?: string,
		cwd?: string,
	): void {
		if (!this.enabled || this.disposed) return;
		if (!model || !model.id || model.provider !== this.provider) return;
		const baseUrl = normalizeBaseUrl(model.baseUrl);
		if (!baseUrl) return;
		if (!warmupEnabledFor(this.kind(baseUrl))) return;

		const key = this.key(model.id, baseUrl, cwd ?? "");
		const now = Date.now();
		const last = this.lastWarmed.get(key);
		if (last !== undefined && now - last < COOLDOWN_MS) return;
		if (this.inFlight.has(model.id)) return;

		const tpl = this.templates.get(key);
		let body: WarmupBody;
		if (tpl) {
			body = {
				model: this.resolveRequestModel(tpl.model),
				messages: [...tpl.systemMessages, { role: "user", content: PLACEHOLDER_USER }],
				max_tokens: 1,
				temperature: 0,
				stream: false,
			};
			if (tpl.tools && tpl.tools.length > 0) body.tools = tpl.tools;
			if (cachePromptSupported(tpl.kind)) body.cache_prompt = true;
		} else if (systemPrompt && FALLBACK_ENABLED) {
			body = {
				model: this.resolveRequestModel(model.id),
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: PLACEHOLDER_USER },
				],
				max_tokens: 1,
				temperature: 0,
				stream: false,
			};
			if (cachePromptSupported(this.kind(baseUrl))) body.cache_prompt = true;
		} else {
			return;
		}

		this.fire(model.id, key, baseUrl, body);
	}

	private fire(modelId: string, key: string, baseUrl: string, body: WarmupBody): void {
		const ac = new AbortController();
		this.inFlight.set(modelId, ac);
		const t0 = Date.now();
		this.onEvent?.({ type: "start", model: modelId });
		this.log(`[warmup:${this.provider}] ${modelId} → ${normalizeBaseUrl(baseUrl)}/chat/completions`);

		warmupRequest(baseUrl, body, WARMUP_TIMEOUT_MS, ac.signal)
			.then((res) => {
				if (this.disposed) return;
				this.inFlight.delete(modelId);
				this.lastWarmed.set(key, Date.now());
				if (res.status >= 200 && res.status < 300) {
					const tokens = parsePromptTokens(res.body);
					const ms = Date.now() - t0;
					this.onEvent?.({ type: "done", model: modelId, ms, tokens });
					this.log(
						`[warmup:${this.provider}] ${modelId}: prefill ${tokens ?? "?"} tok en ${(ms / 1000).toFixed(1)}s ✓`,
					);
				} else {
					this.onEvent?.({ type: "error", model: modelId, ms: Date.now() - t0, error: `HTTP ${res.status}` });
					this.log(`[warmup:${this.provider}] ${modelId}: HTTP ${res.status} (${res.body.slice(0, 120)})`);
				}
			})
			.catch((err) => {
				if (this.disposed) return;
				this.inFlight.delete(modelId);
				const ms = Date.now() - t0;
				const code = (err as NodeJS.ErrnoException)?.code;
				if (code === "ABORT_ERR") {
					this.onEvent?.({ type: "abort", model: modelId, ms });
					this.log(`[warmup:${this.provider}] ${modelId}: abortado tras ${(ms / 1000).toFixed(1)}s`);
				} else {
					const msg = err instanceof Error ? err.message : String(err);
					this.onEvent?.({ type: "error", model: modelId, ms, error: msg });
					this.log(`[warmup:${this.provider}] ${modelId}: ${msg}`);
				}
			});
	}

	/** Abort any in-flight warmup for a model before its real request goes out. */
	abortForModel(modelId: string): void {
		const ac = this.inFlight.get(modelId);
		if (ac) ac.abort();
	}

	/**
	 * Called in before_provider_request with the final payload (after other
	 * extensions' hooks). Aborts the in-flight warmup and captures the real
	 * header (system + tools) for future conversations.
	 */
	onProviderPayload(payload: unknown, baseUrl?: string, cwd?: string): void {
		if (!this.enabled || this.disposed) return;
		const p = payload as Record<string, unknown> | undefined;
		if (!p || typeof p !== "object") return;
		const modelId = typeof p.model === "string" ? p.model : undefined;
		if (modelId) this.abortForModel(modelId);
		if (!modelId || !baseUrl || !Array.isArray(p.messages)) return;
		if (!warmupEnabledFor(this.kind(baseUrl))) return;

		const msgs = p.messages as WarmMessage[];
		const first = msgs[0];
		if (!first || (first.role !== "system" && first.role !== "developer")) return;

		const key = this.key(modelId, normalizeBaseUrl(baseUrl), cwd ?? "");
		const tools = Array.isArray(p.tools) ? (p.tools as unknown[]) : undefined;

		// Don't degrade a template with tools using one without tools.
		const existing = this.templates.get(key);
		if (existing && existing.tools && existing.tools.length > 0 && (!tools || tools.length === 0)) {
			return;
		}

		this.templates.set(key, {
			model: modelId,
			baseUrl: normalizeBaseUrl(baseUrl),
			cwd: cwd ?? "",
			systemMessages: msgs.filter((m) => m.role === "system" || m.role === "developer"),
			tools,
			kind: this.kind(baseUrl) ?? KIND_LLAMACPP,
			capturedAt: Date.now(),
		});
		this.scheduleSave();
	}

	private load(): void {
		try {
			if (!fs.existsSync(this.cacheFile)) return;
			const raw = JSON.parse(fs.readFileSync(this.cacheFile, "utf-8")) as {
				templates?: WarmTemplate[];
			};
			const now = Date.now();
			for (const t of raw.templates ?? []) {
				if (!t || typeof t !== "object" || typeof t.model !== "string" || typeof t.baseUrl !== "string") continue;
				if (now - (t.capturedAt ?? 0) > MAX_AGE_MS) continue;
				if (!Array.isArray(t.systemMessages) || t.systemMessages.length === 0) continue;
				this.templates.set(this.key(t.model, t.baseUrl, t.cwd ?? ""), {
					...t,
					kind: t.kind ?? KIND_LLAMACPP,
				});
			}
		} catch {
			// Fichero corrupto → empezar de cero
		}
	}

	private scheduleSave(): void {
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			this.save();
		}, SAVE_DEBOUNCE_MS);
		this.saveTimer.unref?.();
	}

	private save(): void {
		try {
			const arr = [...this.templates.values()]
				.sort((a, b) => a.capturedAt - b.capturedAt)
				.slice(-MAX_TEMPLATES);
			fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
			fs.writeFileSync(
				this.cacheFile,
				JSON.stringify({ version: 1, provider: this.provider, templates: arr }),
				"utf-8",
			);
		} catch {
			// Sin permisos / disco lleno → el warmup sigue funcionando en memoria
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.saveTimer) clearTimeout(this.saveTimer);
		for (const ac of this.inFlight.values()) ac.abort();
		this.inFlight.clear();
		this.save();
	}
}