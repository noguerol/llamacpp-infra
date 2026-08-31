// Standalone behavior test for llamacpp-infra runtime request defaults.
// Run: node --experimental-strip-types test/runtime.test.ts

import { DEFAULT_PROVIDER_TIMEOUT_MS } from "../src/core.ts";
import { withLocalRuntimeDefaults } from "../src/runtime.ts";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

console.log("runtime defaults: timeout floor");

check(
	"missing timeout becomes 20 minutes",
	withLocalRuntimeDefaults(undefined).timeoutMs === DEFAULT_PROVIDER_TIMEOUT_MS,
	String(withLocalRuntimeDefaults(undefined).timeoutMs),
);

check(
	"shorter timeout is raised to 20 minutes",
	withLocalRuntimeDefaults({ timeoutMs: 300_000 }).timeoutMs === DEFAULT_PROVIDER_TIMEOUT_MS,
	String(withLocalRuntimeDefaults({ timeoutMs: 300_000 }).timeoutMs),
);

check(
	"longer timeout is preserved",
	withLocalRuntimeDefaults({ timeoutMs: 3_600_000 }).timeoutMs === 3_600_000,
	String(withLocalRuntimeDefaults({ timeoutMs: 3_600_000 }).timeoutMs),
);

check(
	"other stream options are preserved",
	withLocalRuntimeDefaults({ maxRetries: 0, maxTokens: 1024 }).maxTokens === 1024,
	JSON.stringify(withLocalRuntimeDefaults({ maxRetries: 0, maxTokens: 1024 })),
);

if (failures > 0) {
	console.error(`runtime defaults tests failed: ${failures}`);
	process.exit(1);
}
console.log("runtime defaults tests passed");
