// Energy-cost estimation for local inference.
//
// Local servers report no per-token cost, so the honest cost is the
// electricity the inference consumed:
//
//   cost = (inferenceMs / 3_600_000) × kW × tariff
//
// Profiles are configured per server (the power draw belongs to the machine,
// not the model). The currency selector (settings.currency) only changes the
// display unit — the stored tariff is always per kWh in the chosen currency.

import type { Currency, CostProfile, ServerConfig } from "./types.ts";

// ── Currency display ────────────────────────────────────────────────────────
export const CURRENCIES: Array<{ code: Currency; symbol: string; cent: string; label: string }> = [
	{ code: "usd", symbol: "$", cent: "¢", label: "USD ($)" },
	{ code: "eur", symbol: "€", cent: "c", label: "EUR (€)" },
	{ code: "gbp", symbol: "£", cent: "p", label: "GBP (£)" },
	{ code: "cny", symbol: "¥", cent: "分", label: "CNY (¥)" },
];

export function currencySymbol(code: Currency | undefined): string {
	return CURRENCIES.find((c) => c.code === code)?.symbol ?? "€";
}

/** Cent/fractional marker of a currency: $→¢, €→c, £→p, ¥→分. */
export function currencyCent(code: Currency | undefined): string {
	return CURRENCIES.find((c) => c.code === code)?.cent ?? "c";
}

/**
 * Format an amount in the chosen currency, compact:
 *   1.234  → "$1.23"      (≥ 1 unit: symbol + 2 decimals)
 *   0.0315 → "3.2¢" (usd) / "3.2c" (eur) / "3.2p" (gbp) / "3.2分" (cny)
 *   0.0004 → "0.4m¢"      (sub-cent: milli-units)
 */
export function formatCost(amount: number, code: Currency | undefined): string {
	const sym = currencySymbol(code);
	if (amount >= 1) return `${sym}${amount.toFixed(2)}`;
	const cent = currencyCent(code);
	if (amount >= 0.001) return `${(amount * 100).toFixed(1)}${cent}`;
	return `${(amount * 1000).toFixed(1)}m${cent}`;
}

// ── Profile resolution ──────────────────────────────────────────────────────
/**
 * Find the cost profile that applies to a model, or null when none match.
 *
 * A profile is attached to a server (ServerConfig.costProfile): the power
 * draw is a property of the machine, so all models served by that server
 * share it. Resolution order:
 *   1. server match (endpoint.serverId → ServerConfig.id)
 *   2. host fallback: endpoint host equals the server's host (covers scans
 *      whose serverId drifted from the config, e.g. cache boot)
 *   3. per-profile `pattern`: substring match on the model id, for machines
 *      that serve very different workloads (rare; kept for flexibility)
 */
export function resolveCostProfile(
	model: { id?: string; endpoint?: { serverId?: string; host?: string } },
	servers: ServerConfig[],
): CostProfile | null {
	if (!model?.id) return null;
	const endpoint = model.endpoint;

	// 1. Server id match (primary).
	if (endpoint?.serverId) {
		const srv = servers.find((s) => s.id === endpoint.serverId);
		if (srv?.costProfile && srv.costProfile.kW > 0) return srv.costProfile;
	}
	// 2. Host fallback.
	if (endpoint?.host) {
		for (const srv of servers) {
			if (srv.costProfile && srv.costProfile.kW > 0 && srv.host === endpoint.host) return srv.costProfile;
		}
	}
	// 3. Model-id pattern (rare; only when explicitly set).
	for (const srv of servers) {
		const p = srv.costProfile;
		if (p && p.kW > 0 && p.pattern && model.id.toLowerCase().includes(p.pattern.toLowerCase())) return p;
	}
	return null;
}

// ── Cost math ───────────────────────────────────────────────────────────────
/** Energy cost (in the configured currency) of `ms` of inference. */
export function energyCost(profile: CostProfile, ms: number): number {
	if (!profile || ms <= 0) return 0;
	const kwh = (ms / 3_600_000) * profile.kW;
	return kwh * profile.ratePerKwh;
}

/** Format a profile for display, e.g. "0.15 kW @ 0.21 €/kWh". */
export function formatProfile(p: CostProfile, code: Currency | undefined): string {
	return `${p.kW} kW @ ${p.ratePerKwh} ${currencySymbol(code)}/kWh`;
}
