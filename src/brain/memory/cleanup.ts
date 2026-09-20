import { and, db, eq, inArray, notExists } from "@repo/db"
import { document } from "@repo/db/schema/content"
import { memoryDocumentSource, memoryEntry } from "@repo/db/schema/spaces"
import * as Effect from "effect/Effect"
import { makeAppLayer } from "@/config"
import { captureException } from "@/lib/capture"
import { bulkDeleteDocumentsAndMemories } from "@/routes/memories/handlers"
import { VectorDBService } from "@/services/vectordb"

// Exact customId only: brain topic tags fuzzy-canonicalize onto each other.
export async function deleteBrainDocumentByCustomId({
	env,
	orgId,
	customId,
}: {
	env: Env
	orgId: string
	customId: string
}): Promise<boolean> {
	try {
		const [row] = await db(env)
			.select({ id: document.id })
			.from(document)
			.where(and(eq(document.orgId, orgId), eq(document.customId, customId)))
			.limit(1)
		if (!row) return false
		await deleteStaleBrainMemoryDocument({ env, orgId, documentId: row.id })
		return true
	} catch (error) {
		captureException(
			error instanceof Error ? error : new Error(String(error)),
			{
				tags: { component: "brain-research-stale-cleanup" },
			},
		)
		return false
	}
}

export async function deleteStaleBrainMemoryDocument({
	env,
	executionCtx,
	orgId,
	documentId,
}: {
	env: Env
	executionCtx?: ExecutionContext
	orgId: string
	documentId: string
}): Promise<void> {
	if (!documentId) return

	let vectordb: VectorDBService | undefined
	try {
		vectordb = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* VectorDBService
			}).pipe(Effect.provide(makeAppLayer({ executionCtx, env, orgId }))),
		)
	} catch (error) {
		captureException(
			error instanceof Error ? error : new Error(String(error)),
			{ tags: { component: "brain-stale-memory-vector-cleanup" } },
		)
	}

	const result = await bulkDeleteDocumentsAndMemories({
		ids: [documentId],
		orgId,
		env,
		vectordb,
	})
	if (!("_cleanup" in result)) return
	const associatedMemoryIds = [
		...new Set(result._cleanup.associatedMemories.map((memory) => memory.id)),
	]
	if (!associatedMemoryIds.length) return

	await db(env)
		.delete(memoryEntry)
		.where(
			and(
				eq(memoryEntry.orgId, orgId),
				inArray(memoryEntry.id, associatedMemoryIds),
				notExists(
					db(env)
						.select({ id: memoryDocumentSource.memoryEntryId })
						.from(memoryDocumentSource)
						.where(eq(memoryDocumentSource.memoryEntryId, memoryEntry.id)),
				),
			),
		)
}
