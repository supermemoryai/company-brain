import { generateObject } from "ai"
import { z } from "zod"
import { fastModel } from "@/config"
import { captureException } from "@/lib/capture"
import type { CompanyBrainAgent } from "../turn/agent"
import {
	type BrainMemoryTag,
	nodeLabel,
	normalizeBrainTagKey,
	registerBrainMemoryTags,
} from "./tags"
import {
	hydrateLiveBrainNodeDocuments,
	isBrainMemoryResetEpochCurrent,
	listBrainMemoryNodeMappings,
	reconcileBrainMemoryNodeMappings,
	repointBrainMemoryMetadata,
	repointBrainMemoryNodes,
} from "./tree"

const SPLIT_THRESHOLD = 125
const SPLIT_SAMPLE_CAP = 160
// Serialize splits per node within this DO: bursty writes each fire a split
// check, and concurrent runs waste LLM calls and produce inconsistent children.
const splitInFlight = new Set<string>()

const PartitionSchema = z.object({
	children: z
		.array(
			z.object({
				segment: z
					.string()
					.describe("One snake_case path segment (no slashes)."),
				description: z.string().describe("One line: what belongs here."),
				memoryIndexes: z
					.array(z.number().int())
					.describe("Indexes (from the list) of memories in this child."),
			}),
		)
		.min(2)
		.max(4),
})

export async function maybeSplitNode(
	env: Env,
	orgId: string,
	agent: CompanyBrainAgent,
	containerTag: string,
	nodePath: string,
	expectedResetEpoch: number,
): Promise<void> {
	if (!isBrainMemoryResetEpochCurrent(agent, expectedResetEpoch)) return
	const lockKey = `${orgId}:${containerTag}:${normalizeBrainTagKey(nodePath)}`
	if (splitInFlight.has(lockKey)) return
	splitInFlight.add(lockKey)
	try {
		const mappings = await reconcileBrainMemoryNodeMappings(
			env,
			orgId,
			agent,
			listBrainMemoryNodeMappings(agent, {
				containerTags: [containerTag],
				nodePath,
				descendants: false,
			}),
		)
		if (mappings.length < SPLIT_THRESHOLD) return

		const liveMembers = await hydrateLiveBrainNodeDocuments(
			env,
			orgId,
			mappings,
		)
		if (liveMembers.length < SPLIT_THRESHOLD) return
		const members = liveMembers.slice(0, SPLIT_SAMPLE_CAP)

		const list = members
			.map((member, i) => `[${i}] ${member.memory.replace(/\s+/g, " ").trim()}`)
			.join("\n")
		const result = await generateObject({
			model: fastModel(),
			prompt: `The memory topic "${nodePath}" has grown too large to read at once. Split its memories into 2-4 coherent child subtopics. Give each child a short snake_case segment name (one path segment, no slashes), a one-line description, and the indexes of the memories that belong to it. Leave genuinely broad or parent-level memories unassigned (omit their index). Every child must be a real sub-theme, not a catch-all.\n\nMemories:\n${list}`,
			schema: PartitionSchema,
		})
		const { children } = result.object
		if (!isBrainMemoryResetEpochCurrent(agent, expectedResetEpoch)) return

		const childUpdates = children.flatMap((child) => {
			const seg = normalizeBrainTagKey(child.segment.replace(/\//g, "_"))
			if (seg === "other") return []
			const newPath = normalizeBrainTagKey(`${nodePath}/${seg}`)
			if (newPath === normalizeBrainTagKey(nodePath)) return []
			const documentIds = child.memoryIndexes.flatMap((i) => {
				const documentId = members[i]?.documentId
				return documentId ? [documentId] : []
			})
			if (!documentIds.length) return []
			return [
				{
					documentIds,
					newPath,
					tag: {
						key: newPath,
						label: nodeLabel(newPath),
						kind: "topic",
						description: child.description.slice(0, 180),
					} satisfies BrainMemoryTag,
				},
			]
		})
		// Preserve later-child-wins when indexes or source documents overlap.
		const winningUpdateByDocumentId = new Map<string, number>()
		childUpdates.forEach(({ documentIds }, updateIndex) => {
			for (const documentId of documentIds) {
				winningUpdateByDocumentId.set(documentId, updateIndex)
			}
		})
		const repoints = childUpdates.flatMap((update, updateIndex) => {
			const documentIds = Array.from(
				new Set(
					update.documentIds.filter(
						(documentId) =>
							winningUpdateByDocumentId.get(documentId) === updateIndex,
					),
				),
			)
			return documentIds.length ? [{ ...update, documentIds }] : []
		})
		// Postgres tag update FIRST, per child — it's the flaky (network) step. On
		// failure, skip the DO move for that child so the node stays at parent and
		// re-splits later; moving DO first would strand a permanent DO/PG desync.
		const successfulRepoints: typeof repoints = []
		for (const repoint of repoints) {
			try {
				await repointBrainMemoryMetadata(
					env,
					orgId,
					repoint.documentIds,
					nodePath,
					repoint.newPath,
					repoint.tag.label,
				)
			} catch (err) {
				captureException(err instanceof Error ? err : new Error(String(err)), {
					tags: { component: "brain-split-metadata" },
				})
				continue
			}
			const documentIds = repointBrainMemoryNodes(
				agent,
				containerTag,
				repoint.documentIds,
				nodePath,
				repoint.newPath,
				expectedResetEpoch,
			)
			if (documentIds.length) {
				successfulRepoints.push({ ...repoint, documentIds })
			}
		}
		if (!isBrainMemoryResetEpochCurrent(agent, expectedResetEpoch)) return
		const childTags = successfulRepoints.map(({ tag }) => tag)
		const moved = successfulRepoints.reduce(
			(sum, { documentIds }) => sum + documentIds.length,
			0,
		)
		if (childTags.length) {
			registerBrainMemoryTags(agent, containerTag, childTags)
		}
		console.log(
			`[company-brain] split node="${nodePath}" members=${members.length} children=${childTags.length} moved=${moved}`,
		)
	} catch (err) {
		captureException(err instanceof Error ? err : new Error(String(err)), {
			tags: { component: "brain-split" },
		})
	} finally {
		splitInFlight.delete(lockKey)
	}
}
