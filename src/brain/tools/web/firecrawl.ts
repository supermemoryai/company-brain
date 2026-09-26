/**
 * Firecrawl, the brain's web search and page reader when no context.dev key is
 * set. Its keyless tier needs no signup and gives 1,000 free credits a month,
 * rate limited per IP; FIRECRAWL_API_KEY lifts both.
 */
const FIRECRAWL_API = "https://api.firecrawl.dev/v2"

export type WebFreshness =
	| "last_24_hours"
	| "last_week"
	| "last_month"
	| "last_year"

// Firecrawl takes Google's time-range syntax for recency.
const FRESHNESS_TBS: Record<WebFreshness, string> = {
	last_24_hours: "qdr:d",
	last_week: "qdr:w",
	last_month: "qdr:m",
	last_year: "qdr:y",
}

export type FirecrawlHit = { title: string; url: string; description: string }
export type FirecrawlPage = { title: string; url: string; markdown: string }

/** Carries the HTTP status, which isRateLimited() reads to spot a 429. */
export class FirecrawlError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message)
		this.name = "FirecrawlError"
	}
}

async function post<T>(
	env: Env,
	path: string,
	body: Record<string, unknown>,
	timeoutMs: number,
): Promise<T> {
	const key = env.FIRECRAWL_API_KEY?.trim()
	const response = await fetch(`${FIRECRAWL_API}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(key ? { authorization: `Bearer ${key}` } : {}),
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	})
	if (!response.ok) {
		const detail = await response.text().catch(() => "")
		throw new FirecrawlError(
			`Firecrawl ${path} failed (${response.status}): ${detail.slice(0, 200)}`,
			response.status,
		)
	}
	return (await response.json()) as T
}

export async function firecrawlSearch(
	env: Env,
	params: {
		query: string
		freshness?: WebFreshness
		limit: number
		timeoutMs: number
	},
): Promise<FirecrawlHit[]> {
	const response = await post<{
		data?: { web?: Partial<FirecrawlHit>[] }
	}>(
		env,
		"/search",
		{
			query: params.query,
			limit: params.limit,
			...(params.freshness ? { tbs: FRESHNESS_TBS[params.freshness] } : {}),
		},
		params.timeoutMs,
	)
	return (response.data?.web ?? []).flatMap((hit) =>
		hit.url
			? [
					{
						title: hit.title?.trim() || hit.url,
						url: hit.url,
						description: hit.description?.trim() ?? "",
					},
				]
			: [],
	)
}

export async function firecrawlScrape(
	env: Env,
	url: string,
	timeoutMs: number,
): Promise<FirecrawlPage> {
	const response = await post<{
		data?: {
			markdown?: string
			metadata?: { title?: string; sourceURL?: string; url?: string }
		}
	}>(
		env,
		"/scrape",
		{ url, formats: ["markdown"], onlyMainContent: true, timeout: timeoutMs },
		// Firecrawl's own timeout covers the page; leave room for the response.
		timeoutMs + 5_000,
	)
	const metadata = response.data?.metadata
	return {
		title: metadata?.title?.trim() || url,
		url: metadata?.sourceURL ?? metadata?.url ?? url,
		markdown: response.data?.markdown ?? "",
	}
}
