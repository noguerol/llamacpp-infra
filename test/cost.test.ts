// Standalone behavior test for the energy-cost utilities (src/cost.ts) and the
// cost tracker (src/cost-tracker.ts).
// Run: node --experimental-strip-types test/cost.test.ts

import { energyCost, formatCost, resolveCostProfile } from "../src/cost.ts";
import { createCostTracker } from "../src/cost-tracker.ts";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
	if (cond) {
		console.log(`  ✓ ${label}`);
	} else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

// ── cost.ts: math ──────────────────────────────────────────────────────────
console.log("cost.ts: energy math");
{
	const profile = { kW: 0.15, ratePerKwh: 0.21, label: "bruma" };
	// 1 h of inference at 150 W × 0.21 €/kWh = 0.0315 €
	check("1h @150W × 0.21 = €0.0315", Math.abs(energyCost(profile, 3_600_000) - 0.0315) < 1e-12);
	// 2 min = 120_000 ms → 0.00105 €
	check("2min → €0.00105", Math.abs(energyCost(profile, 120_000) - 0.00105) < 1e-12);
	check("0 ms → 0", energyCost(profile, 0) === 0);
}

console.log("cost.ts: profile resolution");
{
	const servers = [
		{ id: "local", host: "127.0.0.1", label: "Local", ports: [8080, 8081], enabled: true, costProfile: { kW: 0.15, ratePerKwh: 0.21, label: "bruma" } },
		{ id: "tower", host: "bruma", label: "Bruma", ports: [8081], enabled: true },
	];
	check("serverId match → profile", resolveCostProfile({ id: "llamacpp-infra/qwen", endpoint: { serverId: "local" } }, servers)?.kW === 0.15);
	check("host fallback hits local for 127.0.0.1", resolveCostProfile({ id: "x", endpoint: { host: "127.0.0.1" } }, servers)?.label === "bruma");
	check("no profile server → null", resolveCostProfile({ id: "llamacpp-infra/ling", endpoint: { serverId: "tower" } }, servers) === null);
	check("no endpoint + no pattern → null", resolveCostProfile({ id: "deepseek/x" }, servers) === null);
}

console.log("cost.ts: currency formatting");
{
	check("usd cents", formatCost(0.0315, "usd") === "3.1¢", formatCost(0.0315, "usd"));
	check("usd dollars", formatCost(1.234, "usd") === "$1.23", formatCost(1.234, "usd"));
	check("usd milli", formatCost(0.0004, "usd") === "0.4m¢", formatCost(0.0004, "usd"));
	check("eur cents", formatCost(0.0315, "eur") === "3.1c", formatCost(0.0315, "eur"));
	check("eur dollars", formatCost(5.5, "eur") === "€5.50", formatCost(5.5, "eur"));
	check("gbp pence", formatCost(0.03, "gbp") === "3.0p", formatCost(0.03, "gbp"));
	check("cny fen", formatCost(0.0315, "cny") === "3.1分", formatCost(0.0315, "cny"));
	check("cny yuan", formatCost(9.99, "cny") === "¥9.99", formatCost(9.99, "cny"));
}

// ── cost-tracker.ts: lifecycle ─────────────────────────────────────────────
console.log("cost-tracker: lifecycle");
{
	const profile = { kW: 0.15, ratePerKwh: 0.21, label: "bruma" };
	const statuses: string[] = [];
	const tracker = createCostTracker({
		isActive: () => true,
		hasUI: (c) => !!c?.ui,
		isOurs: (c) => c?.model?.provider === "llamacpp-infra",
		enabled: () => true,
		currency: () => "eur" as const,
		profileFor: () => profile,
	});
	const ctx = {
		model: { provider: "llamacpp-infra", id: "m1" },
		ui: { setStatus: (_k: string, t: string | undefined) => { statuses.length = 0; if (t !== undefined) statuses.push(t); } },
	};

	const t0 = 1_000_000;
	tracker.onRequest(ctx, t0);
	const c1 = tracker.onMessageEnd(ctx, { role: "assistant", usage: { cost: { total: 0 } } }, t0 + 120_000);
	check("2min request charged €0.00105", Math.abs(c1 - 0.00105) < 1e-12, String(c1));

	const c2 = tracker.onMessageEnd(ctx, { role: "user" }, t0 + 300_000);
	check("user message not charged", c2 === 0, String(c2));

	tracker.onRequest({ ...ctx, model: { provider: "anthropic" } }, t0 + 400_000);
	check("foreign model resets accumulator", tracker.snapshot().total === 0);

	tracker.onRequest(ctx, t0 + 500_000);
	const c3 = tracker.onMessageEnd(ctx, { role: "assistant" }, t0 + 530_000);
	check("30s request charged €0.0002625", Math.abs(c3 - 0.0002625) < 1e-12, String(c3));
	check("session total = 30s request only", Math.abs(tracker.snapshot().total - 0.0002625) < 1e-12);
	check("footer shows 💰", statuses.some((s) => s.startsWith("💰")), JSON.stringify(statuses));

	tracker.reset(ctx);
	check("reset → 0", tracker.snapshot().total === 0);
	check("footer cleared after reset", statuses.length === 0, JSON.stringify(statuses));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
