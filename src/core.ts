// Core: config persistence, constants, id helpers, shared mutable state.
// Statically imported by the entrypoint → must stay small.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	CompatProfile,
	InfraConfig,
	ModelOptions,
	ServerConfig,
	ServerKind,
	SettingsConfig,
} from "./types.ts";

// ── Provider identity ───────────────────────────────────────────────────────
export const PROVIDER_NAME = "llamacpp-infra";
export const STATUS_KEY = "llamacpp-infra";
export const CONFIG_FILE = "llamacpp-infra.json";
export const MODELS_CACHE_FILE = "llamacpp-infra-models.json";
export const LEGACY_CONFIG_FILE = "local-models.json";
export const METRICS_STATUS_KEY = "llamacpp-infra-speed";
export const DEFAULT_API_KEY = "no-auth";
export const THINKING_BUDGET_FIELD = "thinking_budget_tokens";
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 20 * 60 * 1000;

// ── Settings defaults ───────────────────────────────────────────────────────
export const DEFAULT_SETTINGS: SettingsConfig = {
	discoveryTimeoutMs: 2000,
	pollIntervalMs: 4000,
	pollMaxMs: 90_000,
	startupGraceMs: 40_000,
	maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
	requestTimeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
	knownGoodFailLimit: 3,
	detectVision: true,
	prefixModelIds: true,
	warmup: true,
	metricsEnabled: true,
	metricsPollMs: 5000,
	includeUnloadedRouterModels: false,
	showBadgesInNames: true,
};

export const DEFAULT_SERVERS: ServerConfig[] = [
	{
		id: "local",
		host: "127.0.0.1",
		label: "Local",
		ports: [8000, 8001, 8002, 8080, 8081, 8082, 1234],
		enabled: true,
		probeDs4: false,
	},
];

// ── Debug logging ──────────────────────────────────────────────────────────
export const DEBUG = process.env.PI_LLAMACPP_INFRA_DEBUG === "1" || process.env.PI_LLAMACPP_INFRA_DEBUG === "true";
export function debugLog(...args: unknown[]): void {
	if (DEBUG) console.debug(`[llamacpp-infra]`, ...args);
}

// ── Config persistence ─────────────────────────────────────────────────────
export function getConfigPath(): string {
	return join(getAgentDir(), CONFIG_FILE);
}

export function loadConfig(): InfraConfig {
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
			return migrated;
		} catch {
			// fall through to defaults
		}
	}
	return defaults;
}

export function saveConfig(config: InfraConfig): void {
	try {
		const dir = getAgentDir();
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
		debugLog(`config saved to ${getConfigPath()}`);
	} catch (err) {
		console.error(`[llamacpp-infra] Config save error: ${err}`);
	}
}

// ── Last-known-models cache ────────────────────────────────────────────────
// Lets a freshly booted pi process register the provider with the models from
// the previous scan IMMEDIATELY (synchronously, during the extension factory),
// so CLI consumers that resolve --model at startup (e.g. trimegisto sub-agents
// spawned as `pi -p --no-session --model provider/model`) find the model before
// the async discovery re-scan completes. The async scan then refreshes this
// registration with live data as usual.

const MODELS_CACHE_VERSION = 1;

/** JSON-safe projection of a registered PiModel (no secrets; headers re-derived). */
interface CachedModelEntry {
	id: string;
	name: string;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	serverModelId: string;
	endpoint: import("./types.ts").PiModel["endpoint"];
	thinkingBudgets?: import("./types.ts").ThinkingBudgets;
	quant?: string;
	cacheK?: string;
	cacheV?: string;
	drafter?: string;
	routerStatus?: string;
}

interface ModelsCacheFile {
	version: number;
	savedAt: string;
	models: CachedModelEntry[];
}

export function getModelsCachePath(): string {
	return join(getAgentDir(), MODELS_CACHE_FILE);
}

/** Persist the last successfully registered models for fast boot on next process. */
export function saveModelsCache(models: import("./types.ts").PiModel[]): void {
	if (!models || models.length === 0) return;
	try {
		const file: ModelsCacheFile = {
			version: MODELS_CACHE_VERSION,
			savedAt: new Date().toISOString(),
			models: models.map((m) => ({
				id: m.id,
				name: m.name,
				baseUrl: m.baseUrl,
				reasoning: m.reasoning,
				input: m.input,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				serverModelId: m.serverModelId,
				endpoint: m.endpoint,
				thinkingBudgets: m.thinkingBudgets,
				quant: m.quant,
				cacheK: m.cacheK,
				cacheV: m.cacheV,
				drafter: m.drafter,
				routerStatus: m.routerStatus,
			})),
		};
		const dir = getAgentDir();
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(getModelsCachePath(), JSON.stringify(file), "utf-8");
		debugLog(`models cache saved (${models.length} model(s))`);
	} catch (err) {
		console.error(`[llamacpp-infra] Models cache save error: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Load models cached by a previous scan, or null when absent/corrupt/empty. */
export function loadModelsCache(): import("./types.ts").PiModel[] | null {
	try {
		const path = getModelsCachePath();
		if (!existsSync(path)) return null;
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<ModelsCacheFile>;
		if (raw?.version !== MODELS_CACHE_VERSION || !Array.isArray(raw.models) || raw.models.length === 0) return null;
		return raw.models.map((c) => ({
			id: c.id,
			name: c.name,
			baseUrl: c.baseUrl,
			reasoning: c.reasoning,
			input: Array.isArray(c.input) && c.input.length > 0 ? c.input : (["text"] as ("text" | "image")[]),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: c.contextWindow,
			maxTokens: c.maxTokens,
			compat: makeCompat(c.endpoint?.kind),
			serverModelId: c.serverModelId,
			endpoint: c.endpoint,
			thinkingBudgets: c.thinkingBudgets,
			quant: c.quant,
			cacheK: c.cacheK,
			cacheV: c.cacheV,
			drafter: c.drafter,
			routerStatus: c.routerStatus,
		}));
	} catch (err) {
		debugLog(`models cache load failed: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

/** Rebuild the shared maps (id↔raw, baseUrls, kinds, zinc) from cached models. */
export function applyCachedSharedState(models: import("./types.ts").PiModel[]): void {
	shared.zincModelIds.clear();
	shared.serverModelIds.clear();
	shared.compactModelIds.clear();
	shared.endpointKinds.clear();
	shared.modelBaseUrls.clear();
	for (const pm of models) {
		if (pm.endpoint?.kind === "zinc") {
			shared.zincModelIds.add(pm.id);
			shared.zincModelIds.add(pm.serverModelId);
		}
		shared.serverModelIds.set(pm.id, pm.serverModelId);
		if (!shared.compactModelIds.has(pm.serverModelId)) shared.compactModelIds.set(pm.serverModelId, pm.id);
		shared.endpointKinds.set(pm.baseUrl, pm.endpoint?.kind ?? "unknown");
		shared.modelBaseUrls.set(pm.id, pm.baseUrl);
	}
}

// ── Compat profile ─────────────────────────────────────────────────────────
export function supportsThinkingBudget(kind: ServerKind | "unknown" | "auto" | undefined): boolean {
	return kind === "llamacpp" || kind === "lucebox";
}

export function makeCompat(kind: ServerKind | "unknown" | "auto"): CompatProfile {
	const usageInStreaming = kind !== "zinc";
	return {
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens" as const,
		supportsUsageInStreaming: usageInStreaming,
		supportsStrictMode: false,
		...(supportsThinkingBudget(kind) ? { thinkingTokenBudgetField: THINKING_BUDGET_FIELD } : {}),
	};
}

// ── Shared mutable state ───────────────────────────────────────────────────
// Maps used by hooks + lazy modules. Kept in one place so lazy imports share
// them via static import of core.ts.
export const shared = {
	activeConfig: undefined as InfraConfig | undefined,
	zincModelIds: new Set<string>(),
	modelBaseUrls: new Map<string, string>(),
	endpointKinds: new Map<string, string>(),
	serverModelIds: new Map<string, string>(),
	compactModelIds: new Map<string, string>(),
	lastScan: undefined as import("./types.ts").ScanResult | undefined,
	lastModels: [] as import("./types.ts").PiModel[],
	registeredCount: 0,
	lastError: undefined as string | undefined,
	rIncludeUnloaded: false,
};

export function setActiveConfig(c: InfraConfig | undefined): void {
	shared.activeConfig = c;
}

export function modelOptions(): Record<string, ModelOptions> {
	return shared.activeConfig?.modelOptions ?? {};
}

/** Compact id registered in pi for a raw server model id (or the input). */
export function compactIdFor(modelId: string | undefined): string | undefined {
	if (!modelId) return undefined;
	return shared.compactModelIds.get(modelId) ?? modelId;
}

/** Raw server-side id to send in requests for a registered model id (or the input). */
export function rawIdFor(modelId: string | undefined): string | undefined {
	if (!modelId) return undefined;
	return shared.serverModelIds.get(modelId) ?? modelId;
}

// ── Thinking-level normalization (used by the per-model budget hook) ──────
export function normalizeLevel(level: string | undefined): "minimal" | "low" | "medium" | "high" | undefined {
	switch (level) {
		case "minimal":
		case "low":
		case "medium":
		case "high":
			return level;
		case "xhigh":
		case "max":
			return "high";
		default:
			return undefined;
	}
}

// ── Server-label / id helpers ──────────────────────────────────────────────
export function serverLabel(srv: ServerConfig): string {
	return srv.label?.trim() || srv.host;
}

export function idSafeHost(host: string): string {
	return host.trim().toLowerCase() || "host";
}

export function isLocalHost(host: string): boolean {
	const h = host.trim().toLowerCase();
	return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

export function baseName(p: string): string {
	const cleaned = p.replace(/\\/g, "/");
	const last = cleaned.split("/").pop() || cleaned;
	return last;
}