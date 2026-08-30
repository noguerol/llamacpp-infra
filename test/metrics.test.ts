// End-to-end test: fake llama.cpp server exposing prometheus /metrics,
// metrics.ts poller → ServerMetricsState → speed tracker widget supplement.
// Run: node --experimental-strip-types test/metrics.test.ts

import * as http from "node:http";
import { createSpeedTracker } from "../src/speed.ts";
import { createMetrics } from "../src/metrics.ts";
import type { ServerMetricsState } from "../src/types.ts";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

// ── Fake llama-server with --metrics ───────────────────────────────────────
// Gauges mirror the live rate: non-zero only while the server is actually
// processing (like a real llama.cpp server).
let promptTotal = 3000;
let predictedTotal = 120;
let processing = 2;
let grow = false;
let promptGauge = 150;
let predictedGauge = 18;

const growth = setInterval(() => {
	if (!grow) return;
	promptTotal += 500; // ≈ 5000 t/s
	predictedTotal += 50; // ≈ 500 t/s
}, 100);

const server = http.createServer((req, res) => {
	if (req.url === "/metrics") {
		res.writeHead(200, { "Content-Type": "text/plain" });
		const pg = grow ? 5000 : processing > 0 ? promptGauge : 0;
		const gg = grow ? 500 : processing > 0 ? predictedGauge : 0;
		res.end(
			[
				"# HELP llamacpp:prompt_tokens_total Total prompt tokens processed",
				`llamacpp:prompt_tokens_total ${promptTotal}`,
				"# HELP llamacpp:predicted_tokens_total Total predicted tokens",
				`llamacpp:predicted_tokens_total ${predictedTotal}`,
				`llamacpp:requests_processing ${processing}`,
				`llamacpp:prompt_tokens_seconds ${pg}`,
				`llamacpp:predicted_tokens_seconds ${gg}`,
			].join("\n"),
		);
		return;
	}
	res.writeHead(404, { "Content-Type": "text/plain" });
	res.end("not found");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const baseUrl = `http://127.0.0.1:${port}/v1`;

// ── Wire poller → tracker like index.ts does ──────────────────────────────
const lines: string[] = [];
const ctx: any = {
	model: { provider: "llamacpp-infra", id: "m1", baseUrl },
	ui: {
		setStatus: (_key: string, text: string | undefined) => {
			lines.length = 0;
			if (text !== undefined) lines.push(text);
		},
		theme: { fg: (_c: string, t: string) => t },
	},
};

const tracker = createSpeedTracker({
	isActive: () => true,
	hasUI: (c) => !!c?.ui,
	isOurs: (c) => c?.model?.provider === "llamacpp-infra",
	enabled: () => true,
});

let lastState: ServerMetricsState | null = null;
const poller = createMetrics({
	isActive: () => true,
	pollIntervalMs: () => 300,
	enabled: () => true,
	onServerState: (_ctx, st) => {
		lastState = st;
		tracker.onServerState(ctx, st);
	},
});

console.log("metrics poller → tracker (fake /metrics server)");
tracker.start(ctx);
check("idle line at start", lines.join() === "📊 · ⏸ idle", lines.join());

poller.start(ctx);
await new Promise((r) => setTimeout(r, 600));

check(
	"supplement shown while pi idle, server busy",
	/▶ 2/.test(lines.join()) && /⚡ 150/.test(lines.join()) && /🔥 18\.0/.test(lines.join()) && /server/.test(lines.join()),
	lines.join(),
);

// Advance server counters continuously → polls derive rates from counter deltas.
grow = true;
await new Promise((r) => setTimeout(r, 900)); // a few polls at ~5000/500 t/s
check(
	"counter-delta rates (⚡≈5000 t/s, 🔥≈500 t/s)",
	/⚡ 4[5-9][0-9][0-9]|⚡ 5[0-5][0-9][0-9]/.test(lines.join()) &&
		/🔥 4[5-9][0-9]|🔥 5[0-5][0-9]/.test(lines.join()),
	lines.join(),
);

// Server goes idle → plain idle line.
processing = 0;
await new Promise((r) => setTimeout(r, 800));
check("plain idle when server idle", lines.join() === "📊 · ⏸ idle", lines.join());

poller.stop(ctx);
await new Promise((r) => setTimeout(r, 100));
clearInterval(growth);
server.close();

if (failures > 0) {
	console.error(`\n${failures} check(s) FAILED`);
	process.exit(1);
}
console.log("\nAll checks passed ✅");
