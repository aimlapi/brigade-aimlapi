/**
 * Tests for the AI/ML API Toolbox web-search + web-fetch providers. Network is
 * replaced by an injected fetch, so these pin the request shape, the host /
 * redirect policy for the key, and response normalization.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../../config/io.js";
import type { WebProviderContext } from "../types.js";
import { BUNDLED_MODULES } from "./index.js";
import {
	AIMLAPI_TOOLBOX_RUN_ENDPOINT,
	createAimlapiFetchProvider,
	createAimlapiSearchProvider,
	resolveAimlapiApiKey,
} from "./aimlapi.js";

interface Captured {
	url: string;
	init: RequestInit;
}

function fakeFetch(body: unknown, status = 200, captured: Captured[] = []): typeof fetch {
	return (async (url: string | URL | Request, init?: RequestInit) => {
		captured.push({ url: String(url), init: init ?? {} });
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
}

function ctx(env: NodeJS.ProcessEnv, config: BrigadeConfig = {} as BrigadeConfig): WebProviderContext {
	return { config, env } as unknown as WebProviderContext;
}

describe("aimlapi — registration and key resolution", () => {
	it("is a bundled module that registers both a search and a fetch provider", () => {
		const mod = BUNDLED_MODULES.find((m) => m.id === "aimlapi");
		assert.ok(mod, "aimlapi missing from BUNDLED_MODULES");
		const ids: string[] = [];
		mod!.register({
			webFetch: (p: { id: string }) => ids.push(`fetch:${p.id}`),
			webSearch: (p: { id: string }) => ids.push(`search:${p.id}`),
		} as never);
		assert.deepEqual(ids.sort(), ["fetch:aimlapi", "search:aimlapi"]);
	});

	it("reads AIMLAPI_API_KEY, then AIML_API_KEY, and is unconfigured without either", () => {
		const cfg = {} as BrigadeConfig;
		assert.equal(resolveAimlapiApiKey(cfg, { AIMLAPI_API_KEY: "a" }, "search"), "a");
		assert.equal(resolveAimlapiApiKey(cfg, { AIML_API_KEY: "b" }, "fetch"), "b");
		assert.equal(createAimlapiSearchProvider().isConfigured(cfg, {}), false);
		assert.equal(createAimlapiFetchProvider().createTool(ctx({})), null);
	});

	it("one configured key covers both sides", () => {
		const cfg = { tools: { web: { search: { providers: { aimlapi: { apiKey: "from-search" } } } } } } as unknown as BrigadeConfig;
		assert.equal(resolveAimlapiApiKey(cfg, {}, "fetch"), "from-search");
	});

	it("sorts after the providers an operator already configured explicitly", () => {
		// Lower autoDetectOrder wins: Firecrawl fetch is 10, Brave/Exa/Firecrawl search ≤ 50.
		assert.ok(createAimlapiFetchProvider().autoDetectOrder! > 10);
		assert.ok(createAimlapiSearchProvider().autoDetectOrder! > 50);
		assert.ok(createAimlapiSearchProvider().autoDetectOrder! < 100); // still beats keyless DuckDuckGo
	});
});

describe("aimlapi — key only goes to tools.aimlapi.com", () => {
	it("posts to the exact Toolbox host over https with Bearer auth and refuses redirects", async () => {
		const captured: Captured[] = [];
		const tool = createAimlapiSearchProvider(
			fakeFetch({ status: "completed", is_error: false, output: { results: [] } }, 200, captured),
		).createTool(ctx({ AIMLAPI_API_KEY: "test-key" }))!;
		await tool.execute({ query: "brigade" });
		assert.equal(captured.length, 1);
		const u = new URL(captured[0]!.url);
		assert.equal(u.protocol, "https:");
		assert.equal(u.hostname, "tools.aimlapi.com");
		assert.equal(captured[0]!.url, AIMLAPI_TOOLBOX_RUN_ENDPOINT);
		const headers = captured[0]!.init.headers as Record<string, string>;
		assert.equal(headers.authorization, "Bearer test-key");
		assert.equal(captured[0]!.init.redirect, "error");
		assert.deepEqual(JSON.parse(String(captured[0]!.init.body)), {
			tool: "web/search",
			input: { query: "brigade", max_results: 5 },
		});
	});

	it("ignores a configured baseUrl, so the key can't be pointed at another host", async () => {
		const captured: Captured[] = [];
		const cfg = {
			tools: { web: { fetch: { providers: { aimlapi: { apiKey: "k", baseUrl: "https://evil.example.com" } } } } },
		} as unknown as BrigadeConfig;
		const tool = createAimlapiFetchProvider(
			fakeFetch({ status: "completed", output: { url: "https://x.test/", content: "hi" } }, 200, captured),
		).createTool(ctx({}, cfg))!;
		await tool.execute({ url: "https://x.test" });
		assert.equal(new URL(captured[0]!.url).hostname, "tools.aimlapi.com");
		assert.ok(!captured.some((c) => c.url.includes("evil.example.com")));
	});

	it("a redirect fails the call instead of following it with the key", async () => {
		// Real fetch semantics for redirect:"error": the response is a network error.
		const redirectingFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			if (init?.redirect === "error") throw new TypeError("fetch failed: unexpected redirect");
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		const tool = createAimlapiSearchProvider(redirectingFetch).createTool(ctx({ AIMLAPI_API_KEY: "k" }))!;
		await assert.rejects(() => tool.execute({ query: "q" }), /redirect/);
	});
});

describe("aimlapi — response normalization", () => {
	it("maps web/search results to wrapped search hits", async () => {
		const tool = createAimlapiSearchProvider(
			fakeFetch({
				status: "completed",
				is_error: false,
				output: {
					results: [
						{ title: "Brigade", url: "https://github.com/spinabot/brigade", snippet: "Agent runtime" },
						{ title: "", url: "https://dropped.test" },
					],
				},
			}),
		).createTool(ctx({ AIMLAPI_API_KEY: "k" }))!;
		const out = (await tool.execute({ query: "brigade", count: 2 })) as {
			provider: string;
			results: Array<{ url: string; title: string }>;
		};
		assert.equal(out.provider, "aimlapi");
		assert.equal(out.results.length, 1);
		assert.equal(out.results[0]!.url, "https://github.com/spinabot/brigade");
		assert.match(out.results[0]!.title, /Brigade/);
	});

	it("returns the fetched page as Markdown", async () => {
		const tool = createAimlapiFetchProvider(
			fakeFetch({
				status: "completed",
				output: { url: "https://example.com/", title: "Example Domain", content: "# Example Domain\n\nBody" },
			}),
		).createTool(ctx({ AIMLAPI_API_KEY: "k" }))!;
		const out = (await tool.execute({ url: "https://example.com" })) as {
			provider: string;
			finalUrl: string;
			title: string;
			text: string;
			contentType: string;
		};
		assert.equal(out.provider, "aimlapi");
		assert.equal(out.finalUrl, "https://example.com/");
		assert.equal(out.title, "Example Domain");
		assert.equal(out.contentType, "text/markdown");
		assert.match(out.text, /^# Example Domain/);
	});

	it("surfaces upstream errors without leaking control characters", async () => {
		const tool = createAimlapiSearchProvider(
			fakeFetch({ error: { message: "bad key\u0007\nretry" } }, 401),
		).createTool(ctx({ AIMLAPI_API_KEY: "k" }))!;
		await assert.rejects(() => tool.execute({ query: "q" }), (err: Error) => {
			assert.match(err.message, /HTTP 401/);
			assert.ok(!/[\x00-\x1f]/.test(err.message));
			return true;
		});
	});

	it("treats a failed run as an error", async () => {
		const tool = createAimlapiFetchProvider(
			fakeFetch({ status: "failed", is_error: true, output: null }),
		).createTool(ctx({ AIMLAPI_API_KEY: "k" }))!;
		await assert.rejects(() => tool.execute({ url: "https://x.test" }), /failed/);
	});
});
