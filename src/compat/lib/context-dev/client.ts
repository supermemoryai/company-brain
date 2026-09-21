import ContextDev from "context.dev"
import type {
	WebSearchParams,
	WebSearchResponse,
	WebWebScrapeMdResponse,
} from "context.dev/resources/web"
import * as Cause from "effect/Cause"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { pipe } from "effect/Function"
import * as Schedule from "effect/Schedule"

export type ContextSearchRequest = {
	query: string
	/** numResults can't go below 10, so fetch 10 and keep 5 — half the tokens, same credit. */
	numResults?: number
	freshness?: WebSearchParams["freshness"]
	/** Bounds the whole call; the client carries it, not the request body. */
	timeoutMS: number
}

export type ContextSearchResult = WebSearchResponse.Result

/** Warn once headroom drops below this share of the per-minute cap. */
const LOW_HEADROOM_RATIO = 0.2
/** context.dev Hobby: $15 per 10,000 credits. One search or one page scrape is 1 credit. */
export const USD_PER_CREDIT = 0.0015
const RETRY_AFTER_CAP = Duration.seconds(30)

const DEFAULT_USAGE_TAG = "api"

export function hasContextWeb(env: Env): boolean {
	return Boolean(env.CONTEXT_DEV_API_KEY)
}

type HttpError = { status?: number; headers?: Headers }

// Status, not instanceof — survives Effect's FiberFailure wrapper and duplicate SDK copies.
export function isRateLimited(error: unknown): boolean {
	return (error as HttpError | null)?.status === 429
}

function retryAfter(error: unknown): Duration.Duration {
	if (!isRateLimited(error)) return Duration.zero
	const seconds = Number((error as HttpError).headers?.get("retry-after"))
	return Number.isFinite(seconds) && seconds > 0
		? Duration.min(Duration.seconds(seconds), RETRY_AFTER_CAP)
		: Duration.zero
}

// Longer of our jittered backoff and the server's Retry-After, so a header-less 429 still waits.
// One retry only: Retry-After is already capped at 30s, so this bounds the whole call at ~31s.
const rateLimitSchedule = Schedule.delayedSchedule(
	Schedule.zipWith(
		Schedule.delays(
			Schedule.jittered(
				Schedule.intersect(
					Schedule.exponential("1 second", 2),
					Schedule.recurs(1),
				),
			),
		),
		Schedule.fromFunction(retryAfter),
		Duration.max,
	),
)

function client(env: Env, timeoutMS: number): ContextDev {
	return new ContextDev({
		apiKey: env.CONTEXT_DEV_API_KEY,
		timeout: timeoutMS,
		// maxRetries defaults to 2 AND retries timeouts, so our 15s bound would really be 45s.
		// 429s get their own Retry-After-aware schedule below instead.
		maxRetries: 0,
	})
}

// Log the per-minute budget so headroom is visible before a 429, not only after.
function logQuota(tag: string, tool: string, headers: Headers): void {
	const limit = Number(headers.get("x-ratelimit-limit"))
	const remaining = Number(headers.get("x-ratelimit-remaining"))
	if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return
	const line = `[company-brain]${tag} context_quota tool=${tool} remaining=${remaining}/${limit}`
	if (remaining <= limit * LOW_HEADROOM_RATIO) console.warn(`${line} LOW`)
	else console.log(line)
}

type Metered = { key_metadata?: { credits_consumed?: number } }

export function creditsUsd(result: Metered | undefined): number {
	return (result?.key_metadata?.credits_consumed ?? 0) * USD_PER_CREDIT
}

async function call<T>(
	tag: string,
	tool: string,
	run: () => Promise<{ data: T; response: Response }>,
): Promise<T> {
	const exit = await Effect.runPromiseExit(
		pipe(
			Effect.tryPromise({ try: run, catch: (error) => error }),
			Effect.tap(({ response }) =>
				Effect.sync(() => logQuota(tag, tool, response.headers)),
			),
			Effect.map(({ data }) => data),
			Effect.retry({ schedule: rateLimitSchedule, while: isRateLimited }),
			Effect.tapError((error) =>
				isRateLimited(error)
					? Effect.sync(() =>
							console.warn(
								`[company-brain]${tag} ${tool} still rate limited after retries`,
							),
						)
					: Effect.void,
			),
		),
	)
	if (Exit.isSuccess(exit)) return exit.value
	// Rethrow the provider's error, not Effect's FiberFailure wrapper.
	throw Cause.squash(exit.cause)
}

export function contextSearch(
	env: Env,
	req: ContextSearchRequest,
	tag = "",
	usageTag = DEFAULT_USAGE_TAG,
): Promise<WebSearchResponse> {
	return call(tag, "search_web", () =>
		client(env, req.timeoutMS)
			.web.search({
				query: req.query,
				numResults: req.numResults ?? 10,
				tags: [usageTag],
				...(req.freshness ? { freshness: req.freshness } : {}),
			})
			.withResponse(),
	)
}

export function contextScrapeMarkdown(
	env: Env,
	url: string,
	timeoutMS: number,
	tag = "",
	usageTag = DEFAULT_USAGE_TAG,
): Promise<WebWebScrapeMdResponse> {
	return call(tag, "web_extract", () =>
		client(env, timeoutMS)
			.web.webScrapeMd({
				url,
				useMainContentOnly: true,
				includeImages: false,
				tags: [usageTag],
			})
			.withResponse(),
	)
}
