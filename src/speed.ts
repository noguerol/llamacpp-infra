// Client-side speed tracker: measures prefill and generation speed of the
// active model straight from pi's stream events and updates the footer line
// (via setStatus, so no extra terminal row is taken) ~every 100 ms while
// tokens arrive.
//
//   prefill t/s  = prompt tokens / (before_provider_request → first token)
//   gen t/s      = moving window over per-token arrival samples
//
// Footer format (kept ultra-compact so it coexists with other extensions on
// pi's single status line, which is truncated at the end):
//
//   ⚡ {prefill} t/s 🔥 {gen} t/s
//
// The server-side /metrics polling (metrics.ts) only supplements this:
// when the client is idle but the server reports other clients processing,
// their rate is shown as `▶{n} ⚡ … t/s 🔥 … t/s`. The client measurement
// works even when the server has no --metrics endpoint.

import { debugLog, METRICS_STATUS_KEY } from "./core.ts";
import type { AssistantMessageEvent, ExtensionContext, ServerMetricsState, ThemeFg } from "./types.ts";

const safeFg: ThemeFg = (_color, text) => text;

/** Max time between footer updates while a stream is live. */
const RENDER_THROTTLE_MS = 100;
/** Moving window used for the generation rate. */
const GEN_WINDOW_MS = 1500;
/** Minimum window span before a rate is trusted (avoid startup spikes). */
const GEN_MIN_SPAN_MS = 300;
/** Minimum prefill span (s) before a prefill rate is computed. */
const PREFILL_MIN_SPAN_S = 0.05;

const DELTA_EVENT_TYPES: ReadonlySet<string> = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

interface Sample {
	ts: number;
	n: number;
}

export interface SpeedDeps {
	/** Whether the extension is still active (post-shutdown guard). */
	isActive: () => boolean;
	/** Whether the ctx has a UI (with stale-ctx safety). */
	hasUI: (ctx: ExtensionContext | undefined) => ctx is ExtensionContext;
	/** Whether the current session model belongs to this provider. */
	isOurs: (ctx: ExtensionContext | undefined) => boolean;
	/** Whether the widget is enabled in settings. */
	enabled: () => boolean;
}

type SpeedState = "idle" | "prefill" | "streaming" | "done";

function formatRate(rate: number): string {
	return rate >= 100 ? String(Math.round(rate)) : rate.toFixed(1);
}

function rateColor(rate: number, kind: "prefill" | "gen"): string {
	const success = kind === "prefill" ? 500 : 100;
	const warning = kind === "prefill" ? 20 : 10;
	return rate > success ? "success" : rate > warning ? "warning" : "muted";
}

export function createSpeedTracker(deps: SpeedDeps) {
	let state: SpeedState = "idle";
	let prefillStart: number | undefined;
	let firstTokenAt: number | undefined;
	let tokenCount = 0;
	let samples: Sample[] = [];
	let lastPrefillTps: number | undefined;
	let lastGenTps: number | undefined;
	let lastRenderAt = 0;
	let statusActive = false;
	/** Last text sent to the footer (skip redundant updates → fewer re-renders). */
	let lastSentText = "";
	let server: ServerMetricsState | null = null;
	/** Most recent live ctx (used when a callback arrives without one). */
	let lastCtx: ExtensionContext | undefined;

	function rememberCtx(ctx: ExtensionContext | undefined): void {
		if (ctx && deps.hasUI(ctx)) lastCtx = ctx;
	}

	function targetCtx(ctx: ExtensionContext | undefined): ExtensionContext | undefined {
		if (ctx && deps.hasUI(ctx)) return ctx;
		return lastCtx;
	}

	function fg(ctx: ExtensionContext | undefined): ThemeFg {
		if (!deps.hasUI(ctx)) return safeFg;
		try {
			return (ctx.ui.theme?.fg as ThemeFg | undefined)?.bind(ctx.ui.theme) ?? safeFg;
		} catch {
			return safeFg;
		}
	}

	function clearStatus(ctx: ExtensionContext | undefined): void {
		if (!deps.hasUI(ctx) || !statusActive) return;
		try {
			ctx.ui.setStatus(METRICS_STATUS_KEY, undefined);
		} catch (err) {
			debugLog(`speed status clear failed: ${err}`);
		}
		statusActive = false;
		lastSentText = "";
	}

	function resetInternal(): void {
		state = "idle";
		prefillStart = undefined;
		firstTokenAt = undefined;
		tokenCount = 0;
		samples = [];
		lastGenTps = undefined;
		server = null;
		statusActive = false;
		lastSentText = "";
	}

	/** Moving-window generation rate over the recorded arrival samples. */
	function genRateAt(now: number): number | undefined {
		if (samples.length === 0) return undefined;
		// Keep the window bounded to ~GEN_WINDOW_MS (retain at least one sample).
		const cutoff = now - GEN_WINDOW_MS;
		while (samples.length > 1 && samples[0].ts < cutoff) samples.shift();
		const oldest = samples[0];
		const span = now - oldest.ts;
		if (span < GEN_MIN_SPAN_MS) return lastGenTps;
		const tokens = tokenCount - oldest.n;
		if (tokens <= 0) return lastGenTps;
		return tokens / (span / 1000);
	}

	function buildLine(ctx: ExtensionContext | undefined, now: number): string {
		const f = fg(ctx);
		const parts: string[] = [];

		switch (state) {
			case "prefill":
				parts.push(f("warning", "⚡…"));
				break;

			case "streaming": {
				// Prefill rate of the previous call (only known once it ended).
				if (lastPrefillTps !== undefined) {
					parts.push(f("muted", `⚡ ${Math.round(lastPrefillTps)} t/s`));
				}
				const gen = genRateAt(now);
				if (gen !== undefined) {
					lastGenTps = gen;
					parts.push(f(rateColor(gen, "gen"), `🔥 ${formatRate(gen)} t/s`));
				}
				break;
			}

			case "done": {
				if (lastPrefillTps !== undefined) {
					parts.push(f(rateColor(lastPrefillTps, "prefill"), `⚡ ${Math.round(lastPrefillTps)} t/s`));
				}
				if (lastGenTps !== undefined) {
					parts.push(f(rateColor(lastGenTps, "gen"), `🔥 ${formatRate(lastGenTps)} t/s`));
				}
				break;
			}

			case "idle": {
				// Server supplement: this endpoint is busy for *other* clients.
				if (server && server.processing > 0) {
					parts.push(f("success", `▶${server.processing}`));
					if (server.promptTps !== undefined && server.promptTps > 0) {
						parts.push(f(rateColor(server.promptTps, "prefill"), `⚡ ${Math.round(server.promptTps)} t/s`));
					}
					if (server.genTps !== undefined && server.genTps > 0) {
						parts.push(f(rateColor(server.genTps, "gen"), `🔥 ${formatRate(server.genTps)} t/s`));
					}
				} else {
					parts.push(f("muted", "⏸"));
				}
				break;
			}
		}

		// A stream is live but no rate is computable yet (first ~300 ms of a call).
		if (parts.length === 0) parts.push(f("muted", "🔥…"));
		return parts.join(" ");
	}

	function render(ctx: ExtensionContext | undefined, now: number, force = false): void {
		if (!deps.isActive() || !deps.enabled()) {
			clearStatus(ctx);
			return;
		}
		if (!deps.hasUI(ctx) || !deps.isOurs(ctx)) return;
		const line = buildLine(ctx, now);
		if (!force && now - lastRenderAt < RENDER_THROTTLE_MS) return;
		lastRenderAt = now;
		// No visual change → skip (avoids a full UI re-render on the footer).
		if (line === lastSentText && statusActive) return;
		lastSentText = line;
		try {
			ctx.ui.setStatus(METRICS_STATUS_KEY, line);
			statusActive = true;
		} catch (err) {
			debugLog(`speed status update failed: ${err}`);
		}
	}

	return {
		/** before_provider_request: a new LLM call starts (prefill pending). */
		onRequest(ctx: ExtensionContext | undefined, at: number): void {
			if (!deps.isActive()) return;
			rememberCtx(ctx);
			if (!deps.isOurs(ctx) || !deps.enabled()) {
				clearStatus(targetCtx(ctx));
				resetInternal();
				return;
			}
			state = "prefill";
			prefillStart = at;
			firstTokenAt = undefined;
			tokenCount = 0;
			samples = [{ ts: at, n: 0 }];
			lastGenTps = undefined;
			render(ctx, at, true);
		},

		/** message_update: per-token stream events. */
		onToken(ctx: ExtensionContext | undefined, ev: AssistantMessageEvent, at: number): void {
			if (!deps.isActive() || !deps.enabled()) return;
			rememberCtx(ctx);
			if (!deps.isOurs(ctx)) return;
			if (ev.type === "error") {
				// Stream failed/aborted: finalize what we have.
				state = "done";
				render(ctx, at, true);
				return;
			}
			if (!DELTA_EVENT_TYPES.has(ev.type)) return;
			if (state === "prefill" || state === "idle") {
				state = "streaming";
				if (firstTokenAt === undefined) firstTokenAt = at;
			}
			tokenCount++;
			samples.push({ ts: at, n: tokenCount });
			render(ctx, at);
		},

		/** message_end (assistant only): finalize the call, compute prefill rate. */
		onMessageEnd(ctx: ExtensionContext | undefined, message: unknown, at: number): void {
			if (!deps.isActive() || !deps.enabled()) return;
			rememberCtx(ctx);
			if (!deps.isOurs(ctx)) return;
			const role = (message as { role?: string } | undefined)?.role;
			if (role !== "assistant") return;
			const usage = (message as { usage?: { input?: unknown; prompt_tokens?: unknown } } | undefined)?.usage;
			// Prompt tokens: pi's `usage.input` (OpenAI-style `prompt_tokens` as fallback).
			const promptTokens = typeof usage?.input === "number" ? usage.input : typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
			if (
				promptTokens !== undefined &&
				promptTokens > 0 &&
				prefillStart !== undefined &&
				firstTokenAt !== undefined
			) {
				const spanS = (firstTokenAt - prefillStart) / 1000;
				if (spanS >= PREFILL_MIN_SPAN_S) {
					lastPrefillTps = promptTokens / spanS;
					debugLog(`prefill ${Math.round(lastPrefillTps)} t/s (${promptTokens} tok / ${spanS.toFixed(3)}s)`);
				}
			}
			state = "done";
			render(ctx, at, true);
		},

		/** turn_end: back to idle. */
		onTurnEnd(ctx: ExtensionContext | undefined): void {
			rememberCtx(ctx);
			if (!deps.isActive() || !deps.enabled()) {
				clearStatus(targetCtx(ctx));
				resetInternal();
				return;
			}
			if (!deps.isOurs(ctx)) {
				clearStatus(targetCtx(ctx));
				resetInternal();
				return;
			}
			state = "idle";
			tokenCount = 0;
			samples = [];
			lastGenTps = undefined;
			render(ctx, Date.now(), true);
		},

		/** Server-side /metrics state (from metrics.ts poller). */
		onServerState(ctx: ExtensionContext | undefined, st: ServerMetricsState | null): void {
			server = st;
			if (!deps.isActive() || !deps.enabled()) return;
			const target = targetCtx(ctx);
			if (!target || !deps.isOurs(target)) return;
			// Only worth a render when idle (the supplement is only shown then).
			if (state === "idle") render(target, Date.now(), true);
		},

		/** Render the current (idle) state on session start / model select. */
		start(ctx: ExtensionContext | undefined): void {
			if (!deps.isActive()) return;
			rememberCtx(ctx);
			const target = targetCtx(ctx);
			if (!deps.enabled() || !target || !deps.isOurs(target)) {
				clearStatus(targetCtx(ctx));
				return;
			}
			state = "idle";
			render(target, Date.now(), true);
		},

		/** Hide the footer metrics (session shutdown, toggle off, foreign model). */
		stop(ctx: ExtensionContext | undefined): void {
			clearStatus(targetCtx(ctx));
			resetInternal();
		},
	};
}

export type SpeedTracker = ReturnType<typeof createSpeedTracker>;
