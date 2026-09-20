import { createHash } from "node:crypto"
import { z } from "zod"
import {
	privateContainerTagFor,
	SHARED_TEAM_BRAIN_CONTAINER_TAG,
} from "@/lib/spaces/provisioning"
import {
	BRAIN_MEMORY_TAG_KINDS,
	BRAIN_TAG_LABELS_METADATA_KEY,
	BRAIN_TAGS_METADATA_KEY,
	type BrainMemoryTag,
	channelBrainTagKey,
	MAX_BRAIN_TAGS_PER_MEMORY,
	normalizeBrainMemoryTags,
} from "./tags"
export const BrainMemoryTagSchema = z.object({
	key: z
		.string()
		.describe(
			"Stable tag key that doubles as a topic-tree path: use '/' to nest from general to specific (e.g. supermemory/company_brain/memory), and '_' within a single segment. Use person_<slack_user_id> for teammates (flat, no '/'); use nested topic/project/customer/team paths for durable non-person subjects. If list_memory_tags/outline_memory_tree contains the concept, use its exact canonical key; create a new key only when no existing tag covers the subject.",
		),
	label: z.string().describe("Human-readable tag label."),
	kind: z.enum(BRAIN_MEMORY_TAG_KINDS).describe("Tag category."),
	description: z
		.string()
		.optional()
		.describe("Short boundary for when this tag should be reused."),
})

export const MemoryDocSchema = z.object({
	title: z.string().describe("A short title (a few words) for this memory."),
	content: z
		.string()
		.describe(
			"ONE detailed-but-compact, self-contained memory about one coherent durable subject. Keep related decisions, rationale, owners, and implications together. It must be useful if read alone, without sibling memories or thread context. Split only independently retrievable subjects, not supporting details or people within the same subject. Write people and things by their human-readable name; never put a raw Slack user id (e.g. U0AB123), an @-mention token, or a tag key into the memory text. Do not save volatile live-app results, bare entity/name/domain stubs, tag labels, or identifying details by themselves; fold supporting details into the substantive memory. A stable inference from live results is allowed only when it is likely to remain useful after the results change.",
		),
	sources: z
		.array(z.string())
		.describe("Authoritative source links gathered this turn (may be empty)."),
	eventDate: z
		.string()
		.optional()
		.describe(
			"If this memory is about a dated event, decision, deadline, incident, or status change, its date as YYYY-MM-DD. Omit for timeless facts. Powers recency/staleness.",
		),
	tags: z
		.array(BrainMemoryTagSchema)
		.min(1)
		.max(MAX_BRAIN_TAGS_PER_MEMORY)
		.describe(
			"The fewest stable tags that retrieve this memory well, usually one to three. Use exact existing keys from list_memory_tags/outline_memory_tree whenever they cover the concept; do not create synonyms, spelling variants, or redundant parent/child tags. Include person_<slack_user_id> only for a primary person and use a nested topic/project/customer/team path for the durable subject.",
		),
})

export type MemoryDoc = z.infer<typeof MemoryDocSchema>
export type MemoryDocInput = Omit<MemoryDoc, "tags"> & {
	tags?: Array<Partial<BrainMemoryTag>>
	internalCustomIdOverride?: string
}
export type MemoryWriteback = MemoryDocInput | MemoryDocInput[] | null

export function memoryDocsFromWriteback(
	memory: MemoryWriteback,
): MemoryDocInput[] {
	if (!memory) return []
	return (Array.isArray(memory) ? memory : [memory]).filter(
		(doc): doc is MemoryDocInput => Boolean(doc?.content?.trim()),
	)
}

export function utcDateString(date = new Date()): string {
	return date.toISOString().slice(0, 10)
}

export function normalizeMemoryKey(key: string): string {
	return key
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
}

export function slackMemoryCustomId(
	utcDate: string,
	memoryKey: string,
	rawKey: string,
): string {
	const hashKey =
		[memoryKey, rawKey.trim()].filter(Boolean).join(":") || "memory"
	const keyHash = createHash("sha256").update(hashKey).digest("hex")
	return `company-brain-slack:${utcDate}:${keyHash}`
}

export function privateSlackChannelContainerTag(channelId: string): string {
	return `slack_channel_${channelId}`
}

export type SlackMemoryScope =
	| { kind: "shared"; channelId?: string; channelType?: string }
	| {
			kind: "dm"
			channelId?: string
			channelType?: string
			/** Supermemory user id — used for the personal write tag. */
			userId?: string
			/** Slack user id — used to resolve the asker's private-channel read access. */
			slackUserId?: string
	  }
	| {
			kind: "private_channel"
			channelId: string
			channelType?: string
			userId?: string
	  }

export function slackMemoryContainerTag(
	scope?: SlackMemoryScope,
): string | undefined {
	if (scope?.kind === "dm") {
		return scope.userId ? privateContainerTagFor(scope.userId) : undefined
	}
	if (scope?.kind === "private_channel") {
		return privateSlackChannelContainerTag(scope.channelId)
	}
	return SHARED_TEAM_BRAIN_CONTAINER_TAG
}

export type SlackMemoryWriteRequest = {
	content: string
	customId: string
	containerTag: string
	metadata: Record<string, string | number | boolean | string[]>
	tags: BrainMemoryTag[]
}

export function buildSlackMemoryWriteRequest(
	doc: MemoryDocInput,
	scope?: SlackMemoryScope,
	now = new Date(),
	options?: {
		allowedPersonSlackUserIds?: string[]
		expectedResetEpoch?: number
	},
): SlackMemoryWriteRequest | null {
	const base = doc.content?.trim()
	if (!base) return null
	const eventDate = doc.eventDate?.trim()
	const withEvent =
		eventDate && !base.includes(eventDate)
			? `${base} (as of ${eventDate})`
			: base
	// Give the memory extractor a correct current-date anchor. The channel-observe
	// distiller already prefixes its own DOCUMENT_DATE (the message date), so only
	// stamp today when one isn't present — without it the extractor has no anchor
	// and defaults dates to a stale prior year.
	const content = withEvent.startsWith("DOCUMENT_DATE:")
		? withEvent
		: `DOCUMENT_DATE: ${utcDateString(now)}\n${withEvent}`

	let tags = normalizeBrainMemoryTags(doc.tags, options)
	if (scope?.channelId) {
		// Ambient recall filters on the exact channel_<channelId> key, but the model
		// can't format that id reliably. Rewrite any channel_* tag it emitted to the
		// canonical key (deduped) so channel-scoped recall matches what gets written. (#2673)
		const canonical = channelBrainTagKey(scope.channelId)
		const seen = new Set<string>()
		const rewritten: BrainMemoryTag[] = []
		for (const tag of tags) {
			const next =
				tag.key.startsWith("channel_") && tag.key !== canonical
					? { ...tag, key: canonical, kind: "channel" as const }
					: tag
			if (seen.has(next.key)) continue
			seen.add(next.key)
			rewritten.push(next)
		}
		tags = rewritten
	}
	const tagKeys = tags.map((tag) => tag.key)
	const key = doc.title || content.slice(0, 64)
	const memoryKey = normalizeMemoryKey(key)
	const ingestionDate = utcDateString(now)
	const internalCustomId = doc.internalCustomIdOverride?.trim()
	// Scope agent-backed ids to the reset generation so an old-generation write
	// can't dedupe onto (and then stale-delete) a post-reset document.
	const generation =
		options?.expectedResetEpoch === undefined
			? ""
			: `:epoch${options.expectedResetEpoch}`
	const customId =
		(internalCustomId?.startsWith("company-brain-channel-observe:") ||
		internalCustomId?.startsWith("company-brain-research:")
			? internalCustomId
			: undefined) ||
		slackMemoryCustomId(
			ingestionDate,
			memoryKey,
			`${key}:${tagKeys.join(",")}:${content}${generation}`,
		)
	const containerTag = slackMemoryContainerTag(scope)
	if (!containerTag) return null
	const metadata: Record<string, string | number | boolean | string[]> = {
		sm_source: "company-brain",
		source_type: "company-brain-slack",
		sm_internal_event_from: "slack",
		ingestion_date: ingestionDate,
		memory_scope: scope?.kind ?? "shared",
		memory_key: memoryKey,
		title: doc.title,
	}
	if (scope?.channelId) metadata.slack_channel_id = scope.channelId
	if (scope?.channelType) metadata.slack_channel_type = scope.channelType
	if (doc.sources?.length) metadata.sources = doc.sources
	if (tagKeys.length) {
		metadata[BRAIN_TAGS_METADATA_KEY] = tagKeys
		metadata[BRAIN_TAG_LABELS_METADATA_KEY] = tags.map((tag) => tag.label)
	}
	return { content, customId, containerTag, metadata, tags }
}
