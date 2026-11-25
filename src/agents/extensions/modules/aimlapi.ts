/**
 * AI/ML API Toolbox web-search + web-fetch provider — bundled, API-key-gated.
 *
 * Both sides call the Toolbox run endpoint (`POST /v1/tools/run`) with a
 * named tool and its input:
 *   - search → `web/search`            ({ query, max_results })
 *   - fetch  → `litescrape/web-fetch`  ({ url }) — page as Markdown
 *
 * Endpoint: https://tools.aimlapi.com/v1/tools/run (fixed, not configurable —
 * the key is only ever sent to that exact host, and redirects are refused so
 * it can't be bounced elsewhere).
 *
 * Auth: the same key as the AI/ML API model provider — `AIMLAPI_API_KEY`
 * (or `AIML_API_KEY`) env, or `tools.web.{search,fetch}.providers.aimlapi.apiKey`.
 * Runs are billed per call to the AI/ML API account.
 *
 * Keys: https://aimlapi.com/app/keys
 */

import { defineModule } from "../types.js";
import type {
	BrigadeExtensionContext,
	WebFetchProvider,
	WebProviderContext,
	WebProviderToolDefinition,
	WebSearchProvider,
} from "../types.js";
import type { BrigadeConfig } from "../../../config/io.js";
import { DEFAULT_TIMEOUT_SECONDS, readResponseText } from "../../tools/web-shared.js";
import {
	mergeSignals,
	resolveProviderApiKey,
	resolveSiteName,
	wrapSearchHit,
} from "./web-provider-helpers.js";

const AIMLAPI_TOOLBOX_HOST = "tools.aimlapi.com";
const AIMLAPI_TOOLBOX_RUN_ENDPOINT = `https://${AIMLAPI_TOOLBOX_HOST}/v1/tools/run`;
const AIMLAPI_ENV_VARS = ["AIMLAPI_API_KEY", "AIML_API_KEY"];
const AIMLAPI_SEARCH_TOOL = "web/search";
const AIMLAPI_FETCH_TOOL = "litescrape/web-fetch";

/* ─────────────────────────── shared key resolver ─────────────────────────── */

/**
 * Key for the given side: that side's config slot first, then the other
 * side's (one key covers both), then env. Sanitized for safe header use.
 */
function resolveAimlapiApiKey(
	cfg: BrigadeConfig,
	env: NodeJS.ProcessEnv | undefined,
	kind: "fetch" | "search",
): string | undefined {
	const other = kind === "search" ? "fetch" : "search";
	return (
		resolveProviderApiKey({ cfg, env, providerId: "aimlapi", kind, envVars: AIMLAPI_ENV_VARS }) ??
		resolveProviderApiKey({ cfg, env: {}, providerId: "aimlapi", kind: other, envVars: [] })
	);
}

/* ─────────────────────────── shared HTTP helper ─────────────────────────── */

interface RunToolboxOptions {
	tool: string;
	input: Record<string, unknown>;
	apiKey: string;
	timeoutMs: number;
	signal?: AbortSignal;
	/** Test seam — defaults to the global fetch. */
	fetchImpl?: typeof fetch;
}

/**
 * Run one Toolbox tool and return its `output` object. Throws on a non-2xx
 * status, a failed run, or an unparseable body.
 */
async function runAimlapiTool(opts: RunToolboxOptions): Promise<Record<string, unknown>> {
	const endpoint = new URL(AIMLAPI_TOOLBOX_RUN_ENDPOINT);
	// The key rides only to the exact Toolbox host over https.
	if (endpoint.protocol !== "https:" || endpoint.hostname !== AIMLAPI_TOOLBOX_HOST) {
		throw new Error("aimlapi: refusing to send the API key to an unexpected host");
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("timeout")), opts.timeoutMs);
	timer.unref?.();
	const combined = mergeSignals([opts.signal, controller.signal]);
	try {
		const response = await (opts.fetchImpl ?? fetch)(endpoint.toString(), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${opts.apiKey}`,
			},
			body: JSON.stringify({ tool: opts.tool, input: opts.input }),
			// A redirect would re-send the Authorization header to wherever it
			// points; the Toolbox never redirects, so treat one as an error.
			redirect: "error",
			signal: combined,
		});
		const { text: rawBody } = await readResponseText(response.body, 2_000_000);
		const json = (() => {
			try {
				return JSON.parse(rawBody) as Record<string, unknown>;
			} catch {
				return null;
			}
		})();
		if (response.status < 200 || response.status >= 300) {
			const upstream = (json?.error as { message?: unknown } | undefined)?.message;
			// Strip control chars and cap before surfacing — the upstream body
			// is attacker-influenceable text and lands in a thrown Error.message.
			const detail = (typeof upstream === "string" ? upstream : rawBody)
				.replace(/[\x00-\x1f\x7f]/g, " ")
				.slice(0, 200);
			throw new Error(`aimlapi: HTTP ${response.status} — ${detail}`);
		}
		if (!json) throw new Error("aimlapi: invalid JSON from upstream");
		if (json.is_error === true || (typeof json.status === "string" && json.status !== "completed")) {
			throw new Error(`aimlapi: ${opts.tool} run ${typeof json.status === "string" ? json.status : "failed"}`);
		}
		const output = json.output;
		if (!output || typeof output !== "object") throw new Error(`aimlapi: ${opts.tool} returned no output`);
		return output as Record<string, unknown>;
	} finally {
		clearTimeout(timer);
	}
}

/* ─────────────────────────── search provider ─────────────────────────── */

function createAimlapiSearchProvider(fetchImpl?: typeof fetch): WebSearchProvider {
	return {
		id: "aimlapi",
		label: "AI/ML API",
		hint: "AI/ML API Toolbox web search. Same key as the AI/ML API model provider.",
		requiresCredential: true,
		envVars: AIMLAPI_ENV_VARS,
		signupUrl: "https://aimlapi.com/app/keys",
		docsUrl: "https://docs.aimlapi.com",
		placeholder: "your AI/ML API key",
		// Keyed, so it beats the keyless DuckDuckGo (100), but every provider an
		// operator configured explicitly (Tavily, Brave, Exa, Firecrawl…) still wins.
		autoDetectOrder: 60,
		isConfigured(cfg, env) {
			return resolveAimlapiApiKey(cfg, env, "search") !== undefined;
		},
		createTool(ctx: WebProviderContext): WebProviderToolDefinition | null {
			const apiKey = resolveAimlapiApiKey(ctx.config, ctx.env, "search");
			if (!apiKey) return null;
			const timeoutMs = (ctx.runtime?.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000) | 0;
			return {
				description: "Search the web via AI/ML API. Returns ranked URL hits with titles + snippets.",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string" },
						count: { type: "integer", minimum: 1, maximum: 20 },
					},
					required: ["query"],
				},
				async execute(args, signal) {
					const query = String((args as { query?: unknown }).query ?? "").trim();
					if (!query) throw new Error("aimlapi: missing query");
					const count = Math.min(
						Math.max(Number((args as { count?: unknown }).count ?? 5) | 0, 1),
						20,
					);
					const output = await runAimlapiTool({
						tool: AIMLAPI_SEARCH_TOOL,
						input: { query, max_results: count },
						apiKey,
						timeoutMs,
						signal,
						fetchImpl,
					});
					const hits = Array.isArray(output.results)
						? (output.results as unknown[]).filter(
								(h): h is Record<string, unknown> => !!h && typeof h === "object",
							)
						: [];
					const results = hits
						.map((hit) => {
							const title = typeof hit.title === "string" ? hit.title.trim() : "";
							const url = typeof hit.url === "string" ? hit.url.trim() : "";
							if (!title || !url) return null;
							const snippet = typeof hit.snippet === "string" ? hit.snippet.trim() : "";
							return wrapSearchHit({
								title,
								url,
								snippet: snippet.length > 0 ? snippet : undefined,
								siteName: resolveSiteName(url),
								published: typeof hit.published_at === "string" ? hit.published_at : undefined,
							});
						})
						.filter((r): r is NonNullable<typeof r> => r !== null);
					return { provider: "aimlapi", results };
				},
			};
		},
	};
}

/* ─────────────────────────── fetch provider ─────────────────────────── */

function createAimlapiFetchProvider(fetchImpl?: typeof fetch): WebFetchProvider {
	return {
		id: "aimlapi",
		label: "AI/ML API",
		hint: "AI/ML API Toolbox page fetch: any URL as clean Markdown, with a browser when needed.",
		requiresCredential: true,
		envVars: AIMLAPI_ENV_VARS,
		signupUrl: "https://aimlapi.com/app/keys",
		docsUrl: "https://docs.aimlapi.com",
		placeholder: "your AI/ML API key",
		// After Firecrawl (10): an operator with a Firecrawl key keeps it.
		autoDetectOrder: 20,
		isConfigured(cfg, env) {
			return resolveAimlapiApiKey(cfg, env, "fetch") !== undefined;
		},
		createTool(ctx: WebProviderContext): WebProviderToolDefinition | null {
			const apiKey = resolveAimlapiApiKey(ctx.config, ctx.env, "fetch");
			if (!apiKey) return null;
			// The upstream fetcher gives up at 50 s on its own; leave headroom.
			const timeoutMs = Math.max((ctx.runtime?.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000) | 0, 60_000);
			return {
				description: "AI/ML API page fetch (Markdown extraction, renders JS when needed).",
				parameters: {
					type: "object",
					properties: {
						url: { type: "string" },
						extractMode: { type: "string", enum: ["markdown", "text"] },
						maxChars: { type: "integer" },
					},
					required: ["url"],
				},
				async execute(args, signal) {
					const url = String((args as { url?: unknown }).url ?? "").trim();
					if (!url) throw new Error("aimlapi: missing url");
					const output = await runAimlapiTool({
						tool: AIMLAPI_FETCH_TOOL,
						input: { url },
						apiKey,
						timeoutMs,
						signal,
						fetchImpl,
					});
					const markdown = typeof output.content === "string" ? output.content : "";
					return {
						provider: "aimlapi",
						url,
						finalUrl: typeof output.url === "string" ? output.url : url,
						status: 200,
						contentType: "text/markdown",
						title: typeof output.title === "string" && output.title ? output.title : undefined,
						text: markdown,
						rawLength: markdown.length,
						extractor: "aimlapi",
					};
				},
			};
		},
	};
}

export const aimlapiModule = defineModule({
	id: "aimlapi",
	register(b: BrigadeExtensionContext) {
		b.webFetch(createAimlapiFetchProvider());
		b.webSearch(createAimlapiSearchProvider());
	},
});

export {
	AIMLAPI_TOOLBOX_RUN_ENDPOINT,
	createAimlapiFetchProvider,
	createAimlapiSearchProvider,
	resolveAimlapiApiKey,
	runAimlapiTool,
};
