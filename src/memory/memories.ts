import { BRAIN_TAGS_METADATA_KEY } from "@/lib/memory-entry-metadata"
import { memoryClient } from "./client"

export type BrainMemory = {
	id: string
	memory: string
	metadata: Record<string, unknown> | null
	/** Canonical brain tags (person_/topic_/project_/…) carried in metadata. */
	tags: string[]
	/** Profile buckets, when supermemory recorded them for this memory. */
	buckets: string[]
	updatedAt: string
	similarity: number
}

function readStringArray(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string")
	if (typeof value === "string" && value.trim()) return value.split(",").map((v) => v.trim())
	return []
}

/**
 * Memories in one or more containers.
 *
 * The hosted brain selected these rows out of Postgres and could order them by
 * recency. The public API exposes memories through search, so a `query` stands
 * in for "what is this read about" and results come back by relevance. Callers
 * pass the question they would have asked anyway.
 */
export async function listBrainMemories(
	env: Env,
	params: {
		containerTags: string[]
		query: string
		limit?: number
		/** Keep only memories carrying at least one of these brain tags. */
		tagKeys?: string[]
		threshold?: number
	},
): Promise<BrainMemory[]> {
	const client = memoryClient(env)
	const limit = params.limit ?? 50
	const perContainer = await Promise.all(
		params.containerTags.map(async (containerTag) => {
			const response = await client.search.memories({
				q: params.query,
				containerTag,
				limit,
				threshold: params.threshold ?? 0,
				searchMode: "memories",
				rerank: false,
				rewriteQuery: false,
			})
			return response.results
		}),
	)

	const wanted = new Set(params.tagKeys ?? [])
	const byId = new Map<string, BrainMemory>()
	for (const result of perContainer.flat()) {
		const metadata = (result.metadata ?? null) as Record<string, unknown> | null
		const tags = readStringArray(metadata?.[BRAIN_TAGS_METADATA_KEY])
		if (wanted.size > 0 && !tags.some((tag) => wanted.has(tag))) continue
		const memory = result.memory ?? result.chunk ?? ""
		if (!memory.trim()) continue
		const existing = byId.get(result.id)
		if (existing && existing.similarity >= result.similarity) continue
		byId.set(result.id, {
			id: result.id,
			memory,
			metadata,
			tags,
			buckets: readStringArray(metadata?.buckets),
			updatedAt: result.updatedAt,
			similarity: result.similarity,
		})
	}
	return [...byId.values()]
		.sort((a, b) => b.similarity - a.similarity)
		.slice(0, limit)
}

export type BrainDocumentStatus = {
	id: string
	status: string
	dreamingStatus: string | null
}

/** Processing status for documents the brain wrote, keyed by id. */
export async function documentStatuses(
	env: Env,
	ids: string[],
): Promise<Map<string, BrainDocumentStatus>> {
	const client = memoryClient(env)
	const settled = await Promise.allSettled(
		[...new Set(ids)].map((id) => client.documents.get(id)),
	)
	const statuses = new Map<string, BrainDocumentStatus>()
	for (const outcome of settled) {
		if (outcome.status !== "fulfilled") continue
		const document = outcome.value as {
			id: string
			status: string
			metadata?: unknown
		}
		const metadata = document.metadata as Record<string, unknown> | undefined
		statuses.set(document.id, {
			id: document.id,
			status: document.status,
			dreamingStatus:
				typeof metadata?.dreamingStatus === "string"
					? metadata.dreamingStatus
					: null,
		})
	}
	return statuses
}
