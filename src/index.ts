/**
 * extension: llamacpp-infra
 * =========================
 * Discovery, metrics and control of models served by llama.cpp and its
 * variants (ZINC, DwarfStar/ds4, lucebox, LM Studio) on any number of
 * machines — localhost, LAN or Tailscale.
 *
 * SCOPE
 * -----
 * This extension is exclusively for models served by llama.cpp-family
 * servers. Every machine and port it talks to runs llama.cpp or a direct
 * variant:
 *
 *   llama.cpp   — llama-server (single-model or router/multi-model mode)
 *   ZINC        — llama.cpp-compatible runtime (owned_by: "zinc")
 *   DwarfStar   — antirez's ds4-server for DeepSeek V4 (chat ping probe)
 *   lucebox     — DeepSeek dflash server (rich /props metadata)
 *   LM Studio   — local OpenAI-compatible server backed by llama.cpp
 *
 * Anything else (vLLM, Ollama, cloud APIs…) is out of scope.
 *
 * FEATURES
 * --------
 * 1. Discovery: probes every configured server:port via GET /v1/models and
 *    registers everything it finds into pi's native /model list.
 * 2. Single- and multi-model (router) llama.cpp modes:
 *    - single-model: one GGUF per instance, enriched via GET /props
 *      (model_path → quant, modalities.vision, total_slots, draft).
 *    - router mode: /v1/models lists several models with per-model `path`,
 *      `status` (loaded/unloaded + the exact llama-server args) and
 *      `architecture.input_modalities`. Unloaded models can optionally be
 *      listed (they are excluded by default).
 * 3. Per-model metadata, shown in /llamacpp-infra list|status and as badges:
 *      👁️ vision (mmproj / modalities.vision / input_modalities)
 *      🚀 drafter (speculative decoding draft model)
 *      🗜️ model quant (from the GGUF filename, e.g. UD-Q3_K_XL)
 *      🧠 KV cache quantization (--cache-type-k/-v, from server args or
 *         /proc for local servers)
 * 4. Live metrics (integrated model-metrics): polls the active endpoint's
 *    Prometheus /metrics (or JSON /stats) and renders a compact widget with
 *    instantaneous prompt/gen throughput. Auto-activates for llamacpp-infra
 *    models only.
 * 5. Per-model thinking budgets: llama.cpp accepts `thinking_budget_tokens`
 *    per request. Configure budgets per thinking level (minimal/low/medium/
 *    high) per model in the config menu; models with budgets are registered
 *    with reasoning enabled and pi sends the configured budget automatically.
 * 6. Native configuration UI via /llamacpp-infra config (all in-pi dialogs).
 * 7. Header warmup (pre-cache system prompt KV on llama.cpp-family servers).
 * 8. ZINC workaround: ZINC rejects non-empty model ids; the payload hook
 *    rewrites the request accordingly and normalizes tool definitions.
 * 9. LM Studio support: discovers `/v1/models`, enriches metadata from
 *    `/api/v1/models` or legacy `/api/v0/models`, and avoids llama.cpp-only
 *    request fields such as `cache_prompt` / `thinking_budget_tokens`.
 * 10. Compact model ids: models are registered as "Name (host:port)" — the
 *    raw server-side model id (GGUF path / alias) is restored automatically
 *    in before_provider_request before the request leaves pi.
 *
 * HISTORY
 * -------
 * Supersedes the earlier local-models extension.
 *
 * COMMANDS
 * --------
 *   /llamacpp-infra            quick status
 *   /llamacpp-infra config     ⚙️ interactive configuration menu
 *   /llamacpp-infra scan       rescan all servers now
 *   /llamacpp-infra status     detailed per-endpoint report
 *   /llamacpp-infra list       list discovered models with metadata
 *   /llamacpp-infra metrics    toggle the live metrics widget
 *   /llamacpp-infra help       command help
 *
 * Config: ~/.pi/agent/llamacpp-infra.json (auto-migrated from
 * local-models.json on first run).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PromptWarmer, WarmupStatus } from "./prompt-warmup";
import * as http from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// =============================================================================
// Types
// =============================================================================

/** One machine that may serve llama.cpp-family models on one or more ports. */
interface ServerConfig {
	/** Unique short id (used in logs and endpoint bookkeeping). */
	id: string;
	/** Hostname, tailnet name or IP (e.g. "127.0.0.1", "myserver", "192.168.1.10"). */
	host: string;
	/** Optional friendly label shown in menus (defaults to host). */
	label?: string;
	/** Ports to probe on this machine. */
	ports: number[];
	/** Enabled servers are probed at startup. */
	enabled: boolean;
	/** Opt-in: when /v1/models fails, ping /v1/chat/completions (DwarfStar/ds4). */
	probeDs4?: boolean;
	/** Optional bearer token sent on discovery + per-model Authorization header. */
	apiKey?: string;
}

/** Thinking budget (tokens) per pi thinking level, llama.cpp-style. */
interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

/** Per-model options keyed by the registered model id. */
interface ModelOptions {
	/** llama.cpp `thinking_budget_tokens` per thinking level. */
	thinkingBudgets?: ThinkingBudgets;
}

interface SettingsConfig {
	/** Per-request timeout during discovery (ms). */
	discoveryTimeoutMs: number;
	/** Background re-poll interval while servers are loading (ms). */
	pollIntervalMs: number;
	/** Total background polling budget (ms). */
	pollMaxMs: number;
	/** Keep polling at startup while nothing has ever answered (ms). */
	startupGraceMs: number;
	/** Consecutive failures before a known-good endpoint is dropped from polling. */
	knownGoodFailLimit: number;
	/** Scan /proc for local llama-server flags (mmproj, cache quants, draft). */
	detectVision: boolean;
	/** Prefix model ids with "host:port/" to avoid cross-server collisions. */
	prefixModelIds: boolean;
	/** Pre-cache the system prompt header on llama.cpp-family servers. */
	warmup: boolean;
	/** Show the live metrics widget for llamacpp-infra models. */
	metricsEnabled: boolean;
	/** Metrics polling interval (ms). */
	metricsPollMs: number;
	/** Router mode: also register models that are not currently loaded. */
	includeUnloadedRouterModels: boolean;
	/** Append metadata badges (👁️🚀💤) to model display names. */
	showBadgesInNames: boolean;
}

interface InfraConfig {
	servers: ServerConfig[];
	settings: SettingsConfig;
	/** Per-model options keyed by registered model id. */
	modelOptions: Record<string, ModelOptions>;
}

interface LlamaCppMeta {
	n_ctx?: number;
	n_ctx_train?: number;
}

interface LmStudioModelInfo {
	/** v1 REST API unique key; v0 uses `id` instead. */
	key?: string;
	id?: string;
	display_name?: string;
	/** v1: "llm" | "embedding"; v0: "llm" | "vlm" | "embeddings". */
	type?: string;
	publisher?: string;
	architecture?: string | null;
	arch?: string | null;
	format?: string | null;
	compatibility_type?: string | null;
	quantization?: string | { name?: string | null; bits_per_weight?: number | null } | null;
	state?: string;
	max_context_length?: number;
	loaded_instances?: Array<{ id?: string; config?: { context_length?: number; parallel?: number } }>;
	capabilities?: {
		vision?: boolean;
		trained_for_tool_use?: boolean;
		reasoning?: boolean | { allowed_options?: string[]; default?: string };
	};
	selected_variant?: string;
	variants?: string[];
}

interface LmStudioModelsResponse {
	models?: LmStudioModelInfo[];
	data?: LmStudioModelInfo[];
	object?: string;
}

interface LlamaCppModel {
	id: string;
	name?: string;
	object?: string;
	owned_by?: string;
	display_name?: string;
	/** Router mode: path to the GGUF file. */
	path?: string;
	/** Router mode: load status of this model. */
	status?: {
		value?: string;
		args?: string[];
		preset?: string;
		failed?: boolean;
		exit_code?: number;
	};
	/** Router mode: modalities reported per model. */
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
	/** LM Studio REST metadata, when the local server exposes it. */
	lmStudio?: LmStudioModelInfo;
	meta?: LlamaCppMeta;
	context_window?: number;
	context_length?: number;
	max_tokens?: number;
}

interface LlamaCppModelsResponse {
	models?: Array<{ name?: string; model?: string }>;
	data: LlamaCppModel[];
	object?: string;
}

/**
 * Tolerant view of GET /props across llama.cpp builds and forks.
 * Standard llama.cpp exposes model_path, modalities, default_generation_settings,
 * total_slots, build_info, is_sleeping; lucebox adds model_alias, server.name
 * and model.draft_path.
 */
interface ServerProps {
	model_path?: string | null;
	model_alias?: string | null;
	build_info?: string;
	server?: { name?: string; version?: string };
	role?: string;
	max_instances?: number;
	total_slots?: number;
	is_sleeping?: boolean;
	modalities?: { vision?: boolean; audio?: boolean };
	default_generation_settings?: {
		n_ctx?: number;
		speculative?: boolean;
		params?: Record<string, unknown>;
	};
	capabilities?: { reasoning_supported?: boolean; tools_supported?: boolean };
	model?: { arch?: string | null; draft_path?: string | null };
	draft_path?: string | null;
	cache_type_k?: string;
	cache_type_v?: string;
}

type ServerKind = "llamacpp" | "zinc" | "lucebox" | "dwarfstar" | "lmstudio";
type ServerMode = "single" | "router" | "unknown";

/** Per-model metadata extracted during discovery. */
interface ModelMetadata {
	/** Model quant tag from the GGUF filename (e.g. "UD-Q3_K_XL"). */
	quant?: string;
	/** Vision input (mmproj / modalities / input_modalities). */
	vision?: boolean;
	/** Draft (drafter) model used for speculative decoding. */
	drafter?: string;
	/** KV cache K quantization (e.g. "q8_0"). */
	cacheK?: string;
	/** KV cache V quantization (e.g. "q8_0"). */
	cacheV?: string;
	/** Router mode load status (loaded / unloaded / loading / sleeping / failed). */
	routerStatus?: string;
}

/** Result of probing one host:port endpoint. */
interface EndpointResult {
	serverId: string;
	host: string;
	label: string;
	port: number;
	baseUrl: string;
	server: ServerKind | "auto" | "unknown";
	/** llama.cpp serving mode: single model or router (multi-model). */
	mode: ServerMode;
	models: LlamaCppModel[];
	/** Per-model metadata, keyed by the raw model id. */
	meta: Map<string, ModelMetadata>;
	ok: boolean;
	error?: string;
	/** true if the endpoint responded 503 (model still loading). */
	loading?: boolean;
	latencyMs?: number;
	nameMap?: Map<string, string>;
	/** /props payload when available (single-model mode, lucebox). */
	props?: ServerProps;
}

interface ScanResult {
	endpoints: EndpointResult[];
	totalModels: number;
	serversUp: number;
	serversTotal: number;
}

// =============================================================================
// Constants & defaults
// =============================================================================

const PROVIDER_NAME = "llamacpp-infra";
const STATUS_KEY = "llamacpp-infra";
const CONFIG_FILE = "llamacpp-infra.json";
const LEGACY_CONFIG_FILE = "local-models.json";
const METRICS_WIDGET_ID = "llamacpp-infra-metrics";
const DEFAULT_API_KEY = "no-auth";

/** Field llama.cpp accepts per request to cap thinking tokens. */
const THINKING_BUDGET_FIELD = "thinking_budget_tokens";

const DEFAULT_SETTINGS: SettingsConfig = {
	discoveryTimeoutMs: 2000,
	pollIntervalMs: 4000,
	pollMaxMs: 90_000,
	startupGraceMs: 40_000,
	knownGoodFailLimit: 3,
	detectVision: true,
	prefixModelIds: true,
	warmup: true,
	metricsEnabled: true,
	metricsPollMs: 5000,
	includeUnloadedRouterModels: false,
	showBadgesInNames: true,
};

/** First-run seed: a sensible localhost default. Users add their own
 *  machines (LAN/Tailscale hosts) through the /llamacpp-infra config UI. */
const DEFAULT_SERVERS: ServerConfig[] = [
	{
		id: "local",
		host: "127.0.0.1",
		label: "Local",
		ports: [8000, 8001, 8002, 8080, 8081, 8082, 1234],
		enabled: true,
		probeDs4: false,
	},
];

const DEBUG = process.env.PI_LLAMACPP_INFRA_DEBUG === "1" || process.env.PI_LLAMACPP_INFRA_DEBUG === "true";
function debugLog(...args: unknown[]) {
	if (DEBUG) console.debug(`[llamacpp-infra]`, ...args);
}

// =============================================================================
// Config persistence (with legacy local-models.json migration)
// =============================================================================

function getConfigPath(): string {
	return join(getAgentDir(), CONFIG_FILE);
}

function loadConfig(): InfraConfig {
	const defaults: InfraConfig = {
		servers: DEFAULT_SERVERS,
		settings: { ...DEFAULT_SETTINGS },
		modelOptions: {},
	};
	const path = getConfigPath();
	if (existsSync(path)) {
		try {
			const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<InfraConfig>;
			return {
				servers: Array.isArray(raw.servers) ? raw.servers : defaults.servers,
				settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
				modelOptions: raw.modelOptions ?? {},
			};
		} catch (err) {
			console.error(`[llamacpp-infra] Config load error: ${err}`);
		}
		return defaults;
	}
	// Migrate legacy local-models.json (preserves servers edited via the old menu).
	const legacyPath = join(getAgentDir(), LEGACY_CONFIG_FILE);
	if (existsSync(legacyPath)) {
		try {
			const raw = JSON.parse(readFileSync(legacyPath, "utf-8")) as Partial<InfraConfig>;
			const migrated: InfraConfig = {
				servers: Array.isArray(raw.servers) ? raw.servers : defaults.servers,
				settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
				modelOptions: raw.modelOptions ?? {},
			};
			debugLog(`migrated legacy config from ${legacyPath}`);
			return migrated; // saved on next saveConfig()
		} catch {
			// fall through to defaults
		}
	}
	return defaults;
}

function saveConfig(config: InfraConfig): void {
	try {
		const dir = getAgentDir();
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
		debugLog(`config saved to ${getConfigPath()}`);
	} catch (err) {
		console.error(`[llamacpp-infra] Config save error: ${err}`);
	}
}

// =============================================================================
// Small utilities
// =============================================================================

/** Select helper: maps labeled strings to ctx.ui.select() values. */
async function selectFrom<T>(
	ctx: ExtensionContext,
	title: string,
	items: Array<{ value: T; label: string; description?: string }>,
): Promise<T | undefined> {
	const strings = items.map((it) => (it.description ? `${it.label} — ${it.description}` : it.label));
	const picked = await ctx.ui.select(title, strings);
	if (picked === undefined) return undefined;
	const idx = strings.indexOf(picked);
	return idx >= 0 ? items[idx].value : undefined;
}

/**
 * Parse a ports string like "8000, 8080-8082, 9000" into a sorted unique list.
 * Returns undefined if nothing valid was entered.
 */
function parsePorts(input: string): number[] | undefined {
	const ports = new Set<number>();
	for (const part of input.split(/[,\s]+/)) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const range = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
		if (range) {
			const lo = parseInt(range[1], 10);
			const hi = parseInt(range[2], 10);
			if (isNaN(lo) || isNaN(hi) || lo > hi || hi > 65535 || lo <= 0) continue;
			for (let p = lo; p <= hi && p - lo < 256; p++) ports.add(p);
			continue;
		}
		const n = parseInt(trimmed, 10);
		if (!isNaN(n) && n > 0 && n < 65536) ports.add(n);
	}
	if (ports.size === 0) return undefined;
	return [...ports].sort((a, b) => a - b);
}

function formatMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	return `${Math.round(ms / 60_000)}m`;
}

function formatCtx(tokens: number | undefined): string {
	if (!tokens || tokens <= 0) return "";
	return tokens >= 1024 ? `${Math.round(tokens / 1024)}k` : `${tokens}`;
}

function serverLabel(srv: ServerConfig): string {
	return srv.label?.trim() || srv.host;
}

/** Model id fragment for a server: hosts like "127.0.0.1" are kept as-is. */
function idSafeHost(host: string): string {
	return host.trim().toLowerCase() || "host";
}

function isLocalHost(host: string): boolean {
	const h = host.trim().toLowerCase();
	return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

/** Basename of a path-ish string. */
function baseName(p: string): string {
	const cleaned = p.replace(/\\/g, "/");
	const last = cleaned.split("/").pop() || cleaned;
	return last;
}

// =============================================================================
// GGUF quant tag extraction
// =============================================================================

const QUANT_TAG_RE =
	/[-._\s]?((?:UD-|KL1-)?(?:I?Q[1-8][._][0-9A-Z_]+|IQ[1-4]_[0-9A-Z]+|TQ[1-4]_[0-9]|F16|F32|BF16|FP16|FP32|MXFP4[0-9A-Z_]*))$/i;

/**
 * Extract the quantization tag from a GGUF filename or router model id.
 * The quant tag is, by convention, the trailing token of the name:
 *   ".../Qwen3.6-27B-UD-Q3_K_XL.gguf"     → "UD-Q3_K_XL"
 *   ".../Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf" → "Q4_K_M"
 *   "ggml-org/gemma-3-4b-it-GGUF:Q4_K_M"  → "Q4_K_M" (router id suffix)
 *   "DeepSeek-V4-Flash-ROCMFP2-STRIX.gguf" → undefined (no quant in name)
 */
function extractQuantTag(filenameOrId: string): string | undefined {
	// Router ids use "repo/model:QUANT"
	const colon = filenameOrId.lastIndexOf(":");
	if (colon > 0) {
		const suffix = filenameOrId.slice(colon + 1);
		if (/^(I?Q[1-8]_|TQ[1-4]_|F16|F32|BF16|FP16|MXFP4)/i.test(suffix)) return suffix.toUpperCase();
	}
	const base = baseName(filenameOrId).replace(/\.(gguf|ggml)$/i, "");
	const match = base.match(QUANT_TAG_RE);
	return match?.[1]?.toUpperCase();
}

// =============================================================================
// llama-server flag parsing (server args from router status / /proc cmdline)
// =============================================================================

interface ParsedServerArgs {
	cacheK?: string;
	cacheV?: string;
	draft?: string;
	hasDraft?: boolean;
	hasMmproj?: boolean;
	mmprojPath?: string;
}

/** Values that mean "flag present without value" for value-optional flags. */
function parseServerArgs(tokens: string[]): ParsedServerArgs {
	const out: ParsedServerArgs = {};
	const take = (i: number): string | undefined => {
		const v = tokens[i + 1];
		return v && !v.startsWith("-") ? v : undefined;
	};
	for (let i = 0; i < tokens.length; i++) {
		let tok = tokens[i];
		if (!tok.startsWith("-")) continue;
		let inline: string | undefined;
		const eq = tok.indexOf("=");
		if (eq > 0) {
			inline = tok.slice(eq + 1);
			tok = tok.slice(0, eq);
		}
		const val = inline ?? take(i);
		const t = tok.toLowerCase();
		if (t === "--cache-type-k" || t === "-ctk") out.cacheK = (val ?? "").toLowerCase() || undefined;
		else if (t === "--cache-type-v" || t === "-ctv") out.cacheV = (val ?? "").toLowerCase() || undefined;
		else if (t === "--model-draft" || t === "-md" || t === "--hf-repo-draft" || t === "-hfrd") {
			out.hasDraft = true;
			if (val) out.draft = baseName(val);
		} else if (t === "--mmproj") {
			out.hasMmproj = true;
			if (val) out.mmprojPath = val;
		}
	}
	return out;
}

// =============================================================================
// Local llama-server process scan (/proc) — loopback servers only
// =============================================================================

interface LocalServerInfo extends ParsedServerArgs {
	port: number;
}

/**
 * Scan /proc for local llama-server processes and extract the flags that are
 * not exposed over HTTP: --mmproj (vision), --cache-type-k/-v (KV quant),
 * --model-draft (drafter). Keyed by listen port. Only used for loopback
 * endpoints; remote machines are covered by router status.args.
 */
function scanLocalServers(): Map<number, LocalServerInfo> {
	const found = new Map<number, LocalServerInfo>();
	let pids: string[] = [];
	try {
		pids = readdirSync("/proc");
	} catch {
		return found; // not Linux
	}
	for (const pid of pids) {
		if (!/^\d+$/.test(pid)) continue;
		try {
			const args = readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").filter(Boolean);
			const bin = (args[0] ?? "").split("/").pop() ?? "";
			if (!bin.startsWith("llama-server")) continue;
			const i = args.indexOf("--port");
			const port = i >= 0 ? parseInt(args[i + 1], 10) : NaN;
			if (isNaN(port)) continue;
			const parsed = parseServerArgs(args);
			found.set(port, { port, ...parsed });
		} catch {
			// process vanished between readdir and read — ignore
		}
	}
	return found;
}

// =============================================================================
// HTTP client (node:http — no fetch)
// =============================================================================
// fetch()/undici intermittently fails through podman's pasta proxy and adds
// headers ZINC chokes on. Raw http.request with forced IPv4 (Tailscale names
// resolve IPv6-first with unroutable link-local addresses) and fresh sockets.

interface HttpResult {
	status: number;
	body: string;
	contentType?: string;
}

function httpRequest(
	method: string,
	url: string,
	body?: string,
	timeoutMs = 2000,
	apiKey?: string,
): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const headers: http.OutgoingHttpHeaders = {
			Accept: "application/json, text/plain",
			"User-Agent": "pi-llamacpp-infra/1.0",
		};
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		if (body) {
			headers["Content-Type"] = "application/json";
			headers["Content-Length"] = Buffer.byteLength(body).toString();
		}
		const options: http.RequestOptions = {
			hostname: parsed.hostname,
			port: parsed.port || 80,
			path: parsed.pathname + parsed.search,
			method,
			headers,
			timeout: timeoutMs,
			// Force IPv4: avoids slow happy-eyeballs on IPv6-first DNS and
			// matches podman pasta IPv4-only port forwarding.
			family: 4,
			agent: new http.Agent({ keepAlive: false, maxSockets: 1 }),
		};

		const req = http.request(options, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () =>
				resolve({
					status: res.statusCode ?? 0,
					body: Buffer.concat(chunks).toString("utf-8"),
					contentType: res.headers["content-type"],
				}),
			);
		});

		req.on("error", (err: Error) => reject(err));
		req.on("timeout", () => {
			req.destroy();
			reject(new Error(`Timeout after ${timeoutMs}ms`));
		});

		if (body) req.write(body);
		req.end();
	});
}

/** GET with a single retry for transient errors (ECONNREFUSED is final). */
async function httpGet(url: string, timeoutMs: number, apiKey?: string): Promise<HttpResult> {
	try {
		return await httpRequest("GET", url, undefined, timeoutMs, apiKey);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ECONNREFUSED" || code === "ENOTFOUND") throw err;
		await new Promise((r) => setTimeout(r, 250));
		return await httpRequest("GET", url, undefined, timeoutMs, apiKey);
	}
}

function isNetworkError(msg: string): boolean {
	return /timeout|socket hang up|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(msg);
}

// =============================================================================
// Model display names
// =============================================================================

/**
 * Turn a raw model id / GGUF path into a readable display name.
 *   .../Qwen3.6-35B-A3B-Uncensored-HauhauCS-Q6_K_P.gguf → "Qwen3.6-35B-A3B"
 *   .../Ornith-1.0-35B-IQ3_M.gguf                       → "Ornith-1.0-35B-IQ3_M"
 *   .../DeepSeek-V4-Flash-ROCMFP2-STRIX.gguf            → "DeepSeek-V4-Flash-ROCMFP2-STRIX"
 */
function cleanModelName(rawId: string): string {
	let name = rawId.split("/").pop() || rawId;
	name = name.replace(/\.(gguf|ggml)(?:\.tar)?$/i, "");
	name = name.replace(/[-_.][Ff](?:16|32)$/i, "");
	name = name.replace(/[-_.][Qq]2_[Kk]$/i, "");
	name = name.replace(/[-_.][Qq]3_[Kk]_[SLM]$/i, "");
	name = name.replace(/[-_.][Qq]4_[01]|[-_.][Qq]4_[Kk]_[MS]$/i, "");
	name = name.replace(/[-_.][Qq]5_[0K]_[MS]$/i, "");
	name = name.replace(/[-_.][Qq]6_[Kk](_[A-Z])?$/i, "");
	name = name.replace(/[-_.][Qq]8_[0O]$/i, "");
	name = name.replace(/-(?:Uncensored|Alpaca|Instruct|Chat|Turbo|Base|MoE|UD)(?:-[a-zA-Z0-9]+)*$/i, "");
	name = name.replace(/-(?:v[0-9.]+)(?:-[a-zA-Z0-9]+)*$/, "");
	name = name.replace(/-+$/, "").trim();
	return name || rawId;
}

// =============================================================================
// Server kind detection & /props
// =============================================================================

async function fetchServerProps(
	baseUrl: string,
	timeoutMs: number,
	apiKey?: string,
	model?: string,
): Promise<ServerProps | undefined> {
	const rootUrl = baseUrl.replace(/\/v1\/?$/, "");
	let url = `${rootUrl}/props`;
	// Router mode: per-model props. autoload=false guarantees we never trigger
	// an expensive model load just by probing.
	if (model !== undefined) url += `?model=${encodeURIComponent(model)}&autoload=false`;
	try {
		const { status, body } = await httpGet(url, timeoutMs, apiKey);
		if (status >= 200 && status < 300) return JSON.parse(body) as ServerProps;
	} catch {
		// no /props → plain OpenAI-compatible server
	}
	return undefined;
}

function lmStudioKey(info: LmStudioModelInfo): string | undefined {
	return info.key ?? info.id;
}

function lmStudioQuantName(info: LmStudioModelInfo | undefined): string | undefined {
	if (!info) return undefined;
	const q = info.quantization;
	if (typeof q === "string") return q || undefined;
	return q?.name ?? undefined;
}

function lmStudioContextLength(info: LmStudioModelInfo | undefined): number | undefined {
	if (!info) return undefined;
	const loadedCtx = info.loaded_instances?.find((inst) => typeof inst.config?.context_length === "number")?.config?.context_length;
	return loadedCtx ?? info.max_context_length;
}

function isLmStudioModelInfo(value: unknown): value is LmStudioModelInfo {
	const m = value as LmStudioModelInfo | undefined;
	if (!m || typeof m !== "object") return false;
	return Boolean(
		m.key ||
		m.id ||
		m.display_name ||
		m.compatibility_type ||
		m.format ||
		m.loaded_instances ||
		typeof m.max_context_length === "number" ||
		m.capabilities,
	);
}

async function fetchLmStudioCatalog(
	baseUrl: string,
	timeoutMs: number,
	apiKey?: string,
): Promise<LmStudioModelInfo[] | undefined> {
	const rootUrl = baseUrl.replace(/\/v1\/?$/, "");
	// LM Studio v1 is current; v0 is still common in older installations.
	for (const path of ["/api/v1/models", "/api/v0/models"]) {
		try {
			const { status, body } = await httpGet(`${rootUrl}${path}`, timeoutMs, apiKey);
			if (status < 200 || status >= 300) continue;
			const payload = JSON.parse(body) as LmStudioModelsResponse;
			const models = Array.isArray(payload.models) ? payload.models : Array.isArray(payload.data) ? payload.data : undefined;
			if (models && models.length > 0 && models.some(isLmStudioModelInfo)) return models;
		} catch {
			// Not LM Studio, or an older server without the REST metadata endpoint.
		}
	}
	return undefined;
}

function buildLmStudioCatalogMap(catalog: LmStudioModelInfo[]): Map<string, LmStudioModelInfo> {
	const map = new Map<string, LmStudioModelInfo>();
	const add = (key: string | undefined, info: LmStudioModelInfo) => {
		const k = key?.trim().toLowerCase();
		if (k && !map.has(k)) map.set(k, info);
	};
	for (const info of catalog) {
		add(lmStudioKey(info), info);
		add(info.key, info);
		add(info.id, info);
		add(info.selected_variant, info);
		add(info.display_name, info);
		for (const variant of info.variants ?? []) add(variant, info);
		for (const inst of info.loaded_instances ?? []) add(inst.id, info);
	}
	return map;
}

function enrichWithLmStudioCatalog(models: LlamaCppModel[], catalog: LmStudioModelInfo[]): LlamaCppModel[] {
	const byKey = buildLmStudioCatalogMap(catalog);
	return models.map((model) => {
		const rawId = String(model.id ?? "");
		const info = byKey.get(rawId.toLowerCase()) ?? byKey.get(baseName(rawId).toLowerCase());
		if (!info) return model;
		return { ...model, display_name: info.display_name ?? model.display_name, lmStudio: info };
	});
}

/**
 * Detect the server kind for an endpoint:
 *   1. lucebox:    /props with server.name "luce-*"
 *   2. DwarfStar:  /props build_info "dwarf*"/"ds4*" (else via chat probe)
 *   3. ZINC:       /v1/models with owned_by === "zinc"
 *   4. LM Studio:  OpenAI-compatible /v1/models + REST /api/v1|v0/models
 *   5. llama.cpp:  anything else serving models
 */
async function detectServerKind(
	baseUrl: string,
	models: LlamaCppModel[],
	props: ServerProps | undefined,
	lmStudioCatalog?: LmStudioModelInfo[],
): Promise<ServerKind | "unknown"> {
	void baseUrl;
	const serverName = String(props?.server?.name ?? props?.build_info ?? "").toLowerCase();
	if (serverName.startsWith("luce")) return "lucebox";
	if (serverName.startsWith("dwarf") || serverName.startsWith("ds4")) return "dwarfstar";
	if (models.length > 0 && models[0].owned_by === "zinc") return "zinc";
	if (models.some((m) => String(m.owned_by ?? "").toLowerCase().includes("lmstudio"))) return "lmstudio";
	if (lmStudioCatalog && lmStudioCatalog.length > 0) return "lmstudio";
	if (models.some((m) => m.lmStudio)) return "lmstudio";
	if (models.length > 0) return "llamacpp";
	return "unknown";
}

/**
 * Probe a DwarfStar/ds4 server by pinging /v1/chat/completions (it does not
 * implement /v1/models). Two attempts: without a model field, then "ping".
 */
async function probeDs4Server(
	ep: EndpointResult,
	timeoutMs: number,
	apiKey?: string,
): Promise<EndpointResult> {
	const chatUrl = `${ep.baseUrl}/chat/completions`;
	const tryProbe = async (model?: string): Promise<string | null> => {
		const reqBody: Record<string, unknown> = {
			messages: [{ role: "user", content: "ping" }],
			max_tokens: 1,
		};
		if (model) reqBody.model = model;
		try {
			const res = await httpRequest("POST", chatUrl, JSON.stringify(reqBody), timeoutMs, apiKey);
			if (res.status < 200 || res.status >= 300) return null;
			const p = JSON.parse(res.body) as { model?: string };
			return p.model ?? model ?? "ds4-model";
		} catch {
			return null;
		}
	};

	try {
		let modelName = await tryProbe();
		if (!modelName) modelName = await tryProbe("ping");
		if (modelName) {
			ep.ok = true;
			ep.error = undefined;
			ep.loading = false;
			ep.server = "dwarfstar";
			ep.mode = "single";
			ep.models = [{ id: modelName, name: modelName }];
			ep.meta.set(modelName, { quant: extractQuantTag(modelName) });
			return ep;
		}
		ep.error = "ds4 probe: no response from /v1/chat/completions";
		return ep;
	} catch (error) {
		ep.error = `ds4 probe: ${error instanceof Error ? error.message : String(error)}`;
		return ep;
	}
}

// =============================================================================
// Endpoint scanning
// =============================================================================

/**
 * Build per-model metadata for a single /v1/models entry, combining:
 *   - router entry fields (path, status.args, architecture.input_modalities)
 *   - single-model /props (model_path, modalities.vision, draft_path)
 *   - /proc scan of local llama-server processes (mmproj, cache quants, draft)
 */
function buildModelMetadata(
	rawId: string,
	entry: LlamaCppModel,
	props: ServerProps | undefined,
	local: LocalServerInfo | undefined,
): ModelMetadata {
	const meta: ModelMetadata = {};

	// ── Model quant (GGUF filename / router id / LM Studio metadata) ──
	const sourcePath = entry.path ?? props?.model_path ?? rawId;
	meta.quant = extractQuantTag(sourcePath) ?? lmStudioQuantName(entry.lmStudio)?.toUpperCase();

	// ── Vision ──
	if (entry.architecture?.input_modalities?.includes("image")) meta.vision = true;
	if (meta.vision === undefined && props?.modalities?.vision === true) meta.vision = true;
	if (!meta.vision && (entry.lmStudio?.capabilities?.vision === true || entry.lmStudio?.type === "vlm")) meta.vision = true;
	if (!meta.vision && local?.hasMmproj) meta.vision = true;

	// ── Drafter (speculative decoding) ──
	const argsInfo = entry.status?.args ? parseServerArgs(entry.status.args) : undefined;
	if (argsInfo?.draft) meta.drafter = argsInfo.draft;
	else if (argsInfo?.hasDraft) meta.drafter = "draft model";
	if (!meta.drafter) {
		const draftPath = props?.model?.draft_path ?? props?.draft_path;
		if (draftPath) meta.drafter = baseName(draftPath);
		else if (props?.default_generation_settings?.speculative === true) meta.drafter = "speculative";
	}
	if (!meta.drafter && local?.draft) meta.drafter = local.draft;
	else if (!meta.drafter && local?.hasDraft) meta.drafter = "draft model";

	// ── KV cache quantization ──
	meta.cacheK = argsInfo?.cacheK ?? local?.cacheK ?? props?.cache_type_k?.toLowerCase();
	meta.cacheV = argsInfo?.cacheV ?? local?.cacheV ?? props?.cache_type_v?.toLowerCase();

	// ── Router / LM Studio load status ──
	if (entry.status?.value) meta.routerStatus = entry.status.value;
	else if (entry.lmStudio?.state && entry.lmStudio.state !== "loaded") meta.routerStatus = entry.lmStudio.state;

	return meta;
}

async function fetchModelsFromEndpoint(
	srv: ServerConfig,
	port: number,
	settings: SettingsConfig,
	localServers: Map<number, LocalServerInfo>,
): Promise<EndpointResult> {
	const baseUrl = `http://${srv.host}:${port}/v1`;
	const ep: EndpointResult = {
		serverId: srv.id,
		host: srv.host,
		label: serverLabel(srv),
		port,
		baseUrl,
		server: "auto",
		mode: "unknown",
		models: [],
		meta: new Map(),
		ok: false,
	};
	const started = Date.now();
	try {
		const { status, body } = await httpGet(`${baseUrl}/models`, settings.discoveryTimeoutMs, srv.apiKey);
		ep.latencyMs = Date.now() - started;
		if (status < 200 || status >= 300) {
			ep.error = `${status}: ${(body || "unknown error").slice(0, 200)}`;
			ep.loading = status === 503; // server present, model still loading
			if (srv.probeDs4 && !ep.loading) return probeDs4Server(ep, settings.discoveryTimeoutMs, srv.apiKey);
			return ep;
		}
		const payload = JSON.parse(body) as LlamaCppModelsResponse;
		let models = payload.data ?? [];

		// llama.cpp provides a parallel models[] array with friendly names
		const nameMap = new Map<string, string>();
		if (Array.isArray(payload.models)) {
			for (const m of payload.models) {
				if (m.model && m.name) nameMap.set(m.model, m.name);
			}
		}

		// ── Mode + server metadata detection ──
		// Router/multi-model entries carry path/status/architecture; the router's
		// own /props answers with role: "router". LM Studio answers OpenAI's
		// /v1/models and exposes richer local metadata under /api/v1/models
		// (legacy: /api/v0/models), without llama.cpp's /props endpoint.
		let props = await fetchServerProps(baseUrl, settings.discoveryTimeoutMs, srv.apiKey);
		const lmStudioCatalog = props ? undefined : await fetchLmStudioCatalog(baseUrl, settings.discoveryTimeoutMs, srv.apiKey);
		if (lmStudioCatalog) models = enrichWithLmStudioCatalog(models, lmStudioCatalog);
		const isRouterShape = models.some((m) => m.path !== undefined || m.status !== undefined);
		const routerProps = props?.role === "router";
		const mode: ServerMode = lmStudioCatalog
			? models.length > 1 ? "router" : "single"
			: isRouterShape || routerProps ? "router" : "single";
		// In single-model mode props describes THE model; in router mode the root
		// props is the router itself (useless for per-model metadata).
		if (mode === "router") props = undefined;

		const kind = await detectServerKind(baseUrl, models, props, lmStudioCatalog);
		// lucebox always enriches via /props (its own schema, even without router).
		if (kind === "lucebox") {
			props = (await fetchServerProps(baseUrl, settings.discoveryTimeoutMs, srv.apiKey)) ?? props;
		}

		const local = isLocalHost(srv.host) && settings.detectVision ? localServers.get(port) : undefined;

		// ── Per-model metadata ──
		for (const model of models) {
			const rawId = String(model.id ?? "");
			let modelProps = props;
			// Router mode: fetch per-model props ONLY when the entry lacks vision
			// info and the model is loaded (autoload=false prevents loads).
			if (mode === "router" && !model.architecture?.input_modalities && model.status?.value === "loaded") {
				modelProps = (await fetchServerProps(baseUrl, settings.discoveryTimeoutMs, srv.apiKey, rawId)) ?? undefined;
			}
			ep.meta.set(rawId, buildModelMetadata(rawId, model, modelProps, local));
		}

		ep.server = kind;
		ep.mode = mode;
		ep.models = models;
		ep.nameMap = nameMap;
		ep.props = props;
		ep.ok = true;
		return ep;
	} catch (err) {
		ep.latencyMs = Date.now() - started;
		const msg = err instanceof Error ? err.message : String(err);
		ep.error = msg;
		if (srv.probeDs4 && !isNetworkError(msg)) {
			return probeDs4Server(ep, settings.discoveryTimeoutMs, srv.apiKey);
		}
		return ep;
	}
}

// =============================================================================
// Model → pi registration
// =============================================================================

/** Compat profile per server kind. */
function supportsThinkingBudget(kind: ServerKind | "unknown" | "auto" | undefined): boolean {
	return kind === "llamacpp" || kind === "lucebox";
}

function makeCompat(kind: ServerKind | "unknown" | "auto") {
	const usageInStreaming = kind !== "zinc";
	return {
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens" as const,
		supportsUsageInStreaming: usageInStreaming,
		supportsStrictMode: false,
		// llama.cpp accepts a per-request `thinking_budget_tokens` cap.
		// LM Studio is OpenAI-compatible but does not accept llama.cpp-only fields.
		// (Only honored by pi when the model is registered with reasoning: true.)
		...(supportsThinkingBudget(kind) ? { thinkingTokenBudgetField: THINKING_BUDGET_FIELD } : {}),
	};
}

interface PiModel {
	id: string;
	name: string;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat?: ReturnType<typeof makeCompat>;
	headers?: Record<string, string>;
	thinkingBudgets?: ThinkingBudgets;
	/** Raw model id expected by the server (compact ids are display-only). */
	serverModelId: string;
	/** Metadata badges are applied to the name at build time. */
	endpoint: { serverId: string; host: string; port: number; kind: ServerKind | "unknown" | "auto"; mode: ServerMode };
	quant?: string;
	cacheK?: string;
	cacheV?: string;
	drafter?: string;
	routerStatus?: string;
}

/** Compact badge string appended to display names when enabled. */
function badgeSuffix(meta: {
	vision?: boolean;
	drafter?: string;
	routerStatus?: string;
}, showBadges: boolean): string {
	if (!showBadges) return "";
	let badges = "";
	if (meta.vision) badges += "👁️";
	if (meta.drafter) badges += "🚀";
	if (meta.routerStatus && meta.routerStatus !== "loaded") badges += "💤";
	return badges ? ` [${badges}]` : "";
}

function toPiModel(
	model: LlamaCppModel,
	ep: EndpointResult,
	srv: ServerConfig,
	settings: SettingsConfig,
	modelMeta: ModelMetadata,
): PiModel {
	const rawId = String(model.id ?? "");
	const hostPort = `${idSafeHost(srv.host)}:${ep.port}`;
	// Compact display id: "ModelName (host:port)". The raw server-side id is
	// kept separately (serverModelId) and restored in before_provider_request.
	const machineTag = settings.prefixModelIds ? ` (${hostPort})` : "";
	const kind = ep.server;

	const common = {
		baseUrl: ep.baseUrl,
		input: (modelMeta.vision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		endpoint: { serverId: srv.id, host: srv.host, port: ep.port, kind, mode: ep.mode },
		quant: modelMeta.quant,
		cacheK: modelMeta.cacheK,
		cacheV: modelMeta.cacheV,
		drafter: modelMeta.drafter,
		routerStatus: modelMeta.routerStatus,
		...(srv.apiKey ? { headers: { Authorization: `Bearer ${srv.apiKey}` } } : {}),
	};

	// ── LM Studio: OpenAI-compatible runtime with rich REST model metadata ──
	if (kind === "lmstudio") {
		const info = model.lmStudio;
		const contextWindow = lmStudioContextLength(info) ?? model.context_window ?? model.context_length ?? 32768;
		const displayName = info?.display_name ? cleanModelName(info.display_name) : cleanModelName(rawId);
		return {
			...common,
			id: `${displayName}${machineTag}`,
			serverModelId: rawId,
			name: `${displayName}${badgeSuffix(modelMeta, settings.showBadgesInNames)}`,
			// LM Studio exposes reasoning-capable models, but its OpenAI-compatible
			// endpoint does not use llama.cpp's thinking_budget_tokens field.
			reasoning: false,
			contextWindow,
			maxTokens: model.max_tokens ?? Math.min(contextWindow, 8192),
			compat: makeCompat(kind),
		};
	}

	// ── lucebox: alias as source of truth, rich metadata from /props ──
	if (kind === "lucebox") {
		const modelPath = ep.props?.model_path || rawId;
		const alias = ep.props?.model_alias || rawId;
		const nCtx = ep.props?.default_generation_settings?.n_ctx;
		const contextWindow = model.context_length ?? nCtx ?? 8192;
		const displayName = cleanModelName(baseName(alias !== rawId ? alias : modelPath));
		return {
			...common,
			id: `${displayName}${machineTag}`,
			serverModelId: alias,
			name: `${displayName}${badgeSuffix(modelMeta, settings.showBadgesInNames)}`,
			reasoning: ep.props?.capabilities?.reasoning_supported ?? true,
			contextWindow,
			maxTokens: model.max_tokens ?? Math.min(contextWindow, 8192),
			compat: makeCompat(kind),
		};
	}

	// ── ZINC / llama.cpp / dwarfstar ──
	const cleanName = cleanModelName(rawId);
	// Router entries expose the GGUF path — prefer its basename for display.
	const nameSource = model.path ?? rawId;
	const cleanFromSource = cleanModelName(baseName(nameSource));
	const baseName2 = model.name && String(model.name) !== rawId ? cleanModelName(String(model.name)) : cleanFromSource || cleanName;
	const nameMapName = ep.nameMap?.get(rawId);
	const displayName = nameMapName ? cleanModelName(nameMapName) : baseName2;

	const contextWindow =
		model.meta?.n_ctx ?? model.meta?.n_ctx_train ?? model.context_window ?? model.context_length ?? 32768;

	const isLlamaFamily = kind === "llamacpp";

	return {
		...common,
		id: `${displayName}${machineTag}`,
		serverModelId: rawId,
		name: `${displayName}${badgeSuffix(modelMeta, settings.showBadgesInNames)}`,
		// llama.cpp-family models behave like native pi reasoning models: the
		// footer shows the thinking level and pi sends the configured budget.
		reasoning: isLlamaFamily,
		contextWindow,
		maxTokens: model.max_tokens ?? Math.min(contextWindow, 8192),
		compat: makeCompat(kind),
	};
}

// --- config access used by the pure builders above ---------------------------
let activeConfig: InfraConfig | undefined;
function config_ModelOptions(): Record<string, ModelOptions> {
	return activeConfig?.modelOptions ?? {};
}

// =============================================================================
// Metrics module (integrated model-metrics — Prometheus/JSON over HTTP)
// =============================================================================

const METRICS_CANDIDATE_PATHS = ["/metrics", "/v1/metrics", "/api/v1/metrics", "/stats"];
const METRICS_FETCH_TIMEOUT_MS = 3000;

const KNOWN_METRICS: Record<string, { label: string; icon: string }> = {
	prompt_tokens_total: { label: "prompt tokens", icon: "📥" },
	prompt_seconds_total: { label: "prompt time (s)", icon: "" },
	prompt_tokens_seconds: { label: "prompt t/s", icon: "⚡" },
	tokens_predicted_total: { label: "gen tokens", icon: "📤" },
	tokens_predicted_seconds_total: { label: "gen time (s)", icon: "" },
	predicted_tokens_seconds: { label: "gen t/s", icon: "🔥" },
	tokens_predicted_seconds: { label: "gen t/s", icon: "🔥" },
	requests_processing: { label: "processing", icon: "▶" },
	requests_deferred: { label: "deferred", icon: "⏳" },
	n_decode_total: { label: "decodes", icon: "" },
	n_tokens_max: { label: "max ctx", icon: "📏" },
	n_busy_slots_per_decode: { label: "busy slots/decode", icon: "" },
	num_requests_total: { label: "total requests", icon: "" },
	request_success_total: { label: "ok reqs", icon: "✅" },
	request_failure_total: { label: "failed reqs", icon: "❌" },
};

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
			// strip llama.cpp's "llamacpp:" legacy prefix
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

/** Cumulative counters used for instantaneous throughput deltas. */
function counterValue(m: Map<string, number>, names: string[]): number | undefined {
	for (const n of names) {
		const v = m.get(n);
		if (typeof v === "number") return v;
	}
	return undefined;
}

type ThemeFg = (color: any, text: string) => string;
const safeFg: ThemeFg = (_color, text) => text;

interface MetricsEndpointDiscovered {
	url: string;
	format: "prometheus" | "json";
}

// =============================================================================
// Discovery engine
// =============================================================================

/** Signature used to detect scan-result changes (avoids redundant re-registers). */
function modelsSignature(endpoints: EndpointResult[]): string {
	return endpoints
		.map((r) => {
			const models = r.models
				.filter((m) => {
					if (r.server === "lmstudio") return true;
					const st = r.meta.get(String(m.id ?? ""))?.routerStatus;
					return !st || st === "loaded" || rIncludeUnloaded;
				})
				.map((m) => `${m.id}:${r.meta.get(String(m.id ?? ""))?.routerStatus ?? ""}`)
				.sort()
				.join(",");
			return `${r.host}:${r.port}:${r.ok ? r.server : r.loading ? "loading" : "down"}:${models}`;
		})
		.join("|");
}

let rIncludeUnloaded = false; // set per scan from settings

async function scanAllServers(config: InfraConfig): Promise<ScanResult> {
	rIncludeUnloaded = config.settings.includeUnloadedRouterModels;
	const enabled = config.servers.filter((s) => s.enabled && s.ports.length > 0);
	const localServers = config.settings.detectVision ? scanLocalServers() : new Map<number, LocalServerInfo>();
	const tasks: Array<Promise<EndpointResult>> = [];
	for (const srv of enabled) {
		for (const port of srv.ports) {
			tasks.push(fetchModelsFromEndpoint(srv, port, config.settings, localServers));
		}
	}
	const endpoints = await Promise.all(tasks);
	const serversUp = new Set(endpoints.filter((e) => e.ok).map((e) => e.serverId)).size;
	const totalModels = endpoints.reduce((acc, e) => acc + (e.ok ? e.models.length : 0), 0);
	return { endpoints, totalModels, serversUp, serversTotal: enabled.length };
}

/** ZINC model ids currently registered (for the payload workaround hook). */
const zincModelIds = new Set<string>();
/** modelId → baseUrl (for the header warmup capture hook). */
const modelBaseUrls = new Map<string, string>();
/** baseUrl → server kind (for the warmup request profile). */
const endpointKinds = new Map<string, string>();
/** Registered (compact) model id → raw server-side model id (payload rewrite). */
const serverModelIds = new Map<string, string>();
/** Raw server-side model id → registered (compact) model id. */
const compactModelIds = new Map<string, string>();

/** Compact id registered in pi for a raw server model id (or the input). */
function compactIdFor(modelId: string | undefined): string | undefined {
	if (!modelId) return undefined;
	return compactModelIds.get(modelId) ?? modelId;
}

/** Raw server-side id to send in requests for a registered model id (or the input). */
function rawIdFor(modelId: string | undefined): string | undefined {
	if (!modelId) return undefined;
	return serverModelIds.get(modelId) ?? modelId;
}

/**
 * Build pi models from a scan and (re)register the provider.
 * Returns the registered model list.
 */
function buildAndRegisterProvider(pi: ExtensionAPI, scan: ScanResult, config: InfraConfig): PiModel[] {
	zincModelIds.clear();
	serverModelIds.clear();
	compactModelIds.clear();
	const settings = config.settings;
	let configDirty = false;

	const piModels: PiModel[] = [];
	const seenIds = new Set<string>();
	for (const ep of scan.endpoints) {
		if (!ep.ok) continue;
		const srv = config.servers.find((s) => s.id === ep.serverId && s.host === ep.host);
		if (!srv) continue;

		// Router mode: skip unloaded models unless explicitly included.
		// LM Studio's /v1/models can expose embedding models too; this provider
		// registers chat/completions models only.
		const visibleModels = ep.models.filter((m) => {
			const lmType = m.lmStudio?.type;
			if (ep.server === "lmstudio") return lmType !== "embedding" && lmType !== "embeddings";
			const st = ep.meta.get(String(m.id ?? ""))?.routerStatus;
			return !st || st === "loaded" || settings.includeUnloadedRouterModels;
		});

		// Duplicate display names within one endpoint get the raw id appended.
		const nameCount = new Map<string, number>();
		for (const model of visibleModels) {
			const n = cleanModelName(String(model.name ?? model.id));
			nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
		}

		for (const model of visibleModels) {
			const rawId = String(model.id ?? "");
			const modelMeta = ep.meta.get(rawId) ?? {};
			const pm = toPiModel(model, ep, srv, settings, modelMeta);
			const hostPort = `${idSafeHost(srv.host)}:${ep.port}`;

			// ID collision guard: add the machine tag, then a numeric suffix.
			if (seenIds.has(pm.id)) {
				if (!pm.id.includes(`(${hostPort})`)) pm.id = `${pm.id} (${hostPort})`;
				let n = 2;
				while (seenIds.has(pm.id)) pm.id = `${pm.id}-${n++}`;
			}
			seenIds.add(pm.id);

			// Thinking budgets: resolve by the registered (compact) id or legacy
			// "host:port/model" keys, then migrate legacy keys forward.
			const opts = config_ModelOptions();
			let budgets = opts[pm.id]?.thinkingBudgets;
			if (!budgets) {
				for (const legacyKey of [`${hostPort}/${pm.serverModelId.replace(/^\/+/, "")}`, pm.serverModelId]) {
					const entry = opts[legacyKey];
					if (entry?.thinkingBudgets) {
						if (!opts[pm.id]) opts[pm.id] = entry;
						delete opts[legacyKey]; // migrate: compact id replaces host:port/model
						configDirty = true;
						budgets = entry.thinkingBudgets;
						break;
					}
				}
			}
			if (budgets && ep.server !== "lmstudio") {
				pm.thinkingBudgets = budgets;
				// Models with configured thinking budgets must be registered as
				// reasoning models so pi's thinking-level machinery engages.
				pm.reasoning = true;
			}

			// Duplicate display names within one endpoint get the raw id appended.
			const candidateName = cleanModelName(String(model.name ?? model.id));
			if (nameCount.get(candidateName)! > 1) {
				pm.name = `${candidateName}${badgeSuffix(modelMeta, settings.showBadgesInNames)} (${pm.serverModelId})`;
			}
			piModels.push(pm);
			if (ep.server === "zinc") {
				zincModelIds.add(pm.id);
				zincModelIds.add(pm.serverModelId);
			}
			serverModelIds.set(pm.id, pm.serverModelId);
			if (!compactModelIds.has(pm.serverModelId)) compactModelIds.set(pm.serverModelId, pm.id);
		}
	}

	if (configDirty) saveConfig(config);

	// Maps for hooks
	endpointKinds.clear();
	for (const ep of scan.endpoints) {
		if (ep.ok) endpointKinds.set(ep.baseUrl, ep.server);
	}
	modelBaseUrls.clear();
	for (const pm of piModels) modelBaseUrls.set(pm.id, pm.baseUrl);

	// Provider defaults: first enabled server/endpoint acts as the face of the provider.
	const first = config.servers.find((s) => s.enabled && s.ports.length > 0);
	const defaultBaseUrl =
		scan.endpoints.find((e) => e.ok)?.baseUrl ??
		`http://${first?.host ?? "127.0.0.1"}:${first?.ports[0] ?? 8080}/v1`;
	const defaultApiKey = first?.apiKey || DEFAULT_API_KEY;

	try {
		pi.unregisterProvider(PROVIDER_NAME);
	} catch {
		// not registered yet
	}

	pi.registerProvider(PROVIDER_NAME, {
		name: `🦙 llama.cpp-infra (${scan.totalModels} on ${scan.serversUp}/${scan.serversTotal} servers)`,
		baseUrl: defaultBaseUrl,
		apiKey: defaultApiKey,
		api: "openai-completions",
		// compat is set per model (model.compat is what pi honors).
		models: piModels,
	});

	return piModels;
}

// =============================================================================
// Extension entry point
// =============================================================================

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	activeConfig = config;

	let registeredCount = 0;
	let lastError: string | undefined;
	let lastScan: ScanResult | undefined;
	let lastModels: PiModel[] = [];
	let lastSignature: string | undefined;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let polling = false;
	/** True while the registered provider has an empty model list. */
	let providerIsEmpty = true;
	/** Current thinking level (for per-model thinking budget injection). */
	let currentThinkingLevel: string | undefined;

	/** Endpoints ("host:port") that ever answered OK, with consecutive-fail counts. */
	const knownGood = new Set<string>();
	const consecutiveFails = new Map<string, number>();
	let anyEverOk = false;
	const startedAt = Date.now();
	/**
	 * Extension contexts become invalid as soon as pi replaces/reloads a
	 * session. Async discovery and metric timers may outlive that boundary, so
	 * they must never touch captured ctx/pi objects after shutdown.
	 */
	let extensionActive = true;

	function ctxHasUI(ctx?: ExtensionContext): ctx is ExtensionContext {
		if (!ctx || !extensionActive) return false;
		try {
			return ctx.hasUI;
		} catch (err) {
			debugLog(`stale ctx ignored: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	const epKey = (host: string, port: number) => `${host}:${port}`;

	// ── Header warmup (pre-cache system prompt on llama.cpp-family servers) ──
	// The ☕ footer indicator shows warmup progress. Fully optional; disable
	// via /llamacpp-infra config → ☕ Header warmup, or env PI_WARMUP=0.
	const warmupStatus = new WarmupStatus("warmup-llamacpp-infra");
	const warmer = new PromptWarmer({
		provider: PROVIDER_NAME,
		cacheFile: join(homedir(), ".pi", "agent", "warmup-llamacpp-infra.json"),
		kindFor: (baseUrl) => endpointKinds.get(baseUrl),
		requestModelFor: (modelId) => rawIdFor(modelId) ?? modelId,
		onEvent: (ev) => warmupStatus.handle(ev),
	});

	function safeSystemPrompt(ctx: { getSystemPrompt?: () => string }): string | undefined {
		try {
			return ctx.getSystemPrompt?.();
		} catch {
			return undefined;
		}
	}

	// ── Live metrics (integrated model-metrics) ────────────────────
	let metricsTimer: ReturnType<typeof setInterval> | undefined;
	let metricsWidgetVisible = false;
	/** Discovered metrics endpoint per "host:port". */
	const metricsEndpoints = new Map<string, MetricsEndpointDiscovered>();
	/** Previous cumulative counters + timestamp, per "host:port". */
	const metricsPrev = new Map<string, { raw: Map<string, number>; ts: number }>();
	let metricsCurrentKey: string | undefined;
	let metricsCurrentBaseUrl: string | undefined;
	let metricsCurrentApiKey: string | undefined;

	async function discoverMetricsEndpoint(baseUrl: string): Promise<MetricsEndpointDiscovered | undefined> {
		const rootUrl = baseUrl.replace(/\/v1\/?$/, "");
		for (const path of METRICS_CANDIDATE_PATHS) {
			const url = `${rootUrl}${path}`;
			try {
				const res = await httpGet(url, METRICS_FETCH_TIMEOUT_MS, metricsCurrentApiKey);
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

	function renderMetricsWidget(lines: string[] | undefined, ctx: ExtensionContext) {
		if (!ctxHasUI(ctx)) return;
		if (lines === undefined) {
			if (metricsWidgetVisible) {
				ctx.ui.setWidget(METRICS_WIDGET_ID, undefined);
				metricsWidgetVisible = false;
			}
			return;
		}
		ctx.ui.setWidget(METRICS_WIDGET_ID, lines, { placement: "belowEditor" });
		metricsWidgetVisible = true;
	}

	function buildMetricsLine(
		raw: Map<string, number>,
		deltaSec: number,
		prev: { raw: Map<string, number> } | undefined,
		fg: ThemeFg,
	): string[] {
		// Instantaneous throughput from cumulative counters.
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
		// Fallback: server-provided average rates.
		if (promptTps === undefined) promptTps = raw.get("prompt_tokens_seconds");
		if (genTps === undefined) genTps = raw.get("predicted_tokens_seconds") ?? raw.get("tokens_predicted_seconds");

		const processing =
			raw.get("requests_processing") ?? counterValue(raw, ["num_requests_running"]) ?? 0;

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

	async function pollMetrics(ctx: ExtensionContext): Promise<void> {
		if (!extensionActive) return;
		try {
			const model = ctx.model;
			// Only our models have metrics; anything else hides the widget.
			if (!config.settings.metricsEnabled || model?.provider !== PROVIDER_NAME) {
				renderMetricsWidget(undefined, ctx);
				metricsCurrentKey = undefined;
				return;
			}

			// Resolve the endpoint for the current model.
			const baseUrl = model.baseUrl ?? modelBaseUrls.get(model.id);
			if (!baseUrl) {
				renderMetricsWidget(undefined, ctx);
				return;
			}
			const parsed = new URL(baseUrl);
			const key = `${parsed.hostname}:${parsed.port}`;
			if (key !== metricsCurrentKey) {
				metricsCurrentKey = key;
				metricsCurrentBaseUrl = baseUrl;
				metricsPrev.clear();
			}

			let endpoint = metricsEndpoints.get(key);
			if (!endpoint) {
				endpoint = await discoverMetricsEndpoint(baseUrl);
				if (endpoint) metricsEndpoints.set(key, endpoint);
			}
			if (!endpoint) {
				renderMetricsWidget([safeFg("muted", "📊 no metrics endpoint")], ctx);
				return;
			}

			const res = await httpGet(endpoint.url, METRICS_FETCH_TIMEOUT_MS, metricsCurrentApiKey);
			if (res.status < 200 || res.status >= 300) {
				renderMetricsWidget([safeFg("muted", `📊 metrics HTTP ${res.status}`)], ctx);
				return;
			}
			let raw: Map<string, number>;
			if (endpoint.format === "prometheus") raw = parsePrometheusMetrics(res.body);
			else {
				try {
					raw = parseJsonMetrics(JSON.parse(res.body));
				} catch {
					renderMetricsWidget([safeFg("muted", "📊 metrics parse error")], ctx);
					return;
				}
			}

			const now = Date.now();
			const prev = metricsPrev.get(key);
			const deltaSec = prev ? (now - prev.ts) / 1000 : 0;
			metricsPrev.set(key, { raw, ts: now });

			const fg = ctxHasUI(ctx) ? ((ctx.ui.theme?.fg)?.bind(ctx.ui.theme) ?? safeFg) : safeFg;
			renderMetricsWidget(buildMetricsLine(raw, deltaSec, prev, fg), ctx);
		} catch (err) {
			if (!extensionActive) return;
			const msg = err instanceof Error ? err.message : String(err);
			debugLog(`metrics poll failed: ${msg}`);
			const fg = ctxHasUI(ctx) ? ((ctx.ui.theme?.fg)?.bind(ctx.ui.theme) ?? safeFg) : safeFg;
			renderMetricsWidget([fg("muted", "📊 ⏸ idle")], ctx);
		}
	}

	function startMetricsPolling(ctx: ExtensionContext): void {
		if (!extensionActive || metricsTimer) return;
		void pollMetrics(ctx);
		metricsTimer = setInterval(() => {
			if (extensionActive) void pollMetrics(ctx);
		}, config.settings.metricsPollMs);
		metricsTimer?.unref?.();
	}

	function stopMetricsPolling(ctx?: ExtensionContext): void {
		if (metricsTimer) {
			clearInterval(metricsTimer);
			metricsTimer = undefined;
		}
		if (ctx) renderMetricsWidget(undefined, ctx);
	}

	// ── Polling engine (discovery) ─────────────────────────────────
	/** Keep polling while: something is loading, a known-good endpoint went
	 *  quiet (server restarting), or startup grace hasn't expired yet. */
	function shouldContinuePolling(endpoints: EndpointResult[], hasLoading: boolean): boolean {
		if (hasLoading) return true;
		for (const key of knownGood) {
			const ep = endpoints.find((e) => epKey(e.host, e.port) === key);
			if (!ep || !ep.ok) return true;
		}
		if (!anyEverOk && Date.now() - startedAt < config.settings.startupGraceMs) return true;
		return false;
	}

	/** Register an (empty) provider immediately so pi boots without waiting. */
	function registerEmptyProvider() {
		const first = config.servers.find((s) => s.enabled && s.ports.length > 0);
		try {
			pi.unregisterProvider(PROVIDER_NAME);
		} catch {
			// not registered yet
		}
		pi.registerProvider(PROVIDER_NAME, {
			name: "🦙 llama.cpp-infra (scanning…)",
			baseUrl: `http://${first?.host ?? "127.0.0.1"}:${first?.ports[0] ?? 8080}/v1`,
			apiKey: first?.apiKey || DEFAULT_API_KEY,
			api: "openai-completions",
			models: [],
		});
		providerIsEmpty = true;
	}

	/** One discovery pass: scan, register, update known-good tracking. */
	async function discoverAndRegister(): Promise<{ scan: ScanResult; shouldPoll: boolean }> {
		try {
			if (!extensionActive) return { scan: { endpoints: [], totalModels: 0, serversUp: 0, serversTotal: 0 }, shouldPoll: false };
			const scan = await scanAllServers(config);
			if (!extensionActive) return { scan, shouldPoll: false };
			lastScan = scan;

			// Skip redundant re-registers while polling: only rebuild when the
			// discovery signature changed or the provider is still empty.
			const signature = modelsSignature(scan.endpoints);
			const changed = signature !== lastSignature || providerIsEmpty;
			lastSignature = signature;
			if (!changed) {
				return { scan, shouldPoll: shouldContinuePolling(scan.endpoints, scan.endpoints.some((e) => e.loading)) };
			}

			const models = buildAndRegisterProvider(pi, scan, config);
			providerIsEmpty = models.length === 0;
			registeredCount = models.length;
			lastModels = models;
			lastError = undefined;
			debugLog(`discovery change: ${registeredCount} model(s), ${scan.serversUp}/${scan.serversTotal} servers up`);

			for (const ep of scan.endpoints) {
				const key = epKey(ep.host, ep.port);
				if (ep.ok) {
					anyEverOk = true;
					knownGood.add(key);
					consecutiveFails.delete(key);
				} else if (knownGood.has(key)) {
					const fails = (consecutiveFails.get(key) ?? 0) + 1;
					consecutiveFails.set(key, fails);
					if (fails >= config.settings.knownGoodFailLimit) {
						knownGood.delete(key);
						consecutiveFails.delete(key);
					}
				}
			}
			return { scan, shouldPoll: shouldContinuePolling(scan.endpoints, scan.endpoints.some((e) => e.loading)) };
		} catch (err) {
			if (extensionActive) lastError = err instanceof Error ? err.message : String(err);
			return { scan: { endpoints: [], totalModels: 0, serversUp: 0, serversTotal: 0 }, shouldPoll: false };
		}
	}

	/** Clock-bounded background polling while servers load / restart. */
	function schedulePolling(shouldPoll: boolean) {
		if (!extensionActive || !shouldPoll || polling) return;
		polling = true;
		const deadline = Date.now() + config.settings.pollMaxMs;
		const tick = async () => {
			if (!extensionActive) {
				polling = false;
				return;
			}
			if (Date.now() >= deadline) {
				polling = false;
				return;
			}
			const r = await discoverAndRegister();
			if (!extensionActive) {
				polling = false;
				return;
			}
			if (r.shouldPoll) {
				pollTimer = setTimeout(tick, config.settings.pollIntervalMs);
				pollTimer?.unref?.();
			} else {
				polling = false;
			}
		};
		pollTimer = setTimeout(tick, config.settings.pollIntervalMs);
		pollTimer?.unref?.();
	}

	function stopPolling() {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = undefined;
		polling = false;
	}

	/** Full rescan: reset polling, clear provider, discover, update footer. */
	async function rescan(ctx?: ExtensionContext) {
		if (!extensionActive) return;
		if (ctxHasUI(ctx)) ctx.ui.setStatus(STATUS_KEY, "🔎 scanning…");
		stopPolling();
		registerEmptyProvider();
		const r = await discoverAndRegister();
		if (!extensionActive) return;
		schedulePolling(r.shouldPoll);
		updateStatusFooter(ctx);
	}

	function updateStatusFooter(ctx?: ExtensionContext) {
		if (!ctxHasUI(ctx)) return;
		if (registeredCount > 0) {
			const up = lastScan?.serversUp ?? 0;
			const total = lastScan?.serversTotal ?? 0;
			ctx.ui.setStatus(STATUS_KEY, `🦙 ${registeredCount} models · ${up}/${total} ✓`);
		} else if (lastScan?.endpoints.some((e) => e.loading)) {
			ctx.ui.setStatus(STATUS_KEY, "⏳ loading…");
		} else if (lastError) {
			ctx.ui.setStatus(STATUS_KEY, "⚠️");
		} else {
			ctx.ui.setStatus(STATUS_KEY, "−");
		}
	}

	// ── Initial non-blocking registration ──────────────────────────
	registerEmptyProvider();
	void discoverAndRegister()
		.then((r) => {
			if (extensionActive) schedulePolling(r.shouldPoll);
		})
		.catch((err) => {
			if (extensionActive) debugLog(`initial discovery failed: ${err instanceof Error ? err.message : String(err)}`);
		});

	// ── Hook 0: compact registered id → raw server model id ─────────
	// Model ids registered in pi are compact display ids ("Name (host:port)");
	// llama.cpp-family servers expect the raw model path/alias they advertised
	// in /v1/models, so the payload model field is rewritten here. Registered
	// first so every later hook (and the server) sees the raw id.
	pi.on("before_provider_request", (event, _ctx) => {
		const payload = event.payload as Record<string, unknown>;
		const modelInPayload = typeof payload.model === "string" ? payload.model : undefined;
		if (!modelInPayload) return undefined;
		const raw = serverModelIds.get(modelInPayload);
		if (raw === undefined || raw === modelInPayload) return undefined;
		debugLog(`model id "${modelInPayload}" → "${raw}"`);
		return { ...payload, model: raw };
	});

	// ── Hook 1: ZINC payload workaround ────────────────────────────
	// ZINC rejects non-empty model ids and is picky about tool formats.
	function isZincModel(modelInPayload: unknown): boolean {
		if (typeof modelInPayload !== "string") return false;
		if (zincModelIds.has(modelInPayload)) return true;
		for (const zid of zincModelIds) {
			if (modelInPayload === zid || modelInPayload.includes(zid) || zid.includes(modelInPayload)) return true;
		}
		return false;
	}

	pi.on("before_provider_request", (event, _ctx) => {
		const payload = event.payload as Record<string, unknown>;
		if (!isZincModel(payload.model)) return undefined;

		const rawTools = payload.tools;
		const hasTools = "tools" in payload;
		const toolCount = Array.isArray(rawTools) ? rawTools.length : 0;
		debugLog(`ZINC model detected ("${payload.model}") → rewriting payload`);

		const newPayload: Record<string, unknown> = { ...payload, model: "" };

		if (hasTools && toolCount > 0 && newPayload.tool_choice === undefined) {
			newPayload.tool_choice = "auto";
		}

		if (Array.isArray(rawTools)) {
			newPayload.tools = rawTools.map((tool: any) => {
				// Normalize to {type:"function", function:{...}} and drop "strict".
				if (tool?.type === "function" && tool?.function) {
					const cleaned: any = { type: "function", function: { ...tool.function } };
					delete cleaned.function.strict;
					return cleaned;
				}
				if (tool?.name) {
					const fn: any = { name: tool.name };
					if (tool.description) fn.description = tool.description;
					if (tool.parameters) fn.parameters = tool.parameters;
					delete (fn as any).strict;
					return { type: "function", function: fn };
				}
				return tool;
			});
		}

		return newPayload;
	});

	// ── Hook 2: per-model thinking budget (llama.cpp thinking_budget_tokens) ──
	// pi injects thinking_token budgets from its global settings; this hook
	// overrides the value with the per-model budgets configured for this model.
	// Registered after the ZINC hook so it sees the final payload. Hook 0 has
	// already rewritten the payload model to the raw server id, so both raw
	// and compact ids are resolved against the registered model maps.
	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as Record<string, unknown>;
		const modelId = typeof payload.model === "string" ? payload.model : undefined;
		if (!modelId) return undefined;
		const compactKey = compactModelIds.get(modelId) ?? modelId;
		const baseUrl = modelBaseUrls.get(compactKey);
		if (!supportsThinkingBudget(endpointKinds.get(baseUrl ?? "") as ServerKind | undefined)) return undefined;
		const budgets = config.modelOptions[compactKey]?.thinkingBudgets;
		if (!budgets) return undefined;
		const level = normalizeLevel(ctx.thinkingLevel ?? currentThinkingLevel);
		if (!level) return undefined;
		const value = budgets[level];
		if (typeof value !== "number") return undefined;
		debugLog(`thinking budget for ${compactKey} [${level}] = ${value}`);
		return { ...payload, [THINKING_BUDGET_FIELD]: value };
	});

	function normalizeLevel(level: string | undefined): "minimal" | "low" | "medium" | "high" | undefined {
		switch (level) {
			case "minimal":
			case "low":
			case "medium":
			case "high":
				return level;
			case "xhigh":
			case "max":
				return "high"; // pi clamps xhigh/max to high as well
			default:
				return undefined; // "off" / unset → no budget
		}
	}

	// ── Hook 3: header warmup capture (runs last, sees final payload) ──
	// Templates are keyed by the compact registered id (the same id passed to
	// warmupForModel); PromptWarmer re-resolves the raw server id per request.
	pi.on("before_provider_request", (event, ctx) => {
		if (!config.settings.warmup) return undefined;
		const payload = event.payload as Record<string, unknown>;
		const modelId = typeof payload?.model === "string" ? payload.model : undefined;
		const compactKey = modelId ? (compactModelIds.get(modelId) ?? modelId) : undefined;
		const baseUrl = compactKey ? modelBaseUrls.get(compactKey) : undefined;
		const capturePayload = compactKey ? { ...payload, model: compactKey } : payload;
		warmer.onProviderPayload(capturePayload, baseUrl, ctx.cwd);
		return undefined;
	});

	// ── Command: /llamacpp-infra ───────────────────────────────────
	pi.registerCommand("llamacpp-infra", {
		description: "llama.cpp-infra: discover llama.cpp/ZINC/DwarfStar/LM Studio models on any machine (config, scan, metrics…)",
		getArgumentCompletions: (prefix) =>
			["config", "scan", "status", "list", "metrics", "help"]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			switch (sub) {
				case "":
				case "status":
					await showStatus(ctx);
					break;
				case "config":
					await showConfigMenu(ctx);
					break;
				case "scan":
					await rescan(ctx);
					ctx.ui.notify("🔎 llama.cpp-infra: scan complete", "info");
					break;
				case "list":
					await showModelList(ctx);
					break;
				case "metrics":
					await toggleMetrics(ctx);
					break;
				case "help":
					showHelp(ctx);
					break;
				default:
					ctx.ui.notify(`❓ Unknown subcommand "${sub}". Try /llamacpp-infra help`, "warning");
			}
		},
	});

	async function toggleMetrics(ctx: ExtensionContext) {
		config.settings.metricsEnabled = !config.settings.metricsEnabled;
		saveConfig(config);
		if (config.settings.metricsEnabled) {
			startMetricsPolling(ctx);
			ctx.ui.notify("📊 Metrics widget enabled", "info");
		} else {
			stopMetricsPolling(ctx);
			ctx.ui.notify("📊 Metrics widget disabled", "info");
		}
	}

	// ── Status report ──────────────────────────────────────────────
	function metadataBadges(m: ModelMetadata | undefined): string {
		if (!m) return "";
		const parts: string[] = [];
		if (m.quant) parts.push(`🗜️ ${m.quant}`);
		if (m.cacheK || m.cacheV) parts.push(`🧠 KV ${m.cacheK ?? "?"}/${m.cacheV ?? m.cacheK ?? "?"}`);
		if (m.vision) parts.push("👁️ vision");
		if (m.drafter) parts.push(`🚀 ${m.drafter}`);
		return parts.length > 0 ? ` — ${parts.join(" · ")}` : "";
	}

	async function showStatus(ctx: ExtensionContext) {
		if (!lastScan) {
			ctx.ui.notify("🦙 llama.cpp-infra: still scanning, try again in a moment…", "info");
			return;
		}
		const lines: string[] = [];
		lines.push(`🦙 llama.cpp-infra — ${lastScan.totalModels} model(s) · ${lastScan.serversUp}/${lastScan.serversTotal} servers up`);
		lines.push("");
		for (const srv of config.servers) {
			if (!srv.enabled) {
				lines.push(`⛔ ${serverLabel(srv)} (${srv.host}) — disabled`);
				continue;
			}
			const eps = lastScan.endpoints.filter((e) => e.serverId === srv.id);
			const okEps = eps.filter((e) => e.ok);
			if (okEps.length === 0) {
				const loading = eps.find((e) => e.loading);
				const err = eps.find((e) => e.error)?.error;
				lines.push(loading ? `⏳ ${serverLabel(srv)} (${srv.host}) — model loading…` : `🔴 ${serverLabel(srv)} (${srv.host}) — offline${err ? ` (${err.slice(0, 60)})` : ""}`);
				continue;
			}
			const kinds = new Map<string, number>();
			for (const e of okEps) for (const _m of e.models) kinds.set(e.server, (kinds.get(e.server) ?? 0) + 1);
			const kindStr = [...kinds.entries()].map(([k, n]) => `${k} ×${n}`).join(", ");
			const models = okEps.reduce((a, e) => a + e.models.length, 0);
			lines.push(`🟢 ${serverLabel(srv)} (${srv.host}) — ${models} model(s) [${kindStr}]`);
			for (const e of okEps.sort((a, b) => a.port - b.port)) {
				const mode = e.mode === "router" ? " · 🌐 router mode" : e.mode === "single" ? " · single" : "";
				lines.push(`   • :${e.port} → ${e.models.length} model(s) · ${e.server}${mode} · ${e.latencyMs ?? "?"}ms`);
			}
		}
		if (lastError) lines.push("", `⚠️ Last error: ${lastError}`);
		ctx.ui.notify(lines.join("\n"), "info");
	}

	async function showModelList(ctx: ExtensionContext) {
		if (lastModels.length === 0) {
			ctx.ui.notify("🦙 llama.cpp-infra: no models discovered. Try /llamacpp-infra scan", "warning");
			return;
		}
		// Endpoint info (kind/mode) indexed by baseUrl.
		const epByBaseUrl = new Map<string, EndpointResult>();
		for (const ep of lastScan?.endpoints ?? []) epByBaseUrl.set(ep.baseUrl, ep);
		// Metadata is keyed by raw id inside each endpoint.
		const metaFor = (m: PiModel): ModelMetadata | undefined => {
			const ep = epByBaseUrl.get(m.baseUrl);
			if (!ep) return undefined;
			// Find the raw entry whose registered id ends with the raw id fragment.
			for (const [rawId, meta] of ep.meta) {
				if (m.serverModelId === rawId || m.id === rawId) return meta;
			}
			return undefined;
		};

		const lines: string[] = [`🦙 llama.cpp-infra — ${lastModels.length} discovered`, ""];
		for (const m of lastModels) {
			const ep = epByBaseUrl.get(m.baseUrl);
			const where = ep ? `${ep.label}:${ep.port} (${ep.server}${ep.mode === "router" ? ", router" : ""})` : m.baseUrl;
			const meta = metaFor(m);
			const md = metadataBadges({
				quant: m.quant ?? meta?.quant,
				cacheK: m.cacheK ?? meta?.cacheK,
				cacheV: m.cacheV ?? meta?.cacheV,
				vision: m.input.includes("image") || meta?.vision,
				drafter: m.drafter ?? meta?.drafter,
				routerStatus: m.routerStatus ?? meta?.routerStatus,
			});
			const ctxWin = formatCtx(m.contextWindow);
			const status = m.routerStatus && m.routerStatus !== "loaded" ? ` · [${m.routerStatus}]` : "";
			lines.push(`   • ${m.name}`, `     ${m.id} — ${where}${md} · ctx ${ctxWin || "?"}${status}`);
		}
		ctx.ui.notify(lines.join("\n"), "info");
	}

	function showHelp(ctx: ExtensionContext) {
		ctx.ui.notify(
			[
				"🦙 llama.cpp-infra — models served by llama.cpp & variants (ZINC, DwarfStar/ds4, lucebox, LM Studio) on any machine",
				"",
				"  /llamacpp-infra            → quick status",
				"  /llamacpp-infra config     → ⚙️ configure servers, budgets & settings",
				"  /llamacpp-infra scan       → 🔎 rescan all servers now",
				"  /llamacpp-infra status     → 📊 detailed per-endpoint report",
				"  /llamacpp-infra list       → 📋 models with quant/vision/drafter/cache info",
				"  /llamacpp-infra metrics    → 📈 toggle the live throughput widget",
				"",
				`Config file: ${getConfigPath()}`,
			].join("\n"),
			"info",
		);
	}

	// ── Configuration UI ───────────────────────────────────────────

	async function showConfigMenu(ctx: ExtensionContext) {
		for (;;) {
			const budgetCount = Object.values(config.modelOptions).filter((o) => o.thinkingBudgets).length;
			const action = await selectFrom(ctx, "🦙 llama.cpp-infra — Configuration", [
				{ value: "servers", label: "🌐 Servers", description: `${config.servers.filter((s) => s.enabled).length}/${config.servers.length} enabled · manage machines & ports` },
				{ value: "scan", label: "🔍 Scan now", description: "Rediscover models on all enabled servers" },
				{ value: "models", label: "📋 Discovered models", description: `${registeredCount} currently registered in /model` },
				{ value: "test", label: "🧪 Test connectivity", description: "Probe every endpoint and show latency" },
				{ value: "budgets", label: "🧠 Thinking budgets", description: `${budgetCount} model(s) with per-model budgets (llama.cpp thinking_budget_tokens)` },
				{ value: "metrics", label: `📈 Live metrics: ${config.settings.metricsEnabled ? "ON" : "OFF"}`, description: `throughput widget · poll ${formatMs(config.settings.metricsPollMs)}` },
				{ value: "settings", label: "⚙️ Discovery settings", description: "Timeouts, polling, vision, badges…" },
				{ value: "about", label: "ℹ️ About", description: "How this extension works" },
				{ value: "close", label: "🚪 Close", description: "" },
			]);
			if (action === undefined || action === "close") return;
			switch (action) {
				case "servers":
					await showServersMenu(ctx);
					break;
				case "scan":
					await rescan(ctx);
					ctx.ui.notify("🔎 Scan complete", "info");
					break;
				case "models":
					await showModelList(ctx);
					break;
				case "test":
					await testConnectivity(ctx);
					break;
				case "budgets":
					await showThinkingBudgetsMenu(ctx);
					break;
				case "metrics":
					await toggleMetricsMenu(ctx);
					break;
				case "settings":
					await showSettingsMenu(ctx);
					break;
				case "about":
					ctx.ui.notify(
						[
							"🦙 llama.cpp-infra",
							"",
							"Discovers models served by llama.cpp (single & router/multi-model),",
							"ZINC, DwarfStar (ds4-server), lucebox and LM Studio on any number",
							"of machines, and registers them into pi's native /model list.",
							"",
							"Models appear as compact ids: \"Name (host:port)\" — the raw GGUF",
							"path/alias is sent to the server automatically on every request.",
							"LM Studio uses its OpenAI-compatible /v1 endpoint and enriches",
							"metadata from /api/v1/models (or legacy /api/v0/models).",
							"Per-model metadata: vision, drafter, model quant, KV cache quant.",
							"Per-model thinking budgets via llama.cpp thinking_budget_tokens.",
							"Live throughput metrics from each server's /metrics endpoint when exposed.",
							"",
							`Config: ${getConfigPath()}`,
						].join("\n"),
						"info",
					);
					break;
			}
		}
	}

	async function showServersMenu(ctx: ExtensionContext) {
		for (;;) {
			const items: Array<{ value: string; label: string; description?: string }> = [];
			for (const srv of config.servers) {
				const state = !srv.enabled ? "⛔" : isServerUp(srv.id) ? "🟢" : "🔴";
				const models = countServerModels(srv.id);
				items.push({
					value: srv.id,
					label: `${state} ${serverLabel(srv)}`,
					description: `${srv.host} · ${srv.ports.length} port(s)${srv.enabled ? ` · ${models} model(s)` : " · disabled"}`,
				});
			}
			items.push({ value: "__add", label: "➕ Add server", description: "Register a new machine (host + ports)" });
			items.push({ value: "__back", label: "← Back", description: "" });

			const picked = await selectFrom(ctx, "🌐 Servers — select to edit", items);
			if (picked === undefined || picked === "__back") return;
			if (picked === "__add") {
				await addServerFlow(ctx);
				continue;
			}
			const srv = config.servers.find((s) => s.id === picked);
			if (srv) await showServerMenu(ctx, srv);
		}
	}

	function isServerUp(serverId: string): boolean {
		return lastScan?.endpoints.some((e) => e.serverId === serverId && e.ok) ?? false;
	}

	function countServerModels(serverId: string): number {
		return lastScan?.endpoints.filter((e) => e.serverId === serverId).reduce((a, e) => a + (e.ok ? e.models.length : 0), 0) ?? 0;
	}

	async function showServerMenu(ctx: ExtensionContext, srv: ServerConfig) {
		for (;;) {
			const state = !srv.enabled ? "⛔ disabled" : isServerUp(srv.id) ? "🟢 online" : "🔴 offline";
			const action = await selectFrom(
				ctx,
				`🖥️ ${serverLabel(srv)} — ${srv.host} · ${state}`,
				[
					{ value: "host", label: "✏️ Change host", description: `currently: ${srv.host}` },
					{ value: "label", label: "🏷️ Change label", description: `currently: ${serverLabel(srv)}` },
					{ value: "ports", label: "🔌 Edit ports", description: `currently: ${srv.ports.join(", ")}` },
					{
						value: "toggle",
						label: srv.enabled ? "🔴 Disable server" : "🟢 Enable server",
						description: srv.enabled ? "stop probing this machine" : "start probing this machine",
					},
					{
						value: "ds4",
						label: `🕵️ ds4 (DwarfStar) probe: ${srv.probeDs4 ? "ON" : "OFF"}`,
						description: "ping /v1/chat/completions when /v1/models fails",
					},
					{
						value: "key",
						label: srv.apiKey ? "🔑 API key: set" : "🔑 API key: none",
						description: srv.apiKey ? "clear or replace bearer token" : "optional, for authenticated endpoints",
					},
					{ value: "test", label: "🧪 Test this server", description: `probe ${srv.ports.length} port(s) now` },
					{ value: "delete", label: "🗑️ Delete server", description: "remove from configuration" },
					{ value: "__back", label: "← Back", description: "" },
				],
			);
			if (action === undefined || action === "__back") return;

			switch (action) {
				case "host": {
					const host = await ctx.ui.input("✏️ New host (IP or hostname)", srv.host);
					if (host === undefined) break;
					const trimmed = host.trim();
					if (!trimmed) {
						ctx.ui.notify("❌ Host cannot be empty", "error");
						break;
					}
					srv.host = trimmed;
					saveConfig(config);
					ctx.ui.notify(`✅ Host updated: ${srv.host}`, "info");
					await rescan(ctx);
					break;
				}
				case "label": {
					const label = await ctx.ui.input("🏷️ Label for menus", serverLabel(srv));
					if (label === undefined) break;
					srv.label = label.trim();
					saveConfig(config);
					ctx.ui.notify(`✅ Label updated: ${serverLabel(srv)}`, "info");
					break;
				}
				case "ports": {
					const raw = await ctx.ui.input("🔌 Ports (e.g. 8000, 8080-8082)", srv.ports.join(", "));
					if (raw === undefined) break;
					const ports = parsePorts(raw);
					if (!ports) {
						ctx.ui.notify("❌ No valid ports in input", "error");
						break;
					}
					srv.ports = ports;
					saveConfig(config);
					ctx.ui.notify(`✅ Ports updated: ${ports.join(", ")}`, "info");
					await rescan(ctx);
					break;
				}
				case "toggle":
					srv.enabled = !srv.enabled;
					saveConfig(config);
					ctx.ui.notify(`${srv.enabled ? "🟢 Enabled" : "🔴 Disabled"}: ${serverLabel(srv)}`, "info");
					await rescan(ctx);
					break;
				case "ds4":
					srv.probeDs4 = !srv.probeDs4;
					saveConfig(config);
					ctx.ui.notify(`🕵️ ds4 (DwarfStar) probe ${srv.probeDs4 ? "ON" : "OFF"} for ${serverLabel(srv)}`, "info");
					await rescan(ctx);
					break;
				case "key": {
					if (srv.apiKey) {
						const clear = await ctx.ui.confirm("🔑 API key", `A key is set for ${serverLabel(srv)}. Clear it?`);
						if (clear) {
							delete srv.apiKey;
							saveConfig(config);
							ctx.ui.notify("🔑 API key cleared", "info");
							await rescan(ctx);
						}
					} else {
						const key = await ctx.ui.input("🔑 API key (bearer token)", "sk-…");
						if (key === undefined) break;
						const trimmed = key.trim();
						if (!trimmed) break;
						srv.apiKey = trimmed;
						saveConfig(config);
						ctx.ui.notify("🔑 API key saved", "info");
						await rescan(ctx);
					}
					break;
				}
				case "test": {
					ctx.ui.setStatus(STATUS_KEY, "🧪 testing…");
					const localServers = config.settings.detectVision ? scanLocalServers() : new Map<number, LocalServerInfo>();
					const results = await Promise.all(
						srv.ports.map((port) => fetchModelsFromEndpoint(srv, port, config.settings, localServers)),
					);
					const lines = [`🧪 ${serverLabel(srv)} (${srv.host}) — ${results.filter((r) => r.ok).length}/${results.length} endpoints up`, ""];
					for (const r of results.sort((a, b) => a.port - b.port)) {
						if (r.ok) {
							const mode = r.mode === "router" ? " · router" : "";
							lines.push(`✅ :${r.port} — ${r.models.length} model(s) · ${r.server}${mode} · ${r.latencyMs ?? "?"}ms`);
						} else if (r.loading) {
							lines.push(`⏳ :${r.port} — loading model…`);
						} else {
							lines.push(`❌ :${r.port} — ${r.error?.slice(0, 70) ?? "unreachable"}`);
						}
					}
					ctx.ui.notify(lines.join("\n"), "info");
					updateStatusFooter(ctx);
					break;
				}
				case "delete": {
					const sure = await ctx.ui.confirm(
						"🗑️ Delete server",
						`Remove "${serverLabel(srv)}" (${srv.host}) from the configuration?`,
					);
					if (sure) {
						config.servers = config.servers.filter((s) => s.id !== srv.id);
						saveConfig(config);
						ctx.ui.notify(`🗑️ Deleted: ${serverLabel(srv)}`, "info");
						await rescan(ctx);
						return; // server no longer exists — leave its menu
					}
					break;
				}
			}
		}
	}

	async function addServerFlow(ctx: ExtensionContext) {
		const host = await ctx.ui.input("➕ Add server — host (IP or tailnet name)", "e.g. 192.168.1.20 or mybox");
		if (host === undefined) return;
		const trimmedHost = host.trim();
		if (!trimmedHost) {
			ctx.ui.notify("❌ Host cannot be empty", "error");
			return;
		}
		if (config.servers.some((s) => s.host === trimmedHost)) {
			ctx.ui.notify(`⚠️ A server with host "${trimmedHost}" already exists`, "warning");
			return;
		}
		const portsRaw = await ctx.ui.input("➕ Ports to probe", "e.g. 1234, 8000, 8080-8082");
		if (portsRaw === undefined) return;
		const ports = parsePorts(portsRaw);
		if (!ports) {
			ctx.ui.notify("❌ No valid ports in input", "error");
			return;
		}
		const label = await ctx.ui.input("🏷️ Label (optional)", trimmedHost);
		if (label === undefined) return;
		const probeDs4 = await ctx.ui.confirm("🕵️ ds4 (DwarfStar) probe?", "Enable the chat-completions ping probe for this machine? (for DwarfStar/ds4-server hosts; not needed for LM Studio)");

		let id = idSafeHost(trimmedHost).replace(/[^a-z0-9.-]/g, "-");
		let n = 2;
		while (config.servers.some((s) => s.id === id)) id = `${idSafeHost(trimmedHost).replace(/[^a-z0-9.-]/g, "-")}-${n++}`;

		config.servers.push({ id, host: trimmedHost, label: label.trim() || undefined, ports, enabled: true, probeDs4 });
		saveConfig(config);
		ctx.ui.notify(`➕ Server added: ${label.trim() || trimmedHost} (${trimmedHost}) — ports ${ports.join(", ")}`, "info");
		await rescan(ctx);
	}

	// ── Thinking budgets menu ──────────────────────────────────────

	function budgetsSummary(b?: ThinkingBudgets): string {
		if (!b) return "none";
		const parts: string[] = [];
		for (const [k, v] of Object.entries(b)) {
			if (typeof v === "number") parts.push(`${k}: ${v}`);
		}
		return parts.length > 0 ? parts.join(", ") : "none";
	}

	async function showThinkingBudgetsMenu(ctx: ExtensionContext) {
		for (;;) {
			const entries = Object.entries(config.modelOptions).filter(([, o]) => o.thinkingBudgets);
			const items: Array<{ value: string; label: string; description?: string }> = [];
			// Models currently discovered first (easy to pick), then configured-only ones.
			for (const m of lastModels) {
				const opts = config.modelOptions[m.id];
				items.push({
					value: m.id,
					label: `🧠 ${m.name}`,
					description: budgetsSummary(opts?.thinkingBudgets),
				});
			}
			for (const [id, opts] of entries) {
				if (lastModels.some((m) => m.id === id)) continue;
				items.push({ value: id, label: `🧠 ${id}`, description: `${budgetsSummary(opts.thinkingBudgets)} (not currently online)` });
			}
			if (items.length === 0) {
				const info = await ctx.ui.confirm(
					"🧠 Thinking budgets",
					"No models discovered yet. Models are scanned at startup — run /llamacpp-infra scan first, then come back. Open help?",
				);
				if (info) showHelp(ctx);
				return;
			}
			items.push({ value: "__back", label: "← Back", description: "" });
			const picked = await selectFrom(ctx, "🧠 Thinking budgets — pick a model", items);
			if (picked === undefined || picked === "__back") return;
			const changed = await editModelBudgets(ctx, picked);
			if (changed) {
				saveConfig(config);
				ctx.ui.notify("🧠 Thinking budgets saved — re-registering models", "info");
				await rescan(ctx);
			}
		}
	}

	async function editModelBudgets(ctx: ExtensionContext, modelId: string): Promise<boolean> {
		let changed = false;
		for (;;) {
			const opts = (config.modelOptions[modelId] ??= {});
			opts.thinkingBudgets ??= {};
			const b = opts.thinkingBudgets;
			const action = await selectFrom(ctx, `🧠 Budgets for ${modelId}`, [
				{ value: "minimal", label: `minimal: ${b.minimal ?? "—"}`, description: "pi thinking level → llama.cpp thinking_budget_tokens" },
				{ value: "low", label: `low: ${b.low ?? "—"}`, description: "" },
				{ value: "medium", label: `medium: ${b.medium ?? "—"}`, description: "" },
				{ value: "high", label: `high: ${b.high ?? "—"}`, description: "xhigh/max clamp to this value" },
				{ value: "clear", label: "🗑️ Clear all budgets for this model", description: "" },
				{ value: "__back", label: "← Back", description: "" },
			]);
			if (action === undefined || action === "__back") return changed;

			if (action === "clear") {
				delete config.modelOptions[modelId];
				ctx.ui.notify(`🗑️ Budgets cleared for ${modelId}`, "info");
				return true;
			}

			const current = b[action as keyof ThinkingBudgets];
			const value = await selectFrom(ctx, `🧠 ${action} budget (tokens)`, [
				...(current !== undefined ? [{ value: -1, label: "❌ Clear this level", description: "fall back to pi's global budget" }] : []),
				{ value: 512, label: "512" },
				{ value: 1024, label: "1,024" },
				{ value: 2048, label: "2,048" },
				{ value: 4096, label: "4,096" },
				{ value: 8192, label: "8,192" },
				{ value: 16384, label: "16,384" },
				{ value: 32768, label: "32,768" },
				{ value: 65536, label: "65,536" },
				{ value: -2, label: "✏️ Custom value…", description: "enter any token count" },
			]);
			if (value === undefined) continue;
			if (value === -1) {
				delete b[action as keyof ThinkingBudgets];
				changed = true;
				ctx.ui.notify(`❌ ${action} budget cleared`, "info");
			} else if (value === -2) {
				const raw = await ctx.ui.input("✏️ Custom budget (tokens)", String(current ?? 4096));
				if (raw === undefined) continue;
				const parsed = parseInt(raw.trim(), 10);
				if (isNaN(parsed) || parsed < 0) {
					ctx.ui.notify("❌ Invalid token count", "error");
					continue;
				}
				b[action as keyof ThinkingBudgets] = parsed;
				changed = true;
				ctx.ui.notify(`🧠 ${action} budget = ${parsed}`, "info");
			} else {
				b[action as keyof ThinkingBudgets] = value;
				changed = true;
				ctx.ui.notify(`🧠 ${action} budget = ${value}`, "info");
			}
			if (Object.keys(b).length === 0) delete opts.thinkingBudgets;
		}
	}

	// ── Metrics menu ───────────────────────────────────────────────

	async function toggleMetricsMenu(ctx: ExtensionContext) {
		for (;;) {
			const action = await selectFrom(ctx, "📈 Live metrics", [
				{ value: "toggle", label: config.settings.metricsEnabled ? "🔴 Disable metrics widget" : "🟢 Enable metrics widget", description: "auto-shows for llamacpp-infra models" },
				{ value: "interval", label: `🔁 Poll interval: ${formatMs(config.settings.metricsPollMs)}`, description: "how often /metrics is fetched" },
				{ value: "__back", label: "← Back", description: "" },
			]);
			if (action === undefined || action === "__back") return;
			if (action === "toggle") {
				await toggleMetrics(ctx);
			} else if (action === "interval") {
				const v = await selectFrom(ctx, "🔁 Metrics poll interval", [2000, 3000, 5000, 10_000, 15_000].map((ms) => ({ value: ms, label: formatMs(ms) })));
				if (v !== undefined) {
					config.settings.metricsPollMs = v;
					saveConfig(config);
					stopMetricsPolling(ctx);
					if (config.settings.metricsEnabled) startMetricsPolling(ctx);
					ctx.ui.notify(`🔁 Metrics poll interval: ${formatMs(v)}`, "info");
				}
			}
		}
	}

	// ── Settings menu ──────────────────────────────────────────────

	async function showSettingsMenu(ctx: ExtensionContext) {
		for (;;) {
			const s = config.settings;
			const action = await selectFrom(ctx, "⚙️ Discovery settings", [
				{ value: "timeout", label: `⏱️ Discovery timeout: ${formatMs(s.discoveryTimeoutMs)}`, description: "per-request timeout when probing endpoints" },
				{ value: "interval", label: `🔁 Poll interval: ${formatMs(s.pollIntervalMs)}`, description: "background re-poll while servers load models" },
				{ value: "budget", label: `⏳ Poll budget: ${formatMs(s.pollMaxMs)}`, description: "max total time the background poller runs" },
				{ value: "grace", label: `🌅 Startup grace: ${formatMs(s.startupGraceMs)}`, description: "keep trying at startup while nothing has answered" },
				{ value: "faillimit", label: `💀 Known-good fail limit: ${s.knownGoodFailLimit}`, description: "consecutive failures before a live endpoint is dropped" },
				{ value: "vision", label: `👁️ Vision detection: ${s.detectVision ? "ON" : "OFF"}`, description: "/proc flags + server-reported modalities" },
				{ value: "prefix", label: `🏷️ Prefix model IDs: ${s.prefixModelIds ? "ON" : "OFF"}`, description: 'ids like "host:8081/model" avoid cross-server collisions' },
				{ value: "badges", label: `🏷️ Name badges: ${s.showBadgesInNames ? "ON" : "OFF"}`, description: "append 👁️🚀💤 badges to model names" },
				{ value: "unloaded", label: `💤 Include unloaded router models: ${s.includeUnloadedRouterModels ? "ON" : "OFF"}`, description: "router mode: list models that are not loaded" },
				{ value: "warmup", label: `☕ Header warmup: ${s.warmup ? "ON" : "OFF"}`, description: "pre-cache the system prompt on llama.cpp-family servers" },
				{ value: "reset", label: "♻️ Reset all settings to defaults", description: "" },
				{ value: "__back", label: "← Back", description: "" },
			]);
			if (action === undefined || action === "__back") return;

			const pickNumber = async (title: string, options: number[]): Promise<number | undefined> => {
				return selectFrom(ctx, title, options.map((v) => ({ value: v, label: v >= 1000 ? formatMs(v) : `${v}` })));
			};

			switch (action) {
				case "timeout": {
					const v = await pickNumber("⏱️ Discovery timeout", [500, 1000, 1500, 2000, 3000, 5000]);
					if (v !== undefined) {
						config.settings.discoveryTimeoutMs = v;
						saveConfig(config);
						ctx.ui.notify(`⏱️ Discovery timeout: ${formatMs(v)}`, "info");
					}
					break;
				}
				case "interval": {
					const v = await pickNumber("🔁 Poll interval", [2000, 3000, 4000, 5000, 10_000]);
					if (v !== undefined) {
						config.settings.pollIntervalMs = v;
						saveConfig(config);
						ctx.ui.notify(`🔁 Poll interval: ${formatMs(v)}`, "info");
					}
					break;
				}
				case "budget": {
					const v = await pickNumber("⏳ Poll budget", [30_000, 60_000, 90_000, 120_000, 300_000]);
					if (v !== undefined) {
						config.settings.pollMaxMs = v;
						saveConfig(config);
						ctx.ui.notify(`⏳ Poll budget: ${formatMs(v)}`, "info");
					}
					break;
				}
				case "grace": {
					const v = await pickNumber("🌅 Startup grace", [10_000, 20_000, 40_000, 60_000, 120_000]);
					if (v !== undefined) {
						config.settings.startupGraceMs = v;
						saveConfig(config);
						ctx.ui.notify(`🌅 Startup grace: ${formatMs(v)}`, "info");
					}
					break;
				}
				case "faillimit": {
					const v = await pickNumber("💀 Known-good fail limit", [1, 2, 3, 5, 10]);
					if (v !== undefined) {
						config.settings.knownGoodFailLimit = v;
						saveConfig(config);
						ctx.ui.notify(`💀 Known-good fail limit: ${v}`, "info");
					}
					break;
				}
				case "vision":
					config.settings.detectVision = !config.settings.detectVision;
					saveConfig(config);
					ctx.ui.notify(`👁️ Vision detection ${config.settings.detectVision ? "ON" : "OFF"}`, "info");
					await rescan(ctx);
					break;
				case "prefix": {
					if (config.settings.prefixModelIds) {
						const ok = await ctx.ui.confirm(
							"🏷️ Prefix model IDs",
							"Turning the prefix OFF may cause ID collisions when the same model is served on several machines. Continue?",
						);
						if (!ok) break;
					}
					config.settings.prefixModelIds = !config.settings.prefixModelIds;
					saveConfig(config);
					ctx.ui.notify(`🏷️ Prefix model IDs ${config.settings.prefixModelIds ? "ON" : "OFF"}`, "info");
					await rescan(ctx);
					break;
				}
				case "badges":
					config.settings.showBadgesInNames = !config.settings.showBadgesInNames;
					saveConfig(config);
					ctx.ui.notify(`🏷️ Name badges ${config.settings.showBadgesInNames ? "ON" : "OFF"}`, "info");
					await rescan(ctx);
					break;
				case "unloaded":
					config.settings.includeUnloadedRouterModels = !config.settings.includeUnloadedRouterModels;
					saveConfig(config);
					ctx.ui.notify(`💤 Include unloaded router models ${config.settings.includeUnloadedRouterModels ? "ON" : "OFF"}`, "info");
					await rescan(ctx);
					break;
				case "warmup":
					config.settings.warmup = !config.settings.warmup;
					saveConfig(config);
					ctx.ui.notify(`☕ Header warmup ${config.settings.warmup ? "ON" : "OFF"}`, "info");
					break;
				case "reset": {
					const ok = await ctx.ui.confirm("♻️ Reset settings", "Restore all discovery settings to their defaults?");
					if (ok) {
						config.settings = { ...DEFAULT_SETTINGS };
						saveConfig(config);
						ctx.ui.notify("♻️ Settings reset to defaults", "info");
						await rescan(ctx);
					}
					break;
				}
			}
		}
	}

	async function testConnectivity(ctx: ExtensionContext) {
		const enabled = config.servers.filter((s) => s.enabled && s.ports.length > 0);
		if (enabled.length === 0) {
			ctx.ui.notify("🧪 No enabled servers to test", "warning");
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, "🧪 testing…");
		const localServers = config.settings.detectVision ? scanLocalServers() : new Map<number, LocalServerInfo>();
		const all: EndpointResult[] = [];
		for (const srv of enabled) {
			const results = await Promise.all(srv.ports.map((port) => fetchModelsFromEndpoint(srv, port, config.settings, localServers)));
			all.push(...results);
		}
		const lines: string[] = ["🧪 Connectivity report", ""];
		for (const srv of enabled) {
			const eps = all.filter((e) => e.serverId === srv.id).sort((a, b) => a.port - b.port);
			const up = eps.filter((e) => e.ok).length;
			lines.push(`${up === eps.length ? "🟢" : up > 0 ? "🟡" : "🔴"} ${serverLabel(srv)} (${srv.host}) — ${up}/${eps.length}`);
			for (const e of eps) {
				if (e.ok) lines.push(`   ✅ :${e.port} — ${e.models.length} model(s) · ${e.server}${e.mode === "router" ? " (router)" : ""} · ${e.latencyMs ?? "?"}ms`);
				else if (e.loading) lines.push(`   ⏳ :${e.port} — loading model…`);
				else lines.push(`   ❌ :${e.port} — ${e.error?.slice(0, 70) ?? "unreachable"}`);
			}
		}
		ctx.ui.notify(lines.join("\n"), "info");
		updateStatusFooter(ctx);
	}

	// ── Events ─────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (ctxHasUI(ctx)) warmupStatus.bind(ctx.ui);
		if (config.settings.warmup) warmer.warmupForModel(ctx.model, safeSystemPrompt(ctx), ctx.cwd);
		currentThinkingLevel = ctx.thinkingLevel;
		// Metrics poller starts unconditionally: each tick re-checks the active
		// model and stays idle (no HTTP) while it is not ours. This covers the
		// race where session_start fires before discovery has registered models.
		if (config.settings.metricsEnabled) startMetricsPolling(ctx);
		if (!ctxHasUI(ctx)) return;
		// Re-scan in the background: models that finished loading appear on
		// their own, without needing /llamacpp-infra scan.
		void discoverAndRegister()
			.then((r) => {
				if (!extensionActive) return;
				schedulePolling(r.shouldPoll);
				updateStatusFooter(ctx);
			})
			.catch((err) => {
				if (!extensionActive) return;
				lastError = err instanceof Error ? err.message : String(err);
				updateStatusFooter(ctx);
			});
	});

	pi.on("model_select", (event, ctx) => {
		if (event.model.provider !== PROVIDER_NAME) {
			stopMetricsPolling(ctx);
			return;
		}
		if (ctxHasUI(ctx)) warmupStatus.bind(ctx.ui);
		if (config.settings.warmup) warmer.warmupForModel(event.model, safeSystemPrompt(ctx), ctx.cwd);
		// New endpoint → reset metrics state and (re)start polling.
		metricsCurrentKey = undefined;
		metricsPrev.clear();
		metricsCurrentApiKey = undefined;
		if (config.settings.metricsEnabled) startMetricsPolling(ctx);
	});

	pi.on("thinking_level_select", (event, _ctx) => {
		currentThinkingLevel = event.level;
	});

	pi.on("session_shutdown", () => {
		extensionActive = false;
		stopPolling();
		stopMetricsPolling();
		warmer.dispose();
		warmupStatus.dispose();
	});
}
