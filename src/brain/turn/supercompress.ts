import type { ModelMessage } from "ai"
import {
	compactMessagesAtBoundary,
	largestBoundaryHeadTarget,
} from "./context"

/** Public compress API. The query is sent separately and is not compressed. */
export const SUPERCOMPRESS_URL = "https://api.supercompress.dev/v1/compress"

/** Matches the API's context limit. Larger dumps stay on the local prefix cut. */
const MAX_CONTEXT_CHARS = 120_000
const MAX_QUERY_CHARS = 4_000
const REQUEST_TIMEOUT_MS = 5_000

export type SupercompressOptions = {
	activeDiscoveryApps?: Iterable<string>
	preserveLoadedSkills?: boolean
	/** The current ask. Tool output is scored against this. */
	query?: string
	supercompressApiKey?: string
	fetchImpl?: typeof fetch
	signal?: AbortSignal
}

/**
 * Compact tool results the way Company Brain already does. When a key is set,
 * the single largest result that would have been prefix-cut is replaced with
 * query-kept text. One outbound call. Any failure keeps the prefix cut.
 */
export async function compactMessagesForModel(
	messages: ModelMessage[],
	options: SupercompressOptions = {},
): Promise<ModelMessage[]> {
	const headOverrides = await supercompressHeadOverrides(messages, options)
	return compactMessagesAtBoundary(messages, {
		activeDiscoveryApps: options.activeDiscoveryApps,
		preserveLoadedSkills: options.preserveLoadedSkills,
		headOverrides,
	})
}

async function supercompressHeadOverrides(
	messages: ModelMessage[],
	options: SupercompressOptions,
): Promise<Map<string, string> | undefined> {
	const apiKey = options.supercompressApiKey?.trim()
	const query = options.query?.trim()
	if (!apiKey || !query || options.signal?.aborted) return undefined
	const target = largestBoundaryHeadTarget(messages, options)
	if (!target || target.serialized.length > MAX_CONTEXT_CHARS) return undefined
	const compressed = await compressContext({
		apiKey,
		query,
		context: target.serialized,
		fetchImpl: options.fetchImpl,
		signal: options.signal,
	})
	if (!compressed) return undefined
	console.log(
		`[company-brain] supercompress tool=${target.toolName} chars ${target.serialized.length} -> ${compressed.length}`,
	)
	return new Map([[target.key, compressed]])
}

export async function compressContext(args: {
	apiKey: string
	query: string
	context: string
	fetchImpl?: typeof fetch
	signal?: AbortSignal
}): Promise<string | null> {
	const context = args.context.slice(0, MAX_CONTEXT_CHARS)
	const query = args.query.trim().slice(0, MAX_QUERY_CHARS)
	if (!context || !query) return null
	const fetchImpl = args.fetchImpl ?? fetch
	try {
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		const signal = args.signal
			? AbortSignal.any([args.signal, timeout])
			: timeout
		const response = await fetchImpl(SUPERCOMPRESS_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-API-Key": args.apiKey,
			},
			body: JSON.stringify({ context, query }),
			signal,
		})
		if (!response.ok) {
			console.warn(
				`[company-brain] supercompress skipped status=${response.status}`,
			)
			return null
		}
		const body = (await response.json()) as { compressed_text?: unknown }
		const text = body.compressed_text
		if (typeof text !== "string" || text.length === 0) return null
		if (text.length >= context.length) return null
		return text
	} catch (err) {
		const message = err instanceof Error ? err.message : "request failed"
		console.warn(`[company-brain] supercompress skipped: ${message}`)
		return null
	}
}
