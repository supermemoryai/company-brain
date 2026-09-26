import { tool } from "ai"
import { z } from "zod"
import {
	contextSearch,
	creditsUsd,
	hasContextWeb,
	isRateLimited,
} from "@/lib/context-dev"
import type { BrainCostLedger } from "../../billing/cost"
import { logPreview } from "../../observability/log-utils"
import { firecrawlSearch } from "./firecrawl"

const SEARCH_TIMEOUT_MS = 15_000
/** Measured: 5 results of title+url+description is ~330 tokens, vs ~1,070 for the old LLM summary. */
const KEEP_RESULTS = 5

const FRESHNESS = [
	"last_24_hours",
	"last_week",
	"last_month",
	"last_year",
] as const

export function createBrainWebSearchTool(
	env: Env,
	traceId?: string,
	costLedger?: BrainCostLedger,
) {
	// context.dev when its key is set; otherwise Firecrawl, which needs none.
	const useContext = hasContextWeb(env)

	return tool({
		description:
			'Search the public web for external companies, products, people, news, documentation, or market context. Use when the question is about the outside world, or when Company Brain and connected apps did not answer it. Supports search operators: site:, -site:, inurl:, intitle:, "quoted phrases", and OR. Returns ranked results with titles, URLs, and snippets — call web_extract when a snippet is not enough.',
		inputSchema: z.object({
			query: z
				.string()
				.min(1)
				.max(500)
				.describe(
					"Focused web search query, e.g. 'Razorpay payment company overview' or 'site:supermemory.ai/docs ingest API'.",
				),
			freshness: z
				.enum(FRESHNESS)
				.optional()
				.describe(
					"Restrict to recently published content. Prefer this over writing dates into the query.",
				),
		}),
		execute: async ({ query, freshness }) => {
			const t = Date.now()
			const tag = traceId ? `[${traceId}]` : ""
			console.log(
				`[company-brain]${tag} search_web start query="${logPreview(query)}"`,
			)
			try {
				// Retries and Retry-After backoff live in the context.dev client.
				const results = useContext
					? await contextSearch(
							env,
							{ query, freshness, timeoutMS: SEARCH_TIMEOUT_MS },
							tag,
						).then((response) => {
							costLedger?.recordVendorUsd("context.dev", creditsUsd(response))
							return response.results.map((r) => ({
								...r,
								label: `${r.title} (${r.relevance} relevance)`,
							}))
						})
					: (
							await firecrawlSearch(env, {
								query,
								freshness,
								limit: KEEP_RESULTS,
								timeoutMs: SEARCH_TIMEOUT_MS,
							})
						).map((r) => ({ ...r, label: r.title }))
				const kept = results.slice(0, KEEP_RESULTS)
				console.log(
					`[company-brain]${tag} search_web finish ms=${Date.now() - t} results=${results.length} kept=${kept.length}`,
				)
				if (!kept.length) {
					return `No web results for "${query}". Try different wording, or drop any site: filter.`
				}
				return kept
					.map((r) => `- ${r.label}\n  ${r.url}\n  ${r.description}`)
					.join("\n")
			} catch (err) {
				console.warn(`[company-brain]${tag} search_web error:`, err)
				// Rephrasing does nothing for a quota error, so say which it is.
				return isRateLimited(err)
					? "Web search is rate limited right now. Answer from what you already have, or ask the person to retry in a minute. Searching again will not help."
					: "Web search failed. Try rephrasing the query."
			}
		},
	})
}
