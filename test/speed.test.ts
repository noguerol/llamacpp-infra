// Standalone behavior test for the client-side speed tracker (src/speed.ts).
// Run: node --experimental-strip-types test/speed.test.ts

import { createSpeedTracker } from "../src/speed.ts";
import type { AssistantMessageEvent, ServerMetricsState } from "../src/types.ts";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
	if (cond) {
		console.log(`  ✓ ${label}`);
	} else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function makeCtx(ours: boolean) {
	const lines: string[] = [];
	const ctx: any = {
		model: {
			provider: ours ? "llamacpp-infra" : "anthropic",
			id: "m1",
			baseUrl: "http://127.0.0.1:8080/v1",
		},
		ui: {
			setStatus: (_key: string, text: string | undefined) => {
				lines.length = 0;
				if (text !== undefined) lines.push(text);
			},
			theme: { fg: (_c: string, t: string) => t },
		},
	};
	return { ctx, lines };
}

const delta = (n: number): AssistantMessageEvent =>
	({ type: "text_delta", contentIndex: 0, delta: "x", partial: {} } as AssistantMessageEvent);

console.log("speed tracker: basic turn lifecycle");
{
	const { ctx, lines } = makeCtx(true);
	const tracker = createSpeedTracker({
		isActive: () => true,
		hasUI: (c) => !!c?.ui,
		isOurs: (c) => c?.model?.provider === "llamacpp-infra",
		enabled: () => true,
	});

	tracker.onRequest(ctx, 0);
	check("prefill line before first token", lines.join() === "⚡…", lines.join());

	// First token at t=2000 → streaming. No rate yet (window span < 300 ms).
	tracker.onToken(ctx, delta(1), 2000);
	check("streaming line shows pending rate", lines.join() === "🔥…", lines.join());

	// 29 more tokens at 40 ms intervals (25 t/s steady).
	for (let i = 2; i <= 30; i++) tracker.onToken(ctx, delta(i), 2000 + (i - 1) * 40);
	const line = lines.join();
	const m = line.match(/🔥 ([\d.]+) t\/s/);
	const rate = m ? parseFloat(m[1]) : NaN;
	check("gen rate ≈ 25 t/s (moving window)", Math.abs(rate - 25) <= 2, line);

	// Message ends: usage.input gives 3000 prompt tokens, prefill span 2.0 s → 1500 t/s.
	tracker.onMessageEnd(ctx, { role: "assistant", usage: { input: 3000, output: 30 } }, 3200);
	const done = lines.join();
	check("done line keeps gen + prefill rates", /🔥 .*t\/s/.test(done) && /⚡ 1500 t\/s/.test(done), done);

	tracker.onTurnEnd(ctx);
	check("idle line after turn end", lines.join() === "⏸", lines.join());

	// Server supplement while idle: other clients busy.
	tracker.onServerState(ctx, { processing: 2, promptTps: 150, genTps: 18 } satisfies ServerMetricsState);
	const sup = lines.join();
	check("server supplement shown while idle", /▶2/.test(sup) && /⚡ 150 t\/s/.test(sup) && /🔥 18\.0 t\/s/.test(sup), sup);

	tracker.onServerState(ctx, null);
	check("back to plain idle", lines.join() === "⏸", lines.join());
}

console.log("speed tracker: foreign model");
{
	const { ctx, lines } = makeCtx(false);
	const tracker = createSpeedTracker({
		isActive: () => true,
		hasUI: (c) => !!c?.ui,
		isOurs: (c) => c?.model?.provider === "llamacpp-infra",
		enabled: () => true,
	});
	tracker.start(ctx);
	check("no widget for foreign model", lines.length === 0);
	tracker.onRequest(ctx, 0);
	check("no widget on foreign request", lines.length === 0);
}

console.log("speed tracker: disabled widget");
{
	const { ctx, lines } = makeCtx(true);
	const tracker = createSpeedTracker({
		isActive: () => true,
		hasUI: (c) => !!c?.ui,
		isOurs: (c) => c?.model?.provider === "llamacpp-infra",
		enabled: () => false,
	});
	tracker.start(ctx);
	check("no widget when disabled", lines.length === 0);
	tracker.onRequest(ctx, 0);
	check("no widget on request when disabled", lines.length === 0);
}

console.log("speed tracker: render throttle (no spam)");
{
	const { ctx, lines } = makeCtx(true);
	let renders = 0;
	const ctxCount: any = {
		...ctx,
		ui: {
			...ctx.ui,
			setStatus: (_key: string, text: string | undefined) => {
				renders++;
				lines.length = 0;
				if (text !== undefined) lines.push(text);
			},
		},
	};
	const tracker = createSpeedTracker({
		isActive: () => true,
		hasUI: (c) => !!c?.ui,
		isOurs: (c) => c?.model?.provider === "llamacpp-infra",
		enabled: () => true,
	});
	tracker.onRequest(ctxCount, 0);
	for (let i = 1; i <= 50; i++) tracker.onToken(ctxCount, delta(i), i * 20); // 50 t/s over 1 s
	// 1 s of 20 ms tokens → renders at most ~11 (100 ms throttle).
	check("throttled renders (≤ 12)", renders <= 12, `renders=${renders}`);
	const m = lines.join().match(/🔥 ([\d.]+) t\/s/);
	const rate = m ? parseFloat(m[1]) : NaN;
	check("gen rate ≈ 50 t/s", Math.abs(rate - 50) <= 6, lines.join());
}

console.log("speed tracker: dedup (no redundant status updates)");
{
	const { ctx } = makeCtx(true);
	let updates = 0;
	const ctxDup: any = {
		...ctx,
		ui: {
			...ctx.ui,
			setStatus: (_key: string, _text: string | undefined) => {
				updates++;
			},
		},
	};
	const tracker = createSpeedTracker({
		isActive: () => true,
		hasUI: (c) => !!c?.ui,
		isOurs: (c) => c?.model?.provider === "llamacpp-infra",
		enabled: () => true,
	});
	tracker.onRequest(ctxDup, 0); // "⚡…" → 1 update
	tracker.onRequest(ctxDup, 1000); // identical text, forced render → dedup skips
	check("identical prefill text sent once", updates === 1, `updates=${updates}`);
	tracker.onToken(ctxDup, delta(1), 1500); // streaming → different text
	tracker.onTurnEnd(ctxDup); // "⏸"
	tracker.onServerState(ctxDup, { processing: 2, promptTps: 150, genTps: 18 });
	const after = updates;
	tracker.onServerState(ctxDup, { processing: 2, promptTps: 150, genTps: 18 }); // same snapshot → dedup skips
	check("identical server snapshot sent once", updates === after, `updates=${after}→${updates}`);
	tracker.onServerState(ctxDup, null); // idle again → text changes
	check("state changes still update", updates === after + 1, `updates=${updates}`);
}

if (failures > 0) {
	console.error(`\n${failures} check(s) FAILED`);
	process.exit(1);
}
console.log("\nAll checks passed ✅");
