// Energy-cost tracker: measures inference time of the active llamacpp-infra
// model from pi's stream events and accumulates the electricity cost.
//
//   cost per request = (requestMs / 3_600_000) × kW × tariff
//
// Timing: before_provider_request → message_end (assistant). This covers
// prefill + decode for one LLM call. Partial requests (errors/aborts) are
// still charged for the time actually consumed.
//
// The tracker exposes the accumulated cost so the footer can show it
// (⚡3.2¢) and the message_end hook can inject it into usage.cost, which pi
// then displays in its native cost footer — no trimegisto required.

import { COST_STATUS_KEY, debugLog } from "./core.ts";
import { formatCost } from "./cost.ts";
import type { CostProfile, Currency, ExtensionContext } from "./types.ts";


export interface CostDeps {
	/** Whether the extension is still active. */
	isActive: () => boolean;
	/** Whether the ctx has a UI. */
	hasUI: (ctx: ExtensionContext | undefined) => boolean;
	/** Whether the current session model belongs to this provider. */
	isOurs: (ctx: ExtensionContext | undefined) => boolean;
	/** Whether cost tracking is enabled in settings. */
	enabled: () => boolean;
	/** Display currency. */
	currency: () => Currency;
	/** Resolve the cost profile for the current model (null = no estimation). */
	profileFor: (ctx: ExtensionContext | undefined) => CostProfile | null;
}

export interface CostSnapshot {
	/** Accumulated cost for the current session (in the configured currency). */
	total: number;
	/** Accumulated inference time in ms. */
	ms: number;
	/** Whether a profile is active (estimation on). */
	active: boolean;
	/** In-flight request start (ms epoch) or 0. */
	inFlight: number;
}

/** Render the accumulated cost as a compact footer suffix, e.g. "💰3.2¢". */
export function formatCostSuffix(snap: CostSnapshot, currency: Currency): string {
	if (!snap.active || snap.total <= 0) return "";
	return `💰${formatCost(snap.total, currency)}`;
}

/** Push the cost line to pi's status footer (or clear it). */
function renderCostStatus(ctx: ExtensionContext | undefined, snap: CostSnapshot, currency: Currency): void {
	if (!ctx || !ctx.ui) return;
	const text = formatCostSuffix(snap, currency);
	try {
		ctx.ui.setStatus(COST_STATUS_KEY, text || undefined);
	} catch {
		// ignore
	}
}

export function createCostTracker(deps: CostDeps) {
	let reqStartAt: number | undefined;
	let totalMs = 0;
	let totalCost = 0;
	/** Live ctx for callbacks without one. */
	let lastCtx: ExtensionContext | undefined;

	function rememberCtx(ctx: ExtensionContext | undefined): void {
		if (ctx && deps.hasUI(ctx)) lastCtx = ctx;
	}

	function reset(): void {
		reqStartAt = undefined;
		totalMs = 0;
		totalCost = 0;
	}

	/** Charge a finished (or aborted) request; returns the cost of this request. */
	function chargeRequest(ctx: ExtensionContext | undefined, endAt: number): number {
		if (reqStartAt === undefined) return 0;
		const ms = Math.max(0, endAt - reqStartAt);
		reqStartAt = undefined;
		const profile = deps.profileFor(ctx ?? lastCtx);
		if (!profile || ms <= 0) return 0;
		const cost = (ms / 3_600_000) * profile.kW * profile.ratePerKwh;
		totalMs += ms;
		totalCost += cost;
		debugLog(`cost: +${ms}ms → +${cost.toFixed(6)} (session ${totalCost.toFixed(6)})`);
		return cost;
	}

	return {
		/** before_provider_request: a new LLM call starts. */
		onRequest(ctx: ExtensionContext | undefined, at: number): void {
			if (!deps.isActive()) return;
			rememberCtx(ctx);
			if (!deps.isOurs(ctx) || !deps.enabled()) {
				reset();
				return;
			}
			// A new request supersedes any uncharged one (shouldn't happen, but be safe).
			if (reqStartAt !== undefined) chargeRequest(ctx, at);
			reqStartAt = at;
		},

		/**
		 * message_end (assistant): finalize the call and charge it.
		 * Returns the cost of THIS request (0 when no profile/off), so callers
		 * can add just the delta to usage.cost.total of that message.
		 */
		onMessageEnd(ctx: ExtensionContext | undefined, message: unknown, at: number): number {
			if (!deps.isActive()) return 0;
			rememberCtx(ctx);
			if (!deps.isOurs(ctx)) return 0;
			const role = (message as { role?: string } | undefined)?.role;
			if (role !== "assistant") return 0;
			const charged = chargeRequest(ctx, at);
			renderCostStatus(ctx ?? lastCtx, this.snapshot(), deps.currency());
			return charged;
		},

		/** turn_end: nothing more to do (requests are charged at message_end). */
		onTurnEnd(_ctx: ExtensionContext | undefined): void {
			// no-op: kept for API symmetry with the speed tracker
		},

		/** Current accumulated view. */
		snapshot(): CostSnapshot {
			const profile = deps.profileFor(lastCtx);
			return {
				total: totalCost,
				ms: totalMs,
				active: !!profile && totalCost > 0,
				inFlight: reqStartAt ?? 0,
			};
		},

		/** Reset the session accumulator (model switch / session start). */
		reset(ctx?: ExtensionContext): void {
			reset();
			renderCostStatus(ctx ?? lastCtx, this.snapshot(), deps.currency());
		},
	};
}

export type CostTracker = ReturnType<typeof createCostTracker>;
