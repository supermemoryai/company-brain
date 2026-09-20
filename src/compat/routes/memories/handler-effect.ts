import * as Effect from "effect/Effect"
import { VectorDBService } from "../../services/vectordb"

export type AddMemorySingleParams = {
	org: { id: string; name?: string; metadata?: unknown }
	userId?: string
	source?: string
	executionCtx?: ExecutionContext
	/** Replace the document at `customId` outright rather than merging into it. */
	isFullReplace?: boolean
	/** Keep brain tags already on the document instead of re-deriving them. */
	preserveBrainTags?: boolean
	dreaming?: boolean
	requestParams: {
		content: string
		customId?: string
		containerTag?: string
		containerTags?: string[]
		metadata?: Record<string, string | number | boolean | null>
	}
}

/**
 * Write one document into supermemory. Extraction, chunking and embedding all
 * happen server-side, so this is a single API call wrapped as an Effect to keep
 * the original call sites intact.
 */
export function addMemorySingle(
	params: AddMemorySingleParams,
): Effect.Effect<{ id: string }, Error, VectorDBService> {
	return Effect.gen(function* () {
		const client = yield* VectorDBService
		const { requestParams } = params
		const containerTags =
			requestParams.containerTags ??
			(requestParams.containerTag ? [requestParams.containerTag] : undefined)
		return yield* Effect.tryPromise({
			try: async () => {
				const result = await client.documents.add({
					content: requestParams.content,
					...(requestParams.customId
						? { customId: requestParams.customId }
						: {}),
					...(containerTags ? { containerTags } : {}),
					...(requestParams.metadata
						? { metadata: requestParams.metadata }
						: {}),
				})
				return { id: result.id }
			},
			catch: (error) =>
				error instanceof Error ? error : new Error(String(error)),
		})
	})
}
