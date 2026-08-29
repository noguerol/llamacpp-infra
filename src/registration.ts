// Provider registration: turn scan results into pi models and register
// the provider with pi. Lazy-loaded on first discovery completion.

import {
	DEFAULT_API_KEY,
	PROVIDER_NAME,
	baseName,
	idSafeHost,
	makeCompat,
	modelOptions,
	saveConfig,
	shared,
} from "./core.ts";
import type { ExtensionAPI } from "./types.ts";
import type {
	EndpointResult,
	InfraConfig,
	LlamaCppModel,
	ModelMetadata,
	PiModel,
	ScanResult,
} from "./types.ts";
import { cleanModelName, lmStudioContextLength } from "./scan.ts";

/** Compact badge string appended to display names when enabled. */
function badgeSuffix(
	meta: { vision?: boolean; drafter?: string; routerStatus?: string },
	showBadges: boolean,
): string {
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
	srv: import("./types.ts").ServerConfig,
	settings: import("./types.ts").SettingsConfig,
	modelMeta: ModelMetadata,
): PiModel {
	const rawId = String(model.id ?? "");
	const hostPort = `${idSafeHost(srv.host)}:${ep.port}`;
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

	// LM Studio: OpenAI-compatible runtime with rich REST model metadata.
	if (kind === "lmstudio") {
		const info = model.lmStudio;
		const contextWindow =
			lmStudioContextLength(info) ?? model.context_window ?? model.context_length ?? 32768;
		const displayName = info?.display_name ? cleanModelName(info.display_name) : cleanModelName(rawId);
		return {
			...common,
			id: `${displayName}${machineTag}`,
			serverModelId: rawId,
			name: `${displayName}${badgeSuffix(modelMeta, settings.showBadgesInNames)}`,
			reasoning: false,
			contextWindow,
			maxTokens: model.max_tokens ?? Math.min(contextWindow, 8192),
			compat: makeCompat(kind),
		};
	}

	// lucebox: alias as source of truth, rich metadata from /props.
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

	// ZINC / llama.cpp / dwarfstar.
	const cleanName = cleanModelName(rawId);
	const nameSource = model.path ?? rawId;
	const cleanFromSource = cleanModelName(baseName(nameSource));
	const baseName2 =
		model.name && String(model.name) !== rawId ? cleanModelName(String(model.name)) : cleanFromSource || cleanName;
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
		reasoning: isLlamaFamily,
		contextWindow,
		maxTokens: model.max_tokens ?? Math.min(contextWindow, 8192),
		compat: makeCompat(kind),
	};
}

/**
 * Build pi models from a scan and (re)register the provider.
 * Returns the registered model list.
 */
export function buildAndRegisterProvider(pi: ExtensionAPI, scan: ScanResult, config: InfraConfig): PiModel[] {
	shared.zincModelIds.clear();
	shared.serverModelIds.clear();
	shared.compactModelIds.clear();
	const settings = config.settings;
	let configDirty = false;

	const piModels: PiModel[] = [];
	const seenIds = new Set<string>();
	for (const ep of scan.endpoints) {
		if (!ep.ok) continue;
		const srv = config.servers.find((s) => s.id === ep.serverId && s.host === ep.host);
		if (!srv) continue;

		const visibleModels = ep.models.filter((m) => {
			const lmType = m.lmStudio?.type;
			if (ep.server === "lmstudio") return lmType !== "embedding" && lmType !== "embeddings";
			const st = ep.meta.get(String(m.id ?? ""))?.routerStatus;
			return !st || st === "loaded" || settings.includeUnloadedRouterModels;
		});

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

			// ID collision guard.
			if (seenIds.has(pm.id)) {
				if (!pm.id.includes(`(${hostPort})`)) pm.id = `${pm.id} (${hostPort})`;
				let n = 2;
				while (seenIds.has(pm.id)) pm.id = `${pm.id}-${n++}`;
			}
			seenIds.add(pm.id);

			// Thinking budgets: resolve by registered (compact) id or legacy
			// "host:port/model" keys, then migrate legacy keys forward.
			const opts = modelOptions();
			let budgets = opts[pm.id]?.thinkingBudgets;
			if (!budgets) {
				for (const legacyKey of [
					`${hostPort}/${pm.serverModelId.replace(/^\/+/, "")}`,
					pm.serverModelId,
				]) {
					const entry = opts[legacyKey];
					if (entry?.thinkingBudgets) {
						if (!opts[pm.id]) opts[pm.id] = entry;
						delete opts[legacyKey];
						configDirty = true;
						budgets = entry.thinkingBudgets;
						break;
					}
				}
			}
			if (budgets && ep.server !== "lmstudio") {
				pm.thinkingBudgets = budgets;
				pm.reasoning = true;
			}

			// Duplicate display names get the raw id appended.
			const candidateName = cleanModelName(String(model.name ?? model.id));
			if (nameCount.get(candidateName)! > 1) {
				pm.name = `${candidateName}${badgeSuffix(modelMeta, settings.showBadgesInNames)} (${pm.serverModelId})`;
			}
			piModels.push(pm);
			if (ep.server === "zinc") {
				shared.zincModelIds.add(pm.id);
				shared.zincModelIds.add(pm.serverModelId);
			}
			shared.serverModelIds.set(pm.id, pm.serverModelId);
			if (!shared.compactModelIds.has(pm.serverModelId)) shared.compactModelIds.set(pm.serverModelId, pm.id);
		}
	}

	if (configDirty) saveConfig(config);

	shared.endpointKinds.clear();
	for (const ep of scan.endpoints) {
		if (ep.ok) shared.endpointKinds.set(ep.baseUrl, ep.server);
	}
	shared.modelBaseUrls.clear();
	for (const pm of piModels) shared.modelBaseUrls.set(pm.id, pm.baseUrl);

	const first = config.servers.find((s) => s.enabled && s.ports.length > 0);
	const defaultBaseUrl =
		scan.endpoints.find((e) => e.ok)?.baseUrl ?? `http://${first?.host ?? "127.0.0.1"}:${first?.ports[0] ?? 8080}/v1`;
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
		models: piModels,
	});

	return piModels;
}