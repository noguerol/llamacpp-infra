// Runtime request defaults for the OpenAI-compatible llama.cpp provider.
// pi owns the normal SDK stream options, but this provider is for slow local
// models where long generations are expected. Keep a local floor so llamacpp-
// infra models don't inherit too-small global/default request timeouts.

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_PROVIDER_TIMEOUT_MS, shared } from "./core.ts";

type AssistantMessageEvent = any;
type AssistantMessage = any;
type StreamOptions = Record<string, any> | undefined;
type StreamSimple = (model: any, context: any, options?: Record<string, any>) => AsyncIterable<AssistantMessageEvent> & { result?: () => Promise<AssistantMessage> };

class ForwardedAssistantMessageEventStream implements AsyncIterable<AssistantMessageEvent> {
	private queue: AssistantMessageEvent[] = [];
	private waiting: Array<(result: IteratorResult<AssistantMessageEvent>) => void> = [];
	private done = false;
	private resolveFinal!: (value: AssistantMessage) => void;
	private readonly finalResult = new Promise<AssistantMessage>((resolve) => {
		this.resolveFinal = resolve;
	});

	push(event: AssistantMessageEvent): void {
		if (this.done) return;
		if (event?.type === "done") {
			this.done = true;
			this.resolveFinal(event.message);
		} else if (event?.type === "error") {
			this.done = true;
			this.resolveFinal(event.error);
		}

		const waiter = this.waiting.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.queue.push(event);
	}

	end(result?: AssistantMessage): void {
		this.done = true;
		if (result !== undefined) this.resolveFinal(result);
		while (this.waiting.length > 0) this.waiting.shift()?.({ value: undefined, done: true });
	}

	async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		for (;;) {
			if (this.queue.length > 0) {
				yield this.queue.shift();
			} else if (this.done) {
				return;
			} else {
				const next = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => this.waiting.push(resolve));
				if (next.done) return;
				yield next.value;
			}
		}
	}

	result(): Promise<AssistantMessage> {
		return this.finalResult;
	}
}

let openAICompletionsStreamPromise: Promise<StreamSimple> | undefined;

async function loadOpenAICompletionsStreamSimple(): Promise<StreamSimple> {
	if (!openAICompletionsStreamPromise) {
		openAICompletionsStreamPromise = (async () => {
			try {
				// pi's extension loader aliases the pi-ai ROOT specifier to the compat
				// entry (which re-exports openAICompletionsApi), so this import works in
				// every pi runtime (jiti aliases / virtual modules / tsconfig paths).
				// Subpath specifiers like "@earendil-works/pi-ai/api/openai-completions"
				// are NOT aliased and only resolve inside a real node_modules install.
				const mod = await import("@earendil-works/pi-ai");
				const streams = (mod as { openAICompletionsApi?: () => { streamSimple: StreamSimple } }).openAICompletionsApi?.();
				if (typeof streams?.streamSimple === "function") return streams.streamSimple;
			} catch {
				// fall through to the nested-module lookup below
			}
			// In real pi package installs, pi-ai may be nested under pi-coding-agent
			// instead of hoisted as a top-level dependency of this extension.
			const piIndexUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
			const piPackageDir = dirname(dirname(fileURLToPath(piIndexUrl)));
			const nestedModule = join(piPackageDir, "node_modules", "@earendil-works", "pi-ai", "dist", "api", "openai-completions.js");
			const nestedMod = await import(pathToFileURL(nestedModule).href);
			return (nestedMod as { streamSimple: StreamSimple }).streamSimple;
		})();
	}
	return openAICompletionsStreamPromise;
}

export function activeRequestTimeoutMs(): number {
	const configured = shared.activeConfig?.settings?.requestTimeoutMs;
	return typeof configured === "number" && Number.isFinite(configured) && configured > 0
		? configured
		: DEFAULT_PROVIDER_TIMEOUT_MS;
}

export function withLocalRuntimeDefaults(options: StreamOptions, floorMs?: number): Record<string, any> {
	const floor = typeof floorMs === "number" && Number.isFinite(floorMs) && floorMs > 0 ? floorMs : DEFAULT_PROVIDER_TIMEOUT_MS;
	const currentTimeout = typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs) ? options.timeoutMs : undefined;
	return {
		...(options ?? {}),
		timeoutMs: currentTimeout === undefined ? floor : Math.max(currentTimeout, floor),
	};
}

export function createLongTimeoutOpenAICompletionsStream(model: any, context: any, options?: Record<string, any>) {
	const out = new ForwardedAssistantMessageEventStream();
	void (async () => {
		try {
			const streamSimple = await loadOpenAICompletionsStreamSimple();
			const inner = streamSimple(model, context, withLocalRuntimeDefaults(options, activeRequestTimeoutMs()));
			for await (const event of inner) out.push(event);
			if (typeof inner.result === "function") out.end(await inner.result());
			else out.end();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			out.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model?.api ?? "openai-completions",
					provider: model?.provider ?? "llamacpp-infra",
					model: model?.id ?? "unknown",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "error",
					errorMessage: message,
					timestamp: Date.now(),
				},
			});
		}
	})();
	return out;
}
