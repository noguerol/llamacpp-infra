// Shared type definitions for llamacpp-infra (type-only; erased at runtime).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** One machine that may serve llama.cpp-family models on one or more ports. */
export interface ServerConfig {
	id: string;
	host: string;
	label?: string;
	ports: number[];
	enabled: boolean;
	probeDs4?: boolean;
	apiKey?: string;
}

/** Thinking budget (tokens) per pi thinking level, llama.cpp-style. */
export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

/** Per-model options keyed by the registered model id. */
export interface ModelOptions {
	thinkingBudgets?: ThinkingBudgets;
}

export interface SettingsConfig {
	discoveryTimeoutMs: number;
	pollIntervalMs: number;
	pollMaxMs: number;
	startupGraceMs: number;
	maxOutputTokens: number;
	requestTimeoutMs: number;
	knownGoodFailLimit: number;
	detectVision: boolean;
	prefixModelIds: boolean;
	warmup: boolean;
	metricsEnabled: boolean;
	metricsPollMs: number;
	includeUnloadedRouterModels: boolean;
	showBadgesInNames: boolean;
}

export interface InfraConfig {
	servers: ServerConfig[];
	settings: SettingsConfig;
	modelOptions: Record<string, ModelOptions>;
}

export interface LlamaCppMeta {
	n_ctx?: number;
	n_ctx_train?: number;
}

export interface LmStudioModelInfo {
	key?: string;
	id?: string;
	display_name?: string;
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

export interface LmStudioModelsResponse {
	models?: LmStudioModelInfo[];
	data?: LmStudioModelInfo[];
	object?: string;
}

export interface LlamaCppModel {
	id: string;
	name?: string;
	object?: string;
	owned_by?: string;
	display_name?: string;
	path?: string;
	status?: {
		value?: string;
		args?: string[];
		preset?: string;
		failed?: boolean;
		exit_code?: number;
	};
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
	lmStudio?: LmStudioModelInfo;
	meta?: LlamaCppMeta;
	context_window?: number;
	context_length?: number;
	max_tokens?: number;
}

export interface LlamaCppModelsResponse {
	models?: Array<{ name?: string; model?: string }>;
	data: LlamaCppModel[];
	object?: string;
}

/** Tolerant view of GET /props across llama.cpp builds and forks. */
export interface ServerProps {
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

export type ServerKind = "llamacpp" | "zinc" | "lucebox" | "dwarfstar" | "lmstudio";
export type ServerMode = "single" | "router" | "unknown";

export interface ModelMetadata {
	quant?: string;
	vision?: boolean;
	drafter?: string;
	cacheK?: string;
	cacheV?: string;
	routerStatus?: string;
}

export interface EndpointResult {
	serverId: string;
	host: string;
	label: string;
	port: number;
	baseUrl: string;
	server: ServerKind | "auto" | "unknown";
	mode: ServerMode;
	models: LlamaCppModel[];
	meta: Map<string, ModelMetadata>;
	ok: boolean;
	error?: string;
	loading?: boolean;
	latencyMs?: number;
	nameMap?: Map<string, string>;
	props?: ServerProps;
}

export interface ScanResult {
	endpoints: EndpointResult[];
	totalModels: number;
	serversUp: number;
	serversTotal: number;
}

export interface ParsedServerArgs {
	cacheK?: string;
	cacheV?: string;
	draft?: string;
	hasDraft?: boolean;
	hasMmproj?: boolean;
	mmprojPath?: string;
}

export interface LocalServerInfo extends ParsedServerArgs {
	port: number;
}

export interface HttpResult {
	status: number;
	body: string;
	contentType?: string;
}

export interface PiModel {
	id: string;
	name: string;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat?: CompatProfile;
	headers?: Record<string, string>;
	thinkingBudgets?: ThinkingBudgets;
	serverModelId: string;
	endpoint: { serverId: string; host: string; port: number; kind: ServerKind | "unknown" | "auto"; mode: ServerMode };
	quant?: string;
	cacheK?: string;
	cacheV?: string;
	drafter?: string;
	routerStatus?: string;
}

export interface MetricsEndpointDiscovered {
	url: string;
	format: "prometheus" | "json";
}

/** Server-side snapshot from the /metrics endpoint (see metrics.ts). */
export interface ServerMetricsState {
	/** In-flight requests reported by the server. */
	processing: number;
	/** Prompt (prefill) rate in tokens/s over the last poll, if measurable. */
	promptTps?: number;
	/** Generation rate in tokens/s over the last poll, if measurable. */
	genTps?: number;
}

export type ThemeFg = (color: any, text: string) => string;

export interface CompatProfile {
	supportsDeveloperRole: boolean;
	supportsReasoningEffort: boolean;
	maxTokensField: "max_tokens";
	supportsUsageInStreaming: boolean;
	supportsStrictMode: boolean;
	thinkingTokenBudgetField?: string;
}

// Re-exports for convenience to keep call-sites stable.
export type { ExtensionAPI, ExtensionContext };