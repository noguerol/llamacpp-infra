// Standalone behavior test for provider registration limits.
// Run: node --experimental-strip-types test/registration.test.ts

import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_PROVIDER_TIMEOUT_MS, DEFAULT_SETTINGS } from "../src/core.ts";
import { buildAndRegisterProvider } from "../src/registration.ts";
import type { InfraConfig, ScanResult } from "../src/types.ts";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

console.log("registration: output cap and stream timeout hook");

let registeredProvider: any;
const pi: any = {
	unregisterProvider: () => undefined,
	registerProvider: (_name: string, config: any) => {
		registeredProvider = config;
	},
};

const config: InfraConfig = {
	servers: [{ id: "local", host: "127.0.0.1", ports: [8080], enabled: true }],
	settings: { ...DEFAULT_SETTINGS },
	modelOptions: {},
};

const scan: ScanResult = {
	totalModels: 3,
	serversUp: 1,
	serversTotal: 1,
	endpoints: [
		{
			ok: true,
			serverId: "local",
			host: "127.0.0.1",
			port: 8080,
			baseUrl: "http://127.0.0.1:8080/v1",
			server: "llamacpp",
			mode: "router",
			latencyMs: 1,
			models: [
				{ id: "big-context-qwen.gguf", meta: { n_ctx: 131_072 } },
				{ id: "small-context-llama.gguf", meta: { n_ctx: 4096 } },
				{ id: "server-explicit.gguf", meta: { n_ctx: 131_072 }, max_tokens: 65_536 },
			],
			meta: new Map(),
		},
	],
};

const models = buildAndRegisterProvider(pi, scan, config, { persistCache: false });
const byServerId = new Map(models.map((m) => [m.serverModelId, m]));

check(
	"large-context models default to 32768 output tokens",
	byServerId.get("big-context-qwen.gguf")?.maxTokens === DEFAULT_MAX_OUTPUT_TOKENS,
	String(byServerId.get("big-context-qwen.gguf")?.maxTokens),
);
check(
	"small-context models stay bounded by context",
	byServerId.get("small-context-llama.gguf")?.maxTokens === 4096,
	String(byServerId.get("small-context-llama.gguf")?.maxTokens),
);
check(
	"server-reported explicit max_tokens is respected",
	byServerId.get("server-explicit.gguf")?.maxTokens === 65_536,
	String(byServerId.get("server-explicit.gguf")?.maxTokens),
);
check("provider uses the long-timeout stream wrapper", typeof registeredProvider?.streamSimple === "function");

if (failures > 0) {
	console.error(`registration tests failed: ${failures}`);
	process.exit(1);
}
console.log("registration tests passed");
