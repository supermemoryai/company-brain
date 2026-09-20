import type Supermemory from "supermemory"
import { memoryClient } from "../../../../memory/client"

export type SearchMemoryEntriesParams = {
	q: string
	limit?: number
	threshold?: number
	include?: {
		documents?: boolean
		summaries?: boolean
		relatedMemories?: boolean
		forgottenMemories?: boolean
		chunks?: boolean
	}
	rerank?: boolean
	aggregate?: boolean
	rewriteQuery?: boolean
	searchMode?: "memories" | "hybrid" | "documents"
	containerTag: string
	filters?: unknown
	org?: unknown
	env: Env
	c?: unknown
	vectordb?: Supermemory
}

export type SearchMemoryEntriesResult = {
	results: {
		id: string
		memory?: string
		similarity: number
		metadata: Record<string, unknown> | null
		updatedAt: string
		chunk?: string
		chunks?: { content: string; documentId: string; score: number }[]
	}[]
	total: number
	timing: number
}

/**
 * Semantic search over the org's memory. The hosted brain ran this in-process
 * against Turbopuffer; here it is one call to the supermemory search API, whose
 * request and response carry the same shape.
 */
export async function searchMemoryEntries(
	params: SearchMemoryEntriesParams,
): Promise<SearchMemoryEntriesResult> {
	const client = params.vectordb ?? memoryClient(params.env)
	const startedAt = Date.now()
	const response = await client.search.memories({
		q: params.q,
		containerTag: params.containerTag,
		limit: params.limit,
		threshold: params.threshold,
		rerank: params.rerank,
		rewriteQuery: params.rewriteQuery,
		searchMode: params.searchMode,
		...(params.include ? { include: params.include } : {}),
		...(params.filters
			? { filters: params.filters as Parameters<
					typeof client.search.memories
				>[0]["filters"] }
			: {}),
	})
	return {
		results: response.results as SearchMemoryEntriesResult["results"],
		total: response.total,
		timing: response.timing ?? Date.now() - startedAt,
	}
}
