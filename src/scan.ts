// Discovery engine: probes /v1/models + /props + LM Studio REST + /proc scan,
// classifies server kind, and computes per-model metadata. All functions are
// module-level (no shared closure) — easy to lazy-load.

import * as http from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { baseName, isLocalHost, serverLabel, shared } from "./core.ts";
import type {
	EndpointResult,
	HttpResult,
	LlamaCppModel,
	LlamaCppModelsResponse,
	LmStudioModelInfo,
	LmStudioModelsResponse,
	LocalServerInfo,
	ModelMetadata,
	ParsedServerArgs,
	ScanResult,
	ServerConfig,
	ServerKind,
	ServerProps,
	SettingsConfig,
} from "./types.ts";

// ── GGUF quant tag extraction ──────────────────────────────────────────────
const QUANT_TAG_RE =
	/[-._\s]?((?:UD-|KL1-)?(?:I?Q[1-8][._][0-9A-Z_]+|IQ[1-4]_[0-9A-Z]+|TQ[1-4]_[0-9]|F16|F32|BF16|FP16|FP32|MXFP4[0-9A-Z_]*))$/i;

export function extractQuantTag(filenameOrId: string): string | undefined {
	const colon = filenameOrId.lastIndexOf(":");
	if (colon > 0) {
		const suffix = filenameOrId.slice(colon + 1);
		if (/^(I?Q[1-8]_|TQ[1-4]_|F16|F32|BF16|FP16|MXFP4)/i.test(suffix)) return suffix.toUpperCase();
	}
	const base = baseName(filenameOrId).replace(/\.(gguf|ggml)$/i, "");
	const match = base.match(QUANT_TAG_RE);
	return match?.[1]?.toUpperCase();
}

// ── llama-server flag parsing ──────────────────────────────────────────────
export function parseServerArgs(tokens: string[]): ParsedServerArgs {
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

// ── Local /proc scan (loopback only) ───────────────────────────────────────
export function scanLocalServers(): Map<number, LocalServerInfo> {
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

// ── HTTP client (node:http, no fetch) ──────────────────────────────────────
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

export async function httpGet(url: string, timeoutMs: number, apiKey?: string): Promise<HttpResult> {
	try {
		return await httpRequest("GET", url, undefined, timeoutMs, apiKey);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ECONNREFUSED" || code === "ENOTFOUND") throw err;
		await new Promise((r) => setTimeout(r, 250));
		return await httpRequest("GET", url, undefined, timeoutMs, apiKey);
	}
}

export function isNetworkError(msg: string): boolean {
	return /timeout|socket hang up|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(msg);
}

// ── Model display names ────────────────────────────────────────────────────
export function cleanModelName(rawId: string): string {
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

// ── /props + LM Studio catalog ─────────────────────────────────────────────
export async function fetchServerProps(
	baseUrl: string,
	timeoutMs: number,
	apiKey?: string,
	model?: string,
): Promise<ServerProps | undefined> {
	const rootUrl = baseUrl.replace(/\/v1\/?$/, "");
	let url = `${rootUrl}/props`;
	if (model !== undefined) url += `?model=${encodeURIComponent(model)}&autoload=false`;
	try {
		const { status, body } = await httpGet(url, timeoutMs, apiKey);
		if (status >= 200 && status < 300) return JSON.parse(body) as ServerProps;
	} catch {
		// no /props → plain OpenAI-compatible server
	}
	return undefined;
}

export function lmStudioKey(info: LmStudioModelInfo): string | undefined {
	return info.key ?? info.id;
}

export function lmStudioQuantName(info: LmStudioModelInfo | undefined): string | undefined {
	if (!info) return undefined;
	const q = info.quantization;
	if (typeof q === "string") return q || undefined;
	return q?.name ?? undefined;
}

export function lmStudioContextLength(info: LmStudioModelInfo | undefined): number | undefined {
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

export async function fetchLmStudioCatalog(
	baseUrl: string,
	timeoutMs: number,
	apiKey?: string,
): Promise<LmStudioModelInfo[] | undefined> {
	const rootUrl = baseUrl.replace(/\/v1\/?$/, "");
	for (const path of ["/api/v1/models", "/api/v0/models"]) {
		try {
			const { status, body } = await httpGet(`${rootUrl}${path}`, timeoutMs, apiKey);
			if (status < 200 || status >= 300) continue;
			const payload = JSON.parse(body) as LmStudioModelsResponse;
			const models = Array.isArray(payload.models) ? payload.models : Array.isArray(payload.data) ? payload.data : undefined;
			if (models && models.length > 0 && models.some(isLmStudioModelInfo)) return models;
		} catch {
			// Not LM Studio, or older server without the REST metadata endpoint.
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

// ── Server kind detection ──────────────────────────────────────────────────
export async function detectServerKind(
	_baseUrl: string,
	models: LlamaCppModel[],
	props: ServerProps | undefined,
	lmStudioCatalog?: LmStudioModelInfo[],
): Promise<ServerKind | "unknown"> {
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

// ── DwarfStar probe ────────────────────────────────────────────────────────
export async function probeDs4Server(
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

// ── Per-model metadata ─────────────────────────────────────────────────────
export function buildModelMetadata(
	rawId: string,
	entry: LlamaCppModel,
	props: ServerProps | undefined,
	local: LocalServerInfo | undefined,
): ModelMetadata {
	const meta: ModelMetadata = {};

	// Quant: GGUF filename / router id / LM Studio metadata.
	const sourcePath = entry.path ?? props?.model_path ?? rawId;
	meta.quant = extractQuantTag(sourcePath) ?? lmStudioQuantName(entry.lmStudio)?.toUpperCase();

	// Vision.
	if (entry.architecture?.input_modalities?.includes("image")) meta.vision = true;
	if (meta.vision === undefined && props?.modalities?.vision === true) meta.vision = true;
	if (!meta.vision && (entry.lmStudio?.capabilities?.vision === true || entry.lmStudio?.type === "vlm")) {
		meta.vision = true;
	}
	if (!meta.vision && local?.hasMmproj) meta.vision = true;

	// Drafter.
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

	// KV cache quantization.
	meta.cacheK = argsInfo?.cacheK ?? local?.cacheK ?? props?.cache_type_k?.toLowerCase();
	meta.cacheV = argsInfo?.cacheV ?? local?.cacheV ?? props?.cache_type_v?.toLowerCase();

	// Router / LM Studio load status.
	if (entry.status?.value) meta.routerStatus = entry.status.value;
	else if (entry.lmStudio?.state && entry.lmStudio.state !== "loaded") meta.routerStatus = entry.lmStudio.state;

	return meta;
}

// ── One endpoint scan ──────────────────────────────────────────────────────
export async function fetchModelsFromEndpoint(
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
			ep.loading = status === 503;
			if (srv.probeDs4 && !ep.loading) return probeDs4Server(ep, settings.discoveryTimeoutMs, srv.apiKey);
			return ep;
		}
		const payload = JSON.parse(body) as LlamaCppModelsResponse;
		let models = payload.data ?? [];

		const nameMap = new Map<string, string>();
		if (Array.isArray(payload.models)) {
			for (const m of payload.models) {
				if (m.model && m.name) nameMap.set(m.model, m.name);
			}
		}

		let props = await fetchServerProps(baseUrl, settings.discoveryTimeoutMs, srv.apiKey);
		const lmStudioCatalog = props ? undefined : await fetchLmStudioCatalog(baseUrl, settings.discoveryTimeoutMs, srv.apiKey);
		if (lmStudioCatalog) models = enrichWithLmStudioCatalog(models, lmStudioCatalog);
		const isRouterShape = models.some((m) => m.path !== undefined || m.status !== undefined);
		const routerProps = props?.role === "router";
		const mode = lmStudioCatalog
			? models.length > 1 ? "router" : "single"
			: isRouterShape || routerProps ? "router" : "single";
		if (mode === "router") props = undefined;

		const kind = await detectServerKind(baseUrl, models, props, lmStudioCatalog);
		if (kind === "lucebox") {
			props = (await fetchServerProps(baseUrl, settings.discoveryTimeoutMs, srv.apiKey)) ?? props;
		}

		const local = isLocalHost(srv.host) && settings.detectVision ? localServers.get(port) : undefined;

		for (const model of models) {
			const rawId = String(model.id ?? "");
			let modelProps = props;
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

// ── Signature + scan-all ───────────────────────────────────────────────────
export function modelsSignature(endpoints: EndpointResult[]): string {
	return endpoints
		.map((r) => {
			const models = r.models
				.filter((m) => {
					if (r.server === "lmstudio") return true;
					const st = r.meta.get(String(m.id ?? ""))?.routerStatus;
					return !st || st === "loaded" || shared.rIncludeUnloaded;
				})
				.map((m) => `${m.id}:${r.meta.get(String(m.id ?? ""))?.routerStatus ?? ""}`)
				.sort()
				.join(",");
			return `${r.host}:${r.port}:${r.ok ? r.server : r.loading ? "loading" : "down"}:${models}`;
		})
		.join("|");
}

export async function scanAllServers(config: { servers: ServerConfig[]; settings: SettingsConfig }): Promise<ScanResult> {
	shared.rIncludeUnloaded = config.settings.includeUnloadedRouterModels;
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