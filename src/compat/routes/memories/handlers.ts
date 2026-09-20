import type Supermemory from "supermemory"
import { memoryClient } from "../../../memory/client"

/**
 * Delete documents (and the memories derived from them) by id. supermemory
 * cascades the deletion through chunks and vectors.
 */
export async function bulkDeleteDocumentsAndMemories({
	ids,
	env,
	vectordb,
}: {
	ids: string[]
	orgId?: string
	env: Env
	vectordb?: Supermemory
}): Promise<{ deleted: number; failed: number }> {
	const client = vectordb ?? memoryClient(env)
	const settled = await Promise.allSettled(
		ids.map((id) => client.documents.delete(id)),
	)
	const failed = settled.filter((r) => r.status === "rejected")
	for (const failure of failed) {
		console.error(`[memory] delete failed: ${String(failure.reason)}`)
	}
	return { deleted: settled.length - failed.length, failed: failed.length }
}
