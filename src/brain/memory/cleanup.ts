import { captureException } from "@/lib/capture"
import { bulkDeleteDocumentsAndMemories } from "@/routes/memories/handlers"
import { getBrainDocumentByCustomId } from "../../memory/documents"

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
		const row = await getBrainDocumentByCustomId(env, customId)
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

/**
 * Drop a document the brain no longer wants remembered. supermemory cascades
 * the delete through the memories derived from it, so there is no orphan sweep
 * to run here.
 */
export async function deleteStaleBrainMemoryDocument({
	env,
	orgId,
	documentId,
}: {
	env: Env
	executionCtx?: ExecutionContext
	orgId: string
	documentId: string
}): Promise<void> {
	if (!documentId) return
	await bulkDeleteDocumentsAndMemories({ ids: [documentId], orgId, env })
}
