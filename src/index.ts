// Extension entrypoint: wires config, hooks, command, and lazy modules.
// Heavy logic lives in lazily-loaded sibling files (scan, registration,
// metrics, ui, prompt-warmup). Static imports are kept minimal.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	PROVIDER_NAME,
	STATUS_KEY,
	THINKING_BUDGET_FIELD,
	applyCachedSharedState,
	compactIdFor,
	debugLog,
	loadConfig,
	loadModelsCache,
	modelOptions,
	normalizeLevel,
	rawIdFor,
	saveConfig,
	setActiveConfig,
	shared,
	supportsThinkingBudget,
} from "./core.ts";
import { createLongTimeoutOpenAICompletionsStream } from "./runtime.ts";

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	setActiveConfig(config);
	shared.lastScan = undefined;
	shared.lastModels = [];
	shared.registeredCount = 0;
	shared.lastError = undefined;

	// ── Lazy module handles ───────────────────────────────────────────────
	type WarmerModule = typeof import("./prompt-warmup.ts");
	type UiModule = typeof import("./ui.ts");
	type MetricsModule = typeof import("./metrics.ts");
	type SpeedModule = typeof import("./speed.ts");
	type ScanModule = typeof import("./scan.ts");
	type RegModule = typeof import("./registration.ts");

	let warmerModPromise: Promise<WarmerModule> | undefined;
	let metricsModPromise: Promise<MetricsModule> | undefined;
	let speedModPromise: Promise<SpeedModule> | undefined;
	let uiModPromise: Promise<UiModule> | undefined;
	let scanModPromise: Promise<ScanModule> | undefined;
	let regModPromise: Promise<RegModule> | undefined;

	const loadWarmer = (): Promise<WarmerModule> => (warmerModPromise ??= import("./prompt-warmup.ts"));
	const loadUi = (): Promise<UiModule> => (uiModPromise ??= import("./ui.ts"));
	const loadMetrics = (): Promise<MetricsModule> => (metricsModPromise ??= import("./metrics.ts"));
	const loadSpeed = (): Promise<SpeedModule> => (speedModPromise ??= import("./speed.ts"));
	const loadScan = (): Promise<ScanModule> => (scanModPromise ??= import("./scan.ts"));
	const loadReg = (): Promise<RegModule> => (regModPromise ??= import("./registration.ts"));

	// Prime heavy modules off the critical path so they land in cache before
	// they are first needed. Discovery (always needed) starts after the
	// factory returns, so these resolves race the first discoverAndRegister().
	void loadScan();
	void loadReg();
	if (config.settings.metricsEnabled) {
		void loadMetrics();
		void loadSpeed();
	}
	if (config.settings.warmup) void loadWarmer();
	void loadUi(); // command handler awaits this; priming keeps menus snappy

	// ── Warmup handle (constructed lazily on first session_start) ─────────
	interface WarmerHandles {
		warmer: import("./prompt-warmup.ts").PromptWarmer;
		status: import("./prompt-warmup.ts").WarmupStatus;
	}
	let warm: WarmerHandles | undefined;

	// ── Metrics engine + speed tracker handles ────────────────────────────
	let metricsApi: ReturnType<MetricsModule["createMetrics"]> | undefined;
	let speedApi: ReturnType<SpeedModule["createSpeedTracker"]> | undefined;

	// ── Internal state ────────────────────────────────────────────────────
	let lastSignature: string | undefined;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let polling = false;
	let providerIsEmpty = true;
	let currentThinkingLevel: string | undefined;

	const knownGood = new Set<string>();
	const consecutiveFails = new Map<string, number>();
	let anyEverOk = false;
	const startedAt = Date.now();
	let extensionActive = true;

	function ctxHasUI(ctx: ExtensionContext | undefined): ctx is ExtensionContext {
		if (!ctx || !extensionActive) return false;
		try {
			return ctx.hasUI;
		} catch (err) {
			debugLog(`stale ctx ignored: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	const epKey = (host: string, port: number) => `${host}:${port}`;

	function safeSystemPrompt(ctx: { getSystemPrompt?: () => string }): string | undefined {
		try {
			return ctx.getSystemPrompt?.();
		} catch {
			return undefined;
		}
	}

	// ── Empty provider registration (pi boots without waiting) ───────────
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
			apiKey: first?.apiKey || "no-auth",
			api: "openai-completions",
			streamSimple: createLongTimeoutOpenAICompletionsStream,
			models: [],
		});
		providerIsEmpty = true;
	}

	// ── Boot provider registration (synchronous, cache-first) ────────────
	// Registers models from the last known scan IMMEDIATELY when a cache exists,
	// so this process can resolve `--model llamacpp-infra/...` at startup without
	// waiting for the async discovery re-scan (which refreshes right after).
	// Falls back to the empty "scanning…" provider when there is no cache.
	function registerBootProvider() {
		const cached = loadModelsCache();
		if (cached && cached.length > 0) {
			try {
				pi.unregisterProvider(PROVIDER_NAME);
			} catch {
				// not registered yet
			}
			// Re-derive per-server auth headers (never persisted with the cache).
			for (const m of cached) {
				const srv = config.servers.find((s) => s.id === m.endpoint?.serverId && s.host === m.endpoint?.host);
				if (srv?.apiKey) m.headers = { Authorization: `Bearer ${srv.apiKey}` };
			}
			applyCachedSharedState(cached);
			const bootSrv = config.servers.find((s) => s.id === cached[0].endpoint?.serverId);
			pi.registerProvider(PROVIDER_NAME, {
				name: `🦙 llama.cpp-infra (cached ${cached.length}, rescanning…)`,
				baseUrl: cached[0].baseUrl,
				apiKey: bootSrv?.apiKey || "no-auth",
				api: "openai-completions",
				streamSimple: createLongTimeoutOpenAICompletionsStream,
				models: cached,
			});
			providerIsEmpty = false;
			shared.registeredCount = cached.length;
			shared.lastModels = cached;
			debugLog(`boot: registered ${cached.length} cached model(s); async rescan will refresh`);
			return;
		}
		registerEmptyProvider();
	}

	async function discoverAndRegister(): Promise<{ scan: import("./types.ts").ScanResult; shouldPoll: boolean }> {
		try {
			if (!extensionActive) {
				return { scan: { endpoints: [], totalModels: 0, serversUp: 0, serversTotal: 0 }, shouldPoll: false };
			}
			const { scanAllServers, modelsSignature } = await loadScan();
			const scan = await scanAllServers(config);
			if (!extensionActive) return { scan, shouldPoll: false };
			shared.lastScan = scan;

			const signature = modelsSignature(scan.endpoints);
			const changed = signature !== lastSignature || providerIsEmpty;
			lastSignature = signature;
			if (!changed) {
				return {
					scan,
					shouldPoll: shouldContinuePolling(scan.endpoints, scan.endpoints.some((e) => e.loading)),
				};
			}

			const { buildAndRegisterProvider } = await loadReg();
			const models = buildAndRegisterProvider(pi, scan, config);
			providerIsEmpty = models.length === 0;
			shared.registeredCount = models.length;
			shared.lastModels = models;
			shared.lastError = undefined;
			debugLog(`discovery change: ${shared.registeredCount} model(s), ${scan.serversUp}/${scan.serversTotal} servers up`);

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
			return {
				scan,
				shouldPoll: shouldContinuePolling(scan.endpoints, scan.endpoints.some((e) => e.loading)),
			};
		} catch (err) {
			if (extensionActive) shared.lastError = err instanceof Error ? err.message : String(err);
			return { scan: { endpoints: [], totalModels: 0, serversUp: 0, serversTotal: 0 }, shouldPoll: false };
		}
	}

	function shouldContinuePolling(endpoints: import("./types.ts").EndpointResult[], hasLoading: boolean): boolean {
		if (hasLoading) return true;
		for (const key of knownGood) {
			const ep = endpoints.find((e) => epKey(e.host, e.port) === key);
			if (!ep || !ep.ok) return true;
		}
		if (!anyEverOk && Date.now() - startedAt < config.settings.startupGraceMs) return true;
		return false;
	}

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

	async function rescan(ctx?: ExtensionContext) {
		if (!extensionActive) return;
		if (ctxHasUI(ctx)) ctx.ui.setStatus(STATUS_KEY, "🔎");
		stopPolling();
		registerEmptyProvider();
		const r = await discoverAndRegister();
		if (!extensionActive) return;
		schedulePolling(r.shouldPoll);
		updateStatusFooter(ctx);
	}

	function updateStatusFooter(ctx?: ExtensionContext) {
		if (!ctxHasUI(ctx)) return;
		if (shared.registeredCount > 0) {
			ctx.ui.setStatus(STATUS_KEY, `🦙(${shared.registeredCount})`);
		} else if (shared.lastScan?.endpoints.some((e) => e.loading)) {
			ctx.ui.setStatus(STATUS_KEY, "⏳");
		} else if (shared.lastError) {
			ctx.ui.setStatus(STATUS_KEY, "⚠️");
		} else {
			ctx.ui.setStatus(STATUS_KEY, "−");
		}
	}

	async function toggleMetrics(ctx: ExtensionContext) {
		config.settings.metricsEnabled = !config.settings.metricsEnabled;
		saveConfig(config);
		if (config.settings.metricsEnabled) {
			await ensureSpeed().then((s) => s?.start(ctx));
			const m = await ensureMetrics();
			m.start(ctx);
			ctx.ui.notify("📊 Live speed & metrics enabled (footer)", "info");
		} else {
			speedApi?.stop(ctx);
			metricsApi?.stop(ctx);
			ctx.ui.notify("📊 Live speed & metrics disabled", "info");
		}
	}

	function restartMetricsPolling(ctx: ExtensionContext) {
		if (!metricsApi) return;
		metricsApi.stop(ctx);
		if (config.settings.metricsEnabled) metricsApi.start(ctx);
	}

	// ── Live speed: per-call prefill timing (before id rewrite) ──────────
	pi.on("before_provider_request", (_event, ctx) => {
		speedApi?.onRequest(ctx, Date.now());
		return undefined;
	});

	// ── Live speed: stream events (token arrivals, message/turn ends) ────
	pi.on("message_update", (event, ctx) => {
		speedApi?.onToken(ctx, event.assistantMessageEvent, Date.now());
	});

	pi.on("message_end", (event, ctx) => {
		speedApi?.onMessageEnd(ctx, event.message, Date.now());
	});

	pi.on("turn_end", (_event, ctx) => {
		speedApi?.onTurnEnd(ctx);
	});

	// ── Hook 0: compact id → raw server model id ──────────────────────────
	pi.on("before_provider_request", (event, _ctx) => {
		const payload = event.payload as Record<string, unknown>;
		const modelInPayload = typeof payload.model === "string" ? payload.model : undefined;
		if (!modelInPayload) return undefined;
		const raw = shared.serverModelIds.get(modelInPayload);
		if (raw === undefined || raw === modelInPayload) return undefined;
		debugLog(`model id "${modelInPayload}" → "${raw}"`);
		return { ...payload, model: raw };
	});

	// ── Hook 1: ZINC payload workaround ───────────────────────────────────
	function isZincModel(modelInPayload: unknown): boolean {
		if (typeof modelInPayload !== "string") return false;
		if (shared.zincModelIds.has(modelInPayload)) return true;
		for (const zid of shared.zincModelIds) {
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

	// ── Hook 2: per-model thinking budget ─────────────────────────────────
	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as Record<string, unknown>;
		const modelId = typeof payload.model === "string" ? payload.model : undefined;
		if (!modelId) return undefined;
		const compactKey = shared.compactModelIds.get(modelId) ?? modelId;
		const baseUrl = shared.modelBaseUrls.get(compactKey);
		if (!supportsThinkingBudget(shared.endpointKinds.get(baseUrl ?? "") as never)) return undefined;
		const budgets = modelOptions()[compactKey]?.thinkingBudgets;
		if (!budgets) return undefined;
		const level = normalizeLevel(ctx.thinkingLevel ?? currentThinkingLevel);
		if (!level) return undefined;
		const value = budgets[level];
		if (typeof value !== "number") return undefined;
		debugLog(`thinking budget for ${compactKey} [${level}] = ${value}`);
		return { ...payload, [THINKING_BUDGET_FIELD]: value };
	});

	// ── Hook 3: header warmup capture ─────────────────────────────────────
	pi.on("before_provider_request", (event, ctx) => {
		if (!config.settings.warmup || !warm) return undefined;
		const payload = event.payload as Record<string, unknown>;
		const modelId = typeof payload?.model === "string" ? payload.model : undefined;
		const compactKey = modelId ? compactIdFor(modelId) : undefined;
		const baseUrl = compactKey ? shared.modelBaseUrls.get(compactKey) : undefined;
		const capturePayload = compactKey ? { ...payload, model: compactKey } : payload;
		warm.warmer.onProviderPayload(capturePayload, baseUrl, ctx.cwd);
		return undefined;
	});

	// ── Async warmup loader ───────────────────────────────────────────────
	async function ensureWarmup(): Promise<WarmerHandles | undefined> {
		if (!config.settings.warmup) return undefined;
		if (!warm) {
			const m = await loadWarmer();
			const status = new m.WarmupStatus("warmup-llamacpp-infra");
			const warmer = new m.PromptWarmer({
				provider: PROVIDER_NAME,
				cacheFile: join(homedir(), ".pi", "agent", "warmup-llamacpp-infra.json"),
				kindFor: (baseUrl) => shared.endpointKinds.get(baseUrl),
				requestModelFor: (modelId) => rawIdFor(modelId) ?? modelId,
				onEvent: (ev) => status.handle(ev),
			});
			warm = { warmer, status };
		}
		return warm;
	}

	async function ensureSpeed(): Promise<NonNullable<typeof speedApi> | undefined> {
		if (!speedApi) {
			const m = await loadSpeed();
			if (!speedApi) {
				speedApi = m.createSpeedTracker({
					isActive: () => extensionActive,
					hasUI: ctxHasUI,
					isOurs: (ctx) => {
						try {
							return ctx?.model?.provider === PROVIDER_NAME;
						} catch {
							return false; // post-shutdown ctx (live `model` getter throws)
						}
					},
					enabled: () => config.settings.metricsEnabled,
				});
			}
		}
		return speedApi;
	}

	async function ensureMetrics(): Promise<NonNullable<typeof metricsApi>> {
		if (!metricsApi) {
			const m = await loadMetrics();
			metricsApi = m.createMetrics({
				isActive: () => extensionActive,
				pollIntervalMs: () => config.settings.metricsPollMs,
				enabled: () => config.settings.metricsEnabled,
				onServerState: (ctx, st) => {
					speedApi?.onServerState(ctx, st);
				},
			});
		}
		return metricsApi;
	}

	// ── Command ───────────────────────────────────────────────────────────
	pi.registerCommand("llamacpp-infra", {
		description: "🦙 llama.cpp-infra: scan, status, config, metrics for llama.cpp/ZINC/ds4/lucebox/LM Studio",
		getArgumentCompletions: (prefix) =>
			["config", "scan", "status", "list", "metrics", "help"]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			const ui = await loadUi();
			const deps: import("./ui.ts").UiDeps = {
				rescan,
				toggleMetrics,
				restartMetricsPolling,
				updateStatusFooter,
			};
			switch (sub) {
				case "":
				case "status":
					await ui.showStatus(ctx);
					break;
				case "config":
					await ui.showConfigMenu(ctx, deps);
					break;
				case "scan":
					await rescan(ctx);
					ctx.ui.notify("🔎 scan complete", "info");
					break;
				case "list":
					await ui.showModelList(ctx);
					break;
				case "metrics":
					await toggleMetrics(ctx);
					break;
				case "help":
					ui.showHelp(ctx);
					break;
				default:
					ctx.ui.notify(`❓ unknown "${sub}". Try /llamacpp-infra help`, "warning");
			}
		},
	});

	// ── Initial non-blocking registration ─────────────────────────────────
	registerBootProvider();
	void discoverAndRegister()
		.then((r) => {
			if (extensionActive) schedulePolling(r.shouldPoll);
		})
		.catch((err) => {
			if (extensionActive) debugLog(`initial discovery failed: ${err instanceof Error ? err.message : String(err)}`);
		});

	// ── Events ────────────────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		const w = await ensureWarmup();
		if (w) {
			if (ctxHasUI(ctx)) w.status.bind(ctx.ui);
			w.warmer.warmupForModel(ctx.model, safeSystemPrompt(ctx), ctx.cwd);
		}
		currentThinkingLevel = ctx.thinkingLevel;
		if (config.settings.metricsEnabled) {
			await ensureSpeed().then((s) => s?.start(ctx));
			const m = await ensureMetrics();
			m.start(ctx);
		}
		if (!ctxHasUI(ctx)) return;
		void discoverAndRegister()
			.then((r) => {
				if (!extensionActive) return;
				schedulePolling(r.shouldPoll);
				updateStatusFooter(ctx);
			})
			.catch((err) => {
				if (!extensionActive) return;
				shared.lastError = err instanceof Error ? err.message : String(err);
				updateStatusFooter(ctx);
			});
	});

	pi.on("model_select", async (event, ctx) => {
		if (event.model.provider !== PROVIDER_NAME) {
			speedApi?.stop(ctx);
			metricsApi?.stop(ctx);
			return;
		}
		const w = await ensureWarmup();
		if (w) {
			if (ctxHasUI(ctx)) w.status.bind(ctx.ui);
			w.warmer.warmupForModel(event.model, safeSystemPrompt(ctx), ctx.cwd);
		}
		metricsApi?.resetForModelSwitch();
		if (config.settings.metricsEnabled) {
			await ensureSpeed().then((s) => s?.start(ctx));
			const m = await ensureMetrics();
			m.start(ctx);
		}
	});

	pi.on("thinking_level_select", (event, _ctx) => {
		currentThinkingLevel = event.level;
	});

	pi.on("session_shutdown", () => {
		extensionActive = false;
		stopPolling();
		speedApi?.stop();
		metricsApi?.stop();
		warm?.warmer.dispose();
		warm?.status.dispose();
	});
}