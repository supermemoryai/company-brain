import { memoryClient } from "./client"

export type BrainDocument = {
	id: string
	customId: string | null
	content: string | null
	title: string | null
	metadata: Record<string, unknown> | null
	createdAt: string
}

type MetadataFilter = { key: string; value: string }

function toFilters(conditions: MetadataFilter[]) {
	if (conditions.length === 0) return undefined
	return {
		AND: conditions.map((condition) => ({
			key: condition.key,
			value: condition.value,
			filterType: "metadata" as const,
		})),
	}
}

function normalize(memory: {
	id: string
	customId: string | null
	content?: string
	title: string | null
	metadata: unknown
	createdAt: string
}): BrainDocument {
	return {
		id: memory.id,
		customId: memory.customId,
		content: memory.content ?? null,
		title: memory.title,
		metadata:
			memory.metadata && typeof memory.metadata === "object"
				? (memory.metadata as Record<string, unknown>)
				: null,
		createdAt: memory.createdAt,
	}
}

/**
 * Documents in one container, newest first. The hosted brain read these
 * straight out of Postgres; here the same shape comes from the documents API.
 */
export async function listBrainDocuments(
	env: Env,
	params: {
		containerTag: string
		metadata?: MetadataFilter[]
		limit?: number
		includeContent?: boolean
	},
): Promise<BrainDocument[]> {
	const filters = toFilters(params.metadata ?? [])
	const response = await memoryClient(env).documents.list({
		containerTags: [params.containerTag],
		...(filters ? { filters } : {}),
		includeContent: params.includeContent ?? true,
		limit: params.limit ?? 50,
		sort: "createdAt",
		order: "desc",
	})
	return response.memories.map(normalize)
}

/** The newest document in a container matching every metadata condition. */
export async function findBrainDocument(
	env: Env,
	params: { containerTag: string; metadata?: MetadataFilter[] },
): Promise<BrainDocument | null> {
	const [first] = await listBrainDocuments(env, { ...params, limit: 1 })
	return first ?? null
}

/** A document by the custom id the brain assigned it, or null if it is gone. */
export async function getBrainDocumentByCustomId(
	env: Env,
	customId: string,
): Promise<BrainDocument | null> {
	try {
		const document = await memoryClient(env).documents.get(customId)
		return normalize(document as Parameters<typeof normalize>[0])
	} catch {
		return null
	}
}

export async function deleteBrainDocument(
	env: Env,
	id: string,
): Promise<boolean> {
	try {
		await memoryClient(env).documents.delete(id)
		return true
	} catch (error) {
		console.error(`[memory] delete failed id=${id}: ${String(error)}`)
		return false
	}
}
