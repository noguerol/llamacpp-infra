/**
 * prompt-warmup — system-prompt header pre-cache for local llama.cpp servers
 * ==========================================================================
 *
 * Internal module of the llamacpp-infra extension (previously the shared
 * pi_extensions/lib/prompt-warmup.ts — inlined here since llamacpp-infra is
 * its only consumer).
 *
 * The pi system prompt (identity, tools, skills, context files, docs paths)
 * is a very large header (5k-25k tokens). On locally served models that
 * prefill dominates time-to-first-token.
 *
 * llama.cpp-family servers (and forks: lucebox, ds4/DwarfStar, ZINC) keep the
 * prompt KV cached in the slot between requests: if an incoming request
 * shares a prefix with the previous one, the KV is reused and only the new
 * tokens are evaluated. This module exploits that: when a new conversation
 * starts (pi boot, /new, /fork, /resume or model switch) it sends the server
 * a "warmup" request carrying the SAME header (system + tools captured from
 * pi's real payload) with max_tokens=1, leaving the KV cached in the slot.
 * The user's first real message then hits the cache: TTFT ~40s → ~0.3s.
 *
 * Key design point: the header is CAPTURED from the real payload in
 * `before_provider_request` (not from ctx.getSystemPrompt()) because other
 * extensions may transform it earlier. Reproducing the exact bytes of the
 * payload guarantees an identical prefix.
 *
 * Templates persist in ~/.pi/agent/warmup-llamacpp-infra.json so the warmup
 * survives pi restarts.
 *
 * Safety semantics:
 * - Never blocks: everything is fire-and-forget, with AbortController.
 * - The user's first real request aborts any in-flight warmup for that model.
 * - Failures are silent (server down, timeout, 503): debug log only.
 * - No user messages are stored: only the header (system + tools).
 *
 * Configuration (env):
 *   PI_WARMUP=0                     globally disable warmup
 *   PI_WARMUP_LLAMACPP_INFRA=0      disable for this provider
 *   PI_WARMUP_FALLBACK=0            disable the ctx.getSystemPrompt() fallback
 *   PI_WARMUP_TIMEOUT_MS=180000     timeout per warmup request
 *   PI_WARMUP_COOLDOWN_MS=15000     cooldown between warmups of the same model
 *   PI_WARMUP_DEBUG=1               debug logging (console.debug → stderr)
 *
 * UI: silent by default. The llamacpp-infra extension passes its own key
 * ("warmup-llamacpp-infra") to WarmupStatus for the ☕ footer indicator.
 */


import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { URL } from "node:url";

// =============================================================================
// Constantes / env
// =============================================================================

const KIND_LLAMACPP = "llamacpp";
const KIND_LUCEBOX = "lucebox";
const KIND_DS4 = "ds4";
const KIND_ZINC = "zinc";
const KIND_LMSTUDIO = "lmstudio";

const SAVE_DEBOUNCE_MS = 5_000;
const MAX_TEMPLATES = 30;
const MAX_AGE_MS = 14 * 24 * 3600 * 1000; // 14 días
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
/** Log de depuración: solo con PI_WARMUP_DEBUG=1. Las escrituras a stderr en
 * TUI se intercalan con el render de pi y ensucian el editor / input box. */
const DEBUG_LOG_ENABLED = envBool("PI_WARMUP_DEBUG", false);

/**
 * ¿El servidor mantiene KV cache del prompt entre requests?
 * - llama.cpp y forks (lucebox, ds4): sí (cache_prompt on por defecto).
 * - LM Studio: sí, cache automática (backend llama.cpp) sin campo extra.
 * - ZINC: server propio sin prefix-cache verificado → se descarta entero.
 */
function warmupEnabledFor(kind: string | undefined): boolean {
	return kind !== KIND_ZINC;
}

/** ¿Se manda el campo `cache_prompt` (extensión llama.cpp)? ZINC/LM Studio no lo necesitan. */
function cachePromptSupported(kind: string | undefined): boolean {
	return kind !== KIND_ZINC && kind !== KIND_LMSTUDIO;
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
	if (!baseUrl) return "";
	return baseUrl.replace(/\/+$/, "");
}

// =============================================================================
// Tipos
// =============================================================================

interface WarmMessage {
	role: string;
	content: unknown;
}

interface WarmTemplate {
	model: string;
	baseUrl: string;
	cwd: string;
	systemMessages: WarmMessage[];
	tools?: unknown[] | undefined;
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

/**
 * Indicador visual del warmup en el footer de pi (ctx.ui.setStatus).
 *
 * Indicador compacto y sin trazas en stderr:
 *   start  →  "☕"             (mientras se precarga la cabecera)
 *   done   →  "☕ 30.2s ✓"     (duración del prefill; se borra tras ~3s)
 *   error  →  "☕ ⚠"           (id.)
 *   abort  →  clear inmediato
 *
 * El log verbose por stderr (PI_WARMUP_DEBUG=1) se ha desactivado por defecto
 * porque las escrituras a stderr en TUI se intercalan con el render de pi y
 * ensucian el editor / caja de input.
 *
 * Pasar siempre una `key` por provider (p.ej. "warmup-llamacpp-infra" / "warmup-lmstudio")
 * para que dos providers activos a la vez no se pisen la misma ranura del footer.
 *
 *   const warmupStatus = new WarmupStatus("warmup-llamacpp-infra");
 *   const warmer = new PromptWarmer({ ..., onEvent: (ev) => warmupStatus.handle(ev) });
 *   // en session_start / model_select:
 *   if (ctx.hasUI) warmupStatus.bind(ctx.ui);
 *   // en session_shutdown:
 *   warmupStatus.dispose();
 */
export class WarmupStatus {
	private ui: { setStatus: (key: string, text: string | undefined) => void } | undefined;
	private key: string;
	private doneClearMs: number;
	private timer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * @param key        Clave de la ranura del footer (cada provider usa la suya
	 *                   para no chocar con otros warmups activos simultáneos).
	 * @param doneClearMs Tiempo que permanece el indicador "✓" / "⚠" tras terminar
	 *                   el warmup antes de borrarse (ms).
	 */
	constructor(key = "warmup", doneClearMs = 3000) {
		this.key = key;
		this.doneClearMs = doneClearMs;
	}

	/** Vincula la UI (ctx.ui de un handler con hasUI). Idempotente. */
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
				// Compacto: solo el icono. El usuario ve que algo se está precargando
				// sin que el texto ocupe media línea del footer.
				this.ui.setStatus(this.key, "☕");
				break;
			case "done": {
				// Mostramos la duración del prefill (dato útil y corto).
				// Sin token count interno: es ruido para el usuario.
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
	/** Nombre del provider registrado (llamacpp-infra / lmstudio). */
	provider: string;
	/** Ruta del fichero de plantillas persistido. */
	cacheFile?: string;
	/** Devuelve el tipo de servidor ("llamacpp"|"lucebox"|"ds4"|"zinc"|"lmstudio") para una baseUrl. */
	kindFor?: (baseUrl: string) => string | undefined;
	/** Mapea el id registrado (compacto) al id crudo que espera el servidor. */
	requestModelFor?: (modelId: string) => string;
	/** Callback opcional para eventos de warmup (estado en footer, notify, ...). */
	onEvent?: (ev: WarmupEvent) => void;
	/** Log opcional. Por defecto silencioso (no-op); activa con PI_WARMUP_DEBUG=1. */
	log?: (msg: string) => void;
}

// =============================================================================
// HTTP mínimo (mismo patrón hardened que los providers locales)
// =============================================================================
// - family: 4 → evita la resolución IPv6-first de hostnames tailnet/LAN
// - Connection: close + agent:false → sin keep-alive (pasta/podman cierra sockets)
// - timeout largo (el prefill de 20k tokens tarda decenas de segundos)
// - AbortSignal → el primer request real aborta el warmup en vuelo

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

// =============================================================================
// PromptWarmer
// =============================================================================

export class PromptWarmer {
	readonly provider: string;
	private cacheFile: string;
	private kindFor: (baseUrl: string) => string | undefined;
	private requestModelFor: (modelId: string) => string;
	private onEvent?: (ev: WarmupEvent) => void;
	private log: (msg: string) => void;

	private templates = new Map<string, WarmTemplate>();
	/** warmups en vuelo, key = modelId (abort rápido por modelo). */
	private inFlight = new Map<string, AbortController>();
	/** último warmup completado por key completa (baseUrl|model|cwd), para cooldown. */
	private lastWarmed = new Map<string, number>();
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private enabled: boolean;

	constructor(opts: PromptWarmerOptions) {
		this.provider = opts.provider;
		this.cacheFile =
			opts.cacheFile ?? path.join(homedir(), ".pi", "agent", `warmup-${opts.provider}.json`);
		this.kindFor = opts.kindFor ?? (() => KIND_LLAMACPP);
		this.requestModelFor = opts.requestModelFor ?? ((id: string) => id);
		this.onEvent = opts.onEvent;
		// Por defecto silencioso: escribir por stderr corrompe el render de la TUI
		// de pi (trazas sucias en el editor / input box). Solo se loguea con
		// PI_WARMUP_DEBUG=1 o si el caller pasa un logger explícito.
		this.log =
			opts.log ??
			(DEBUG_LOG_ENABLED ? (msg: string) => console.debug(msg) : () => {});
		this.enabled =
			GLOBAL_ENABLED && envBool(`PI_WARMUP_${opts.provider.toUpperCase()}`, true);
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

	/** Id crudo que espera el servidor para un id registrado (con fallback). */
	private resolveRequestModel(modelId: string): string {
		try {
			return this.requestModelFor(modelId) || modelId;
		} catch {
			return modelId;
		}
	}

	// ── Warmup ────────────────────────────────────────────────────────────────

	/**
	 * Llamar en session_start y model_select. Dispara (fire-and-forget) un
	 * prefill de la cabecera para el modelo actual si es de este provider.
	 * Usa la plantilla capturada (system+tools byte-idénticos) si existe;
	 * si no, fallback con ctx.getSystemPrompt() (prefijo parcial: pi-compact
	 * puede compactar skills después, pero el grueso de la cabecera coincide).
	 */
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
					this.log(`[warmup:${this.provider}] ${modelId}: abortado (request real) tras ${(ms / 1000).toFixed(1)}s`);
				} else {
					const msg = err instanceof Error ? err.message : String(err);
					this.onEvent?.({ type: "error", model: modelId, ms, error: msg });
					this.log(`[warmup:${this.provider}] ${modelId}: ${msg}`);
				}
			});
	}

	/** Aborta cualquier warmup en vuelo para un modelo (antes del request real). */
	abortForModel(modelId: string): void {
		const ac = this.inFlight.get(modelId);
		if (ac) ac.abort();
	}

	// ── Captura del payload real ──────────────────────────────────────────────

	/**
	 * Llamar en before_provider_request con el payload final (tras los hooks de
	 * otras extensiones) + la baseUrl del modelo. Aborta el warmup en vuelo y
	 * captura la cabecera real (system + tools) para futuras conversaciones.
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

		// No degradar una plantilla con tools por una captura sin tools.
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

	// ── Persistencia ──────────────────────────────────────────────────────────

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
