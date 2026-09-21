import * as Effect from "effect/Effect"
import {
	DocumentUpsertError,
	InvalidDocumentParametersError,
	QuotaExceededError,
	SpaceCreationError,
} from "@/services/errors"
import { getContainerEntityContext } from "../../../memory/entity-context"
import { VectorDBService } from "../../services/vectordb"
import type { BatchItemResult } from "./helpers"

export type AddMemorySingleParams = {
	org: { id: string; name?: string; metadata?: unknown }
	userId?: string
	source?: string
	executionCtx?: ExecutionContext
	/** Replace the document at `customId` outright rather than merging into it. */
	isFullReplace?: boolean
	/** Keep brain tags already on the document instead of re-deriving them. */
	preserveBrainTags?: boolean
	/** "instant" asks supermemory to extract memories without waiting. */
	dreaming?: string | boolean
	requestParams: {
		content: string
		customId?: string
		containerTag?: string
		containerTags?: string[]
		metadata?: Record<string, string | number | boolean | string[] | null>
		taskType?: "memory" | "superrag"
	}
}

/** supermemory takes scalar metadata; arrays travel as comma-joined strings. */
function flattenMetadata(
	metadata: AddMemorySingleParams["requestParams"]["metadata"],
): Record<string, string | number | boolean> | undefined {
	if (!metadata) return undefined
	const flat: Record<string, string | number | boolean> = {}
	for (const [key, value] of Object.entries(metadata)) {
		if (value === null || value === undefined) continue
		flat[key] = Array.isArray(value) ? value.join(",") : value
	}
	return flat
}

/**
 * Write one document into supermemory. Extraction, chunking and embedding all
 * happen server-side, so this is a single API call wrapped as an Effect so the
 * original call sites and their error handling stay intact.
 */
export function addMemorySingle(
	params: AddMemorySingleParams,
): Effect.Effect<
	BatchItemResult,
	| InvalidDocumentParametersError
	| DocumentUpsertError
	// Raised by the hosted ingest path, never here; kept in the channel so
	// callers can keep handling them.
	| QuotaExceededError
	| SpaceCreationError,
	VectorDBService
> {
	return Effect.gen(function* () {
		const client = yield* VectorDBService
		const { requestParams } = params
		const containerTags =
			requestParams.containerTags ??
			(requestParams.containerTag ? [requestParams.containerTag] : undefined)

		if (!requestParams.content?.trim()) {
			return yield* Effect.fail(
				new InvalidDocumentParametersError({
					message: "content is empty",
				}),
			)
		}

		const entityContext = getContainerEntityContext(containerTags?.[0])

		return yield* Effect.tryPromise({
			try: async (): Promise<BatchItemResult> => {
				const result = await client.documents.add({
					content: requestParams.content,
					...(requestParams.customId
						? { customId: requestParams.customId }
						: {}),
					...(containerTags ? { containerTags } : {}),
					...(entityContext ? { entityContext } : {}),
					...(requestParams.taskType
						? { taskType: requestParams.taskType }
						: {}),
					...(flattenMetadata(requestParams.metadata)
						? { metadata: flattenMetadata(requestParams.metadata) }
						: {}),
				})
				return { id: result.id, status: result.status ?? "queued" }
			},
			catch: (error) =>
				new DocumentUpsertError({
					orgId: params.org.id,
					message: error instanceof Error ? error.message : String(error),
					cause: error,
				}),
		})
	})
}
