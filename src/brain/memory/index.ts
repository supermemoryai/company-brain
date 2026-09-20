import * as Effect from "effect/Effect"
import { makeAppLayer } from "@/config"
import { captureException } from "@/lib/capture"
import { addMemorySingle } from "@/routes/memories/handler-effect"
import type { BatchItemResult } from "@/routes/memories/helpers"
import type {
	DocumentUpsertError,
	InvalidDocumentParametersError,
	QuotaExceededError,
	SpaceCreationError,
} from "@/services/errors"
import type { SlackOrg } from "../slack/workspace"
import type { CompanyBrainAgent } from "../turn/agent"
import { deleteStaleBrainMemoryDocument } from "./cleanup"
import { maybeSplitNode } from "./split"
import {
	canonicalizeProposedTags,
	listBrainMemoryTags,
	registerBrainMemoryTags,
} from "./tags"
import {
	getBrainMemoryResetEpoch,
	isBrainMemoryResetEpochCurrent,
	pickNodePaths,
	upsertBrainMemoryNode,
} from "./tree"
import {
	buildSlackMemoryWriteRequest,
	type MemoryDocInput,
	type MemoryWriteback,
	memoryDocsFromWriteback,
	type SlackMemoryScope,
	slackMemoryContainerTag,
} from "./writeback"

export * from "./writeback"

type MemoryWriteOptions = {
	allowedPersonSlackUserIds?: string[]
	expectedResetEpoch?: number
}

function isSuccessfulMemoryWrite(result: BatchItemResult): boolean {
	return result.status === "queued" || result.status === "done"
}

function failedWriteResult(error: string): BatchItemResult {
	return { id: "", status: "error", error }
}

export async function writeMemory(
	env: Env,
	executionCtx: ExecutionContext | undefined,
	org: SlackOrg,
	userId: string,
	doc: MemoryDocInput,
	scope?: SlackMemoryScope,
	agent?: CompanyBrainAgent,
	options?: MemoryWriteOptions,
): Promise<{ written: boolean }> {
	const resetEpoch = agent
		? (options?.expectedResetEpoch ?? getBrainMemoryResetEpoch(agent))
		: undefined
	if (
		agent &&
		resetEpoch !== undefined &&
		!isBrainMemoryResetEpochCurrent(agent, resetEpoch)
	) {
		return { written: false }
	}
	let effectiveDoc = doc
	if (agent) {
		const containerTag = slackMemoryContainerTag(scope)
		const existing = containerTag
			? listBrainMemoryTags(agent, { currentContainerTags: [containerTag] })
			: []
		if (existing.length) {
			effectiveDoc = {
				...doc,
				tags: canonicalizeProposedTags(existing, doc.tags),
			}
		}
	}

	const request = buildSlackMemoryWriteRequest(
		effectiveDoc,
		scope,
		new Date(),
		{
			...options,
			expectedResetEpoch: resetEpoch,
		},
	)
	if (!request) return { written: false }
	if (agent && !request.tags.length) {
		console.warn(
			`[slack] memory write skipped: no valid tags after normalization title="${doc.title}"`,
		)
		captureException(new Error("Memory write blocked: no valid tags"), {
			tags: { component: "slack-memory" },
			extra: {
				title: doc.title,
				containerTag: request.containerTag,
				scope: scope?.kind,
			},
		})
		return { written: false }
	}

	const program = addMemorySingle({
		org: { id: org.id, name: org.name, metadata: org.metadata },
		userId,
		source: "company-brain",
		executionCtx,
		requestParams: {
			content: request.content,
			customId: request.customId,
			containerTag: request.containerTag,
			metadata: request.metadata,
		},
		dreaming: "instant",
		preserveBrainTags: true,
	})

	try {
		const result = await Effect.runPromise(
			program.pipe(
				Effect.provide(makeAppLayer({ executionCtx, env })),
				Effect.catchTags({
					QuotaExceededError: (e: QuotaExceededError) =>
						Effect.sync(() => {
							console.warn("[slack] memory write skipped (quota):", e._tag)
							return failedWriteResult(e._tag)
						}),
					InvalidDocumentParametersError: (e: InvalidDocumentParametersError) =>
						Effect.sync(() => {
							console.error("[slack] memory write invalid params:", e.message)
							return failedWriteResult(e.message)
						}),
					SpaceCreationError: (e: SpaceCreationError) =>
						Effect.sync(() => {
							captureException(e, { tags: { component: "slack-memory" } })
							return failedWriteResult(e.message)
						}),
					DocumentUpsertError: (e: DocumentUpsertError) =>
						Effect.sync(() => {
							captureException(e, { tags: { component: "slack-memory" } })
							return failedWriteResult(e.message)
						}),
				}),
			),
		)
		if (!isSuccessfulMemoryWrite(result)) return { written: false }
		if (agent) {
			if (
				resetEpoch === undefined ||
				!isBrainMemoryResetEpochCurrent(agent, resetEpoch)
			) {
				await deleteStaleBrainMemoryDocument({
					env,
					executionCtx,
					orgId: org.id,
					documentId: result.id,
				})
				return { written: false }
			}
			try {
				registerBrainMemoryTags(agent, request.containerTag, request.tags)
			} catch (error) {
				captureException(
					error instanceof Error ? error : new Error(String(error)),
					{ tags: { component: "brain-memory-tags" } },
				)
			}
			for (const nodePath of pickNodePaths(request.tags)) {
				const mapped = upsertBrainMemoryNode(
					agent,
					{
						documentId: result.id,
						containerTag: request.containerTag,
						nodePath,
					},
					resetEpoch,
				)
				if (mapped) {
					agent.waitUntil(
						maybeSplitNode(
							env,
							org.id,
							agent,
							request.containerTag,
							nodePath,
							resetEpoch,
						),
					)
				}
			}
		}
		return { written: true }
	} catch (error) {
		captureException(
			error instanceof Error ? error : new Error(String(error)),
			{
				tags: { component: "slack-memory" },
			},
		)
		return { written: false }
	}
}

export async function writeMemories(
	env: Env,
	executionCtx: ExecutionContext | undefined,
	org: SlackOrg,
	userId: string,
	memory: MemoryWriteback,
	scope?: SlackMemoryScope,
	agent?: CompanyBrainAgent,
	options?: MemoryWriteOptions,
): Promise<{ written: number; total: number }> {
	const docs = memoryDocsFromWriteback(memory)
	let written = 0
	for (const doc of docs) {
		const result = await writeMemory(
			env,
			executionCtx,
			org,
			userId,
			doc,
			scope,
			agent,
			options,
		)
		if (result.written) written++
	}
	return { written, total: docs.length }
}
