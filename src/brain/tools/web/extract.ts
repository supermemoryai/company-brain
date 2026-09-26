import { tool } from "ai"
import { z } from "zod"
import {
	contextScrapeMarkdown,
	creditsUsd,
	hasContextWeb,
	isRateLimited,
} from "@/lib/context-dev"
import type { BrainCostLedger } from "../../billing/cost"
import { logPreview } from "../../observability/log-utils"
import { firecrawlScrape } from "./firecrawl"

const SCRAPE_TIMEOUT_MS = 30_000
const MAX_URLS = 5
/** Measured on 8 real pages: median ~16.6k chars, so 25k returns 7 of 8 whole. */
const PAGE_BUDGET = 25_000
/** One call must not flood the turn: 5 pages at the page cap would be 125k chars. */
const CALL_BUDGET = 50_000
/** Docs and pricing pages bury the answer at the bottom, so keep both ends. */
const HEAD_SHARE = 0.6

type Page = { title: string; url: string; markdown: string }

/**
 * Fit pages into CALL_BUDGET by trimming only the largest ones, so a batch of
 * small pages stays whole instead of every page losing an equal slice.
 */
export function allocateBudgets(sizes: number[]): number[] {
	const capped = sizes.map((size) => Math.min(size, PAGE_BUDGET))
	let total = capped.reduce((sum, size) => sum + size, 0)
	if (total <= CALL_BUDGET) return capped
	// Lower the ceiling until everything under it fits; pages below stay untouched.
	let ceiling = Math.max(...capped)
	while (total > CALL_BUDGET && ceiling > 1_000) {
		ceiling = Math.floor(ceiling * 0.9)
		total = capped.reduce((sum, size) => sum + Math.min(size, ceiling), 0)
	}
	return capped.map((size) => Math.min(size, ceiling))
}

function clip(markdown: string, budget: number): string {
	if (markdown.length <= budget) return markdown
	const head = Math.floor(budget * HEAD_SHARE)
	const tail = budget - head
	const dropped = markdown.length - budget
	return [
		markdown.slice(0, head),
		`\n\n[... ${dropped.toLocaleString()} characters omitted from the middle of this page. Ask a narrower question or use search to find the specific section ...]\n\n`,
		markdown.slice(-tail),
	].join("")
}

export function createBrainWebExtractTool(
	env: Env,
	traceId?: string,
	costLedger?: BrainCostLedger,
) {
	// context.dev when its key is set; otherwise Firecrawl, which needs none.
	const useContext = hasContextWeb(env)

	return tool({
		description: `Read the full text of public web pages you already have URLs for. Use this instead of search_web when someone shares a link, or when a search result's snippet is not enough. Handles PDFs and YouTube links (returns the transcript when captions exist). Up to ${MAX_URLS} URLs per call, read in parallel. Not for private or logged-in pages, and not for our own Slack, GitHub, Notion, or Linear — reach those through their connected app tools.`,
		inputSchema: z.object({
			urls: z
				.array(z.string().url())
				.min(1)
				.max(MAX_URLS)
				.describe(
					`Full public URLs to read, including https://. Pass every page you need in one call, up to ${MAX_URLS}.`,
				),
		}),
		execute: async ({ urls }) => {
			const t = Date.now()
			const tag = traceId ? `[${traceId}]` : ""
			console.log(
				`[company-brain]${tag} web_extract start count=${urls.length} urls="${logPreview(urls.join(" "))}"`,
			)
			let rateLimited = false
			const fetched = await Promise.all(
				urls.map(async (url): Promise<Page | string> => {
					try {
						const page = useContext
							? await contextScrapeMarkdown(
									env,
									url,
									SCRAPE_TIMEOUT_MS,
									tag,
								).then((scraped) => {
									costLedger?.recordVendorUsd(
										"context.dev",
										creditsUsd(scraped),
									)
									return {
										title: scraped.metadata?.title ?? url,
										url: scraped.url,
										markdown: scraped.markdown ?? "",
									}
								})
							: await firecrawlScrape(env, url, SCRAPE_TIMEOUT_MS)
						const markdown = page.markdown.trim()
						if (!markdown) return `## ${url}\n\nThe page returned no text.`
						return { title: page.title, url: page.url, markdown }
					} catch (err) {
						console.warn(
							`[company-brain]${tag} web_extract failed url=${url}:`,
							err,
						)
						if (isRateLimited(err)) {
							rateLimited = true
							return `## ${url}\n\nRate limited, not read. Retrying now will not help.`
						}
						return `## ${url}\n\nCouldn't read this page. It may be private, blocked, or unreachable.`
					}
				}),
			)
			const pages = fetched.filter((p): p is Page => typeof p !== "string")
			const budgets = allocateBudgets(pages.map((p) => p.markdown.length))
			let next = 0
			const sections = fetched.map((entry) =>
				typeof entry === "string"
					? entry
					: `## ${entry.title}\n${entry.url}\n\n${clip(entry.markdown, budgets[next++] ?? PAGE_BUDGET)}`,
			)
			const output = sections.join("\n\n---\n\n")
			console.log(
				`[company-brain]${tag} web_extract finish ms=${Date.now() - t} pages=${pages.length}/${urls.length} chars=${output.length}${rateLimited ? " rateLimited=yes" : ""}`,
			)
			return output
		},
	})
}
