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
export const LEGACY_CONFIG_FILE = "local-models.json";
export const METRICS_STATUS_KEY = "llamacpp-infra-speed";
export const DEFAULT_API_KEY = "no-auth";
export const THINKING_BUDGET_FIELD = "thinking_budget_tokens";

// ── Settings defaults ───────────────────────────────────────────────────────
export const DEFAULT_SETTINGS: SettingsConfig = {
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