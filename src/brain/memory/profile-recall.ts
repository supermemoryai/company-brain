import { captureException } from "@/lib/capture"
import { listBrainMemories } from "../../memory/memories"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { resolveBrainReadContainerTags } from "./read-scope"
import {
	BRAIN_TAGS_METADATA_KEY,
	channelBrainTagKey,
	fetchTaggedBrainMemories,
	listBrainMemoryTags,
	personBrainTagKey,
	relevantBrainTagKeys,
} from "./tags"
import { outlineBrainTree, renderBrainTreeOutline } from "./tree"
import type { SlackMemoryScope } from "./writeback"

const FLOOR_TOKEN_BUDGET = 20_000
const FLOOR_TAG_KEYS = 10
const FLOOR_CANDIDATE_LIMIT = 500
const AMBIENT_STATIC_CANDIDATE_LIMIT = 500
// Asker (original poster) gets their full profile; mentioned people are secondary
// context, so a smaller most-recent slice (query orders updatedAt desc).
const AMBIENT_ASKER_CANDIDATE_LIMIT = 250
const AMBIENT_MENTIONED_CANDIDATE_LIMIT = 25
const AMBIENT_PERSON_COUNT = 8
// The current channel's disposition — only its BUCKETED channel_<id> memories, the
// same treatment as a person's profile. Unbucketed channel-tagged facts are not
// ambient-injected; they stay reachable through search/recall.
const AMBIENT_CHANNEL_CANDIDATE_LIMIT = 250

const estimateTokens = (s: string) => Math.ceil(s.length / 4)

export type BrainProfileRecallInput = {
	orgId: string
	query?: string | null
	/** Sender's Slack user id — for person tags. */
	senderSlackUserId?: string | null
	/** Other people relevant to the message, usually Slack @mentions. */
	mentionedSlackUserIds?: string[]
	/** Turn scope. DMs read shared + personal + every private channel the asker is in. */
	scope?: SlackMemoryScope
	/** Explicit read surface (admin console); replaces whatever scope would imply. */
	containerTags?: string[]
}

type AmbientBrainProfileInput = Omit<BrainProfileRecallInput, "query">

type AmbientPerson = {
	slackUserId: string
	role: "asker" | "mentioned person"
}

type AmbientProfileRow = {
	memory: string
	buckets: string[]
}

type AmbientPersonRows = AmbientPerson & { rows: AmbientProfileRow[] }

type AmbientBucketRow = AmbientProfileRow & { bucket: string }

export async function buildAmbientBrainProfileContext(
	agent: CompanyBrainAgent,
	input: AmbientBrainProfileInput,
): Promise<string | null> {
	const env = brainAgent(agent).env
	try {
		const containers = resolveBrainReadContainerTags(
			agent,
			input.scope,
			input.containerTags,
		)
		if (!containers.length) return null
		const people = dedupePeople(input).slice(0, AMBIENT_PERSON_COUNT)
		const channelTag = input.scope?.channelId
			? channelBrainTagKey(input.scope.channelId)
			: null
		const [taggedRows, channelRows, ...personRows] = await Promise.all([
			listBrainMemories(env, {
				containerTags: containers,
				query:
					"durable facts about this organization: its teams, projects, customers, products and how it works",
				limit: AMBIENT_STATIC_CANDIDATE_LIMIT,
			}),
			channelTag
				? listBrainMemories(env, {
						containerTags: containers,
						query: "what this channel is about and what happens in it",
						tagKeys: [channelTag],
						limit: AMBIENT_CHANNEL_CANDIDATE_LIMIT,
					})
				: Promise.resolve([] as AmbientProfileRow[]),
			...people.map((person) =>
				listBrainMemories(env, {
					containerTags: containers,
					query: "who this person is, what they work on and how they work",
					tagKeys: [personBrainTagKey(person.slackUserId)],
					limit:
						person.role === "asker"
							? AMBIENT_ASKER_CANDIDATE_LIMIT
							: AMBIENT_MENTIONED_CANDIDATE_LIMIT,
				}),
			),
		])

		// Shared knowledge is whatever carries a brain tag but isn't about one
		// person; a person's own memories arrive through their own read below.
		const staticRows = taggedRows.filter(
			(row) =>
				row.tags.length > 0 &&
				!row.tags.some((tag) => tag.startsWith("person_")),
		)

		// Signpost: a labels-only outline of durable shared knowledge, so the agent
		// always knows what subjects exist to pull in full — not just the asker's and
		// mentioned people's profiles.
		const outlineText = renderBrainTreeOutline(
			outlineBrainTree(agent, { currentContainerTags: containers }),
		)
		return renderAmbientProfile(
			staticRows,
			people.map((person, index) => ({
				...person,
				rows: personRows[index] ?? [],
			})),
			channelRows,
			outlineText,
		)
	} catch (err) {
		captureException(err instanceof Error ? err : new Error(String(err)), {
			tags: { component: "brain-ambient-profile" },
		})
		return null
	}
}

export async function buildBrainProfileContext(
	agent: CompanyBrainAgent,
	input: BrainProfileRecallInput,
): Promise<string | null> {
	const env = brainAgent(agent).env
	try {
		const containers = resolveBrainReadContainerTags(
			agent,
			input.scope,
			input.containerTags,
		)
		const tags = listBrainMemoryTags(agent, {
			currentContainerTags: containers,
		})
		const personIds = [
			input.senderSlackUserId,
			...(input.mentionedSlackUserIds ?? []),
		].filter((id): id is string => Boolean(id?.trim()))
		const tagKeys = relevantBrainTagKeys({
			tags,
			query: input.query,
			slackUserIds: personIds,
			limit: FLOOR_TAG_KEYS,
		})

		const fetched = await fetchTaggedBrainMemories(env, {
			orgId: input.orgId,
			containerTags: containers,
			tagKeys,
			limit: FLOOR_CANDIDATE_LIMIT,
		})
		const deduped = dedupeMemories(fetched)
		const memories = packToBudget(deduped, FLOOR_TOKEN_BUDGET)
		// Signal when this isn't the whole set so the agent can't claim completeness:
		// packed under the token budget, hit the raw fetch cap (measured pre-dedup, so
		// dedup can't mask it), or hit the tag-key cap (more relevant tags than fetched).
		const truncated =
			memories.length < deduped.length ||
			fetched.length >= FLOOR_CANDIDATE_LIMIT ||
			tagKeys.length >= FLOOR_TAG_KEYS

		const outlineText = renderBrainTreeOutline(
			outlineBrainTree(agent, { currentContainerTags: containers }),
		)
		// Keep going when truncated even with zero packed memories, so the capped
		// warning isn't lost (e.g. a single memory over the token budget packs to 0).
		if (!memories.length && !outlineText && !truncated) return null
		const parts = ["<brain_memory_context>"]
		if (outlineText) {
			parts.push(
				"Topic map (use outline_memory_tree / read_memory_node to go deeper):",
				outlineText,
				"",
			)
		}
		if (memories.length) {
			parts.push(
				["Relevant memories:", ...memories.map((m) => `- ${m}`)].join("\n"),
			)
		}
		if (truncated) {
			parts.push(
				memories.length
					? `(Showing ${memories.length} of ${deduped.length}+ matching memories — this is not the complete set; narrow the tag or use search_company_brain for the rest.)`
					: "(Hit the retrieval limit before any memories fit here — narrow the tag or use search_company_brain to find matches.)",
			)
		}
		parts.push("</brain_memory_context>")
		return parts.join("\n")
	} catch (err) {
		captureException(err instanceof Error ? err : new Error(String(err)), {
			tags: { component: "brain-profile-recall" },
		})
		return null
	}
}

function packToBudget(memories: string[], budget: number): string[] {
	const out: string[] = []
	let used = 0
	for (const m of memories) {
		const cost = estimateTokens(m) + 2 // "- " prefix + newline
		if (used + cost > budget) break
		out.push(m)
		used += cost
	}
	return out
}

// Dedupe by normalized content (trim + collapse whitespace + case), keeping the
// first-seen original text. Guards against the same fact arriving from multiple
// fetched sources/containers before injection.
function dedupeMemories(memories: string[]): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const m of memories) {
		const key = normalizeWhitespace(m).toLowerCase()
		if (!key || seen.has(key)) continue
		seen.add(key)
		out.push(m)
	}
	return out
}

function dedupePeople(input: AmbientBrainProfileInput): AmbientPerson[] {
	const people: AmbientPerson[] = []
	const seen = new Set<string>()
	const addPerson = (
		slackUserId: string | null | undefined,
		role: AmbientPerson["role"],
	): void => {
		const id = slackUserId?.trim()
		if (!id || seen.has(id)) return
		seen.add(id)
		people.push({ slackUserId: id, role })
	}
	addPerson(input.senderSlackUserId, "asker")
	for (const slackUserId of input.mentionedSlackUserIds ?? []) {
		addPerson(slackUserId, "mentioned person")
	}
	return people
}

function renderAmbientProfile(
	staticRows: AmbientProfileRow[],
	people: AmbientPersonRows[],
	channelRows: AmbientProfileRow[],
	outlineText: string | null,
): string | null {
	const seenElsewhere = new Set<string>()
	const renderedPeople: Array<AmbientPerson & { rows: AmbientBucketRow[] }> = []
	for (const person of people) {
		const rows = balanceAmbientBucketRows(person.rows)
		if (!rows.length) continue
		for (const row of rows) {
			seenElsewhere.add(normalizedMemoryKey(row.memory))
		}
		renderedPeople.push({ ...person, rows })
	}
	const renderedChannel = balanceAmbientBucketRows(channelRows)
	for (const row of renderedChannel) {
		seenElsewhere.add(normalizedMemoryKey(row.memory))
	}
	// Inject every static memory + every person/channel-bucket memory — no caps, so
	// the agent always sees the complete profile (all of someone's preferences, and
	// how the current channel wants it to show up).
	const selectedStatic = uniqueAmbientRows(
		staticRows.filter(
			(row) => !seenElsewhere.has(normalizedMemoryKey(row.memory)),
		),
		new Set<string>(),
	)
	return renderAmbientSections(
		selectedStatic,
		renderedPeople,
		renderedChannel,
		outlineText,
	)
}

function renderAmbientSections(
	staticRows: AmbientProfileRow[],
	people: Array<AmbientPerson & { rows: AmbientBucketRow[] }>,
	channelRows: AmbientBucketRow[],
	outlineText: string | null,
): string | null {
	const sections: string[] = []
	if (outlineText) {
		sections.push(
			[
				"Topic map of durable shared knowledge (use recall_tagged_memories, or outline_memory_tree then read_memory_node, to pull a whole subject):",
				outlineText,
			].join("\n"),
		)
	}
	if (staticRows.length) {
		sections.push(
			[
				"Static profile:",
				...staticRows.map((row) => `- ${compactMemory(row.memory)}`),
			].join("\n"),
		)
	}
	if (channelRows.length) {
		const byBucket = new Map<string, AmbientBucketRow[]>()
		for (const row of channelRows) {
			const bucketRows = byBucket.get(row.bucket)
			if (bucketRows) bucketRows.push(row)
			else byBucket.set(row.bucket, [row])
		}
		const lines = [
			"How this channel wants you to show up (disposition and recurring patterns for the current channel):",
		]
		for (const [bucket, bucketRows] of byBucket) {
			lines.push(`${bucket}:`)
			lines.push(...bucketRows.map((row) => `- ${compactMemory(row.memory)}`))
		}
		sections.push(lines.join("\n"))
	}
	for (const person of people) {
		const byBucket = new Map<string, AmbientBucketRow[]>()
		for (const row of person.rows) {
			const bucketRows = byBucket.get(row.bucket)
			if (bucketRows) bucketRows.push(row)
			else byBucket.set(row.bucket, [row])
		}
		const lines = [
			`Profile buckets for ${person.role} (Slack ${person.slackUserId}):`,
		]
		for (const [bucket, bucketRows] of byBucket) {
			lines.push(`${bucket}:`)
			lines.push(...bucketRows.map((row) => `- ${compactMemory(row.memory)}`))
		}
		sections.push(lines.join("\n"))
	}
	if (!sections.length) return null
	return [
		"<ambient_brain_profile>",
		...sections,
		"</ambient_brain_profile>",
	].join("\n")
}

function uniqueAmbientRows<T extends AmbientProfileRow>(
	rows: T[],
	seen: Set<string>,
): T[] {
	const out: T[] = []
	for (const row of rows) {
		const key = normalizedMemoryKey(row.memory)
		if (!key || seen.has(key)) continue
		seen.add(key)
		out.push(row)
	}
	return out
}

function balanceAmbientBucketRows(
	rows: AmbientProfileRow[],
): AmbientBucketRow[] {
	const selected: AmbientBucketRow[] = []
	const seen = new Set<string>()
	for (const row of rows) {
		const key = normalizedMemoryKey(row.memory)
		if (seen.has(key)) continue
		seen.add(key)
		const buckets = [
			...new Set(row.buckets.map((bucket) => bucket.trim()).filter(Boolean)),
		]
		for (const bucket of buckets.length ? buckets : ["other"]) {
			selected.push({ ...row, bucket })
		}
	}
	return selected
}

function normalizedMemoryKey(memory: string): string {
	return normalizeWhitespace(memory).toLowerCase()
}

function compactMemory(memory: string): string {
	const compact = normalizeWhitespace(memory)
	return compact.length > 300 ? `${compact.slice(0, 297)}...` : compact
}

function normalizeWhitespace(value: string): string {
	return value.trim().replace(/\s+/g, " ")
}
