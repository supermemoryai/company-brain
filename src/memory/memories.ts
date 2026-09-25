import { BRAIN_TAGS_METADATA_KEY } from "@/lib/memory-entry-metadata"
import { memoryClient } from "./client"

export type BrainMemory = {
	id: string
	memory: string
	metadata: Record<string, unknown> | null
	/** Canonical brain tags (person_/topic_/project_/…) carried in metadata. */
	tags: string[]
	/** Profile buckets supermemory classified this memory into. */
	buckets: string[]
	/** Documents this memory was derived from. */
	documentIds: string[]
	sourceCount: number
	updatedAt: string
}

/** A memory as it comes back attached to its source document. */
export type DerivedMemory = {
	id: string
	documentId: string
	containerTag: string | null
	memory: string
	metadata: Record<string, unknown> | null
	buckets: string[]
	updatedAt: Date
}

type ApiMemoryEntry = {
	id: string
	memory: string
	metadata?: unknown
	buckets?: string[] | null
	documentIds?: string[]
	sourceCount?: number
	spaceContainerTag?: string | null
	isLatest?: boolean
	isForgotten?: boolean
	forgetAfter?: string | null
	updatedAt: string
}

// memories/list pages top out well below what the brain reads at once.
const LIST_PAGE_SIZE = 100
const BY_IDS_CHUNK = 100

function readStringArray(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string")
	if (typeof value === "string" && value.trim()) return value.split(",").map((v) => v.trim())
	return []
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function isLive(entry: ApiMemoryEntry, now = Date.now()): boolean {
	if (entry.isLatest === false || entry.isForgotten) return false
	return !entry.forgetAfter || new Date(entry.forgetAfter).getTime() > now
}

/** Filter to memories carrying at least one of these brain tags. */
function brainTagFilter(tagKeys: string[] | undefined) {
	if (!tagKeys?.length) return undefined
	return {
		OR: tagKeys.map((value) => ({
			filterType: "array_contains" as const,
			key: BRAIN_TAGS_METADATA_KEY,
			value,
		})),
	}
}

async function listContainerMemories(
	env: Env,
	params: { containerTag: string; tagKeys?: string[]; limit: number },
): Promise<ApiMemoryEntry[]> {
	const client = memoryClient(env)
	const filters = brainTagFilter(params.tagKeys)
	const out: ApiMemoryEntry[] = []
	// Pages can overlap when memories update mid-read, so count unique ids.
	const seen = new Set<string>()
	for (let page = 1; out.length < params.limit; page++) {
		const response = await client.post<{
			memoryEntries: ApiMemoryEntry[]
			pagination: { totalPages: number }
		}>("/v4/memories/list", {
			body: {
				containerTags: [params.containerTag],
				...(filters ? { filters } : {}),
				sort: "updatedAt",
				order: "desc",
				page,
				limit: LIST_PAGE_SIZE,
			},
		})
		for (const entry of response.memoryEntries) {
			if (seen.has(entry.id) || !isLive(entry)) continue
			seen.add(entry.id)
			out.push(entry)
		}
		if (page >= response.pagination.totalPages) break
	}
	return out.slice(0, params.limit)
}

/**
 * Memories in one or more containers, newest first, optionally narrowed to the
 * ones carrying a brain tag. Buckets aren't part of the list response, so
 * `withBuckets` looks them up through the memories' source documents.
 */
export async function listBrainMemories(
	env: Env,
	params: {
		containerTags: string[]
		limit?: number
		/** Keep only memories carrying at least one of these brain tags. */
		tagKeys?: string[]
		withBuckets?: boolean
	},
): Promise<BrainMemory[]> {
	const limit = params.limit ?? 50
	const perContainer = await Promise.all(
		[...new Set(params.containerTags)].map((containerTag) =>
			listContainerMemories(env, {
				containerTag,
				tagKeys: params.tagKeys,
				limit,
			}),
		),
	)

	const byId = new Map<string, BrainMemory>()
	for (const entry of perContainer.flat()) {
		if (byId.has(entry.id) || !entry.memory?.trim()) continue
		const metadata = asRecord(entry.metadata)
		byId.set(entry.id, {
			id: entry.id,
			memory: entry.memory,
			metadata,
			tags: readStringArray(metadata?.[BRAIN_TAGS_METADATA_KEY]),
			buckets: [],
			documentIds: entry.documentIds ?? [],
			sourceCount: entry.sourceCount ?? 1,
			updatedAt: entry.updatedAt,
		})
	}
	const memories = [...byId.values()]
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
		.slice(0, limit)

	if (params.withBuckets && memories.length > 0) {
		const derived = await memoriesForDocuments(
			env,
			memories.flatMap((memory) => memory.documentIds),
		)
		const bucketsById = new Map(derived.map((m) => [m.id, m.buckets]))
		for (const memory of memories) {
			memory.buckets = bucketsById.get(memory.id) ?? []
		}
	}
	return memories
}

/**
 * The live memories supermemory derived from these documents, with their
 * buckets and the container each landed in.
 */
export async function memoriesForDocuments(
	env: Env,
	documentIds: string[],
): Promise<DerivedMemory[]> {
	const ids = [...new Set(documentIds.filter(Boolean))]
	const client = memoryClient(env)
	const chunks: string[][] = []
	for (let i = 0; i < ids.length; i += BY_IDS_CHUNK) {
		chunks.push(ids.slice(i, i + BY_IDS_CHUNK))
	}
	const pages = await Promise.all(
		chunks.map((chunk) =>
			client.post<{
				documents: Array<{ id: string; memoryEntries?: ApiMemoryEntry[] }>
			}>("/v3/documents/documents/by-ids", { body: { ids: chunk, by: "id" } }),
		),
	)
	const now = Date.now()
	const seen = new Set<string>()
	const out: DerivedMemory[] = []
	for (const document of pages.flatMap((page) => page.documents)) {
		for (const entry of document.memoryEntries ?? []) {
			if (seen.has(entry.id) || !isLive(entry, now) || !entry.memory?.trim()) {
				continue
			}
			seen.add(entry.id)
			out.push({
				id: entry.id,
				documentId: document.id,
				containerTag: entry.spaceContainerTag ?? null,
				memory: entry.memory,
				metadata: asRecord(entry.metadata),
				buckets: entry.buckets ?? [],
				updatedAt: new Date(entry.updatedAt),
			})
		}
	}
	return out
}

/**
 * Replace a memory's metadata. The API versions memories rather than editing
 * them in place, so this writes a new latest version with the same text.
 */
export async function updateMemoryMetadata(
	env: Env,
	params: {
		id: string
		containerTag: string
		memory: string
		metadata: Record<string, unknown>
	},
): Promise<void> {
	await memoryClient(env).patch("/v4/memories", {
		body: {
			id: params.id,
			containerTag: params.containerTag,
			newContent: params.memory,
			metadata: params.metadata,
		},
	})
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
