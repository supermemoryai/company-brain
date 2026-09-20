import { and, db, desc, eq, inArray, sql } from "@repo/db"
import { memoryEntry, space } from "@repo/db/schema/spaces"
import {
	BRAIN_TAG_LABELS_METADATA_KEY,
	BRAIN_TAGS_METADATA_KEY,
} from "@/lib/memory-entry-metadata"
import { SHARED_TEAM_BRAIN_CONTAINER_TAG } from "@/lib/spaces/provisioning"
import type { CompanyBrainAgent } from "../turn/agent"

export const MAX_BRAIN_TAGS_PER_MEMORY = 4
export const MAX_BRAIN_MEMORY_DOCS_PER_TURN = 3
export const MAX_BRAIN_OBSERVE_DOCS = 6
export const MAX_BRAIN_TAGS_IN_PROMPT = 80
export const SHARED_BRAIN_TAG_SCOPE = SHARED_TEAM_BRAIN_CONTAINER_TAG

// Reserved metadata keys the agent's memory tags live under. Namespaced (sm_)
// so they can't collide with user-supplied metadata. Must stay in sync with the
// GIN index in packages/db/schema/spaces.ts and its migration.
export { BRAIN_TAG_LABELS_METADATA_KEY, BRAIN_TAGS_METADATA_KEY }

export const NODE_PATH_DELIM = "/"

export const BRAIN_MEMORY_TAG_KINDS = [
	"person",
	"channel",
	"topic",
	"project",
	"customer",
	"team",
	"preference",
	"task",
	"other",
] as const

export type BrainMemoryTagKind = (typeof BRAIN_MEMORY_TAG_KINDS)[number]

export type BrainMemoryTag = {
	key: string
	label: string
	kind: BrainMemoryTagKind
	description?: string | null
}

const TAG_KEY_MAX = 128
const TAG_LABEL_MAX = 80
const TAG_DESCRIPTION_MAX = 180
const TAG_KINDS = new Set<BrainMemoryTagKind>(BRAIN_MEMORY_TAG_KINDS)

export function ensureBrainMemoryTagTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_memory_tag (
			container_tag TEXT NOT NULL,
			key TEXT NOT NULL,
			label TEXT NOT NULL,
			kind TEXT NOT NULL,
			description TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			last_used_at INTEGER NOT NULL,
			use_count INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (container_tag, key)
		)
	`
	const columns = agent.sql<{
		name: string
	}>`PRAGMA table_info(brain_memory_tag)`
	if (columns.some((column) => column.name === "container_tag")) return
	agent.sql`ALTER TABLE brain_memory_tag RENAME TO brain_memory_tag_legacy`
	agent.sql`
		CREATE TABLE brain_memory_tag (
			container_tag TEXT NOT NULL,
			key TEXT NOT NULL,
			label TEXT NOT NULL,
			kind TEXT NOT NULL,
			description TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			last_used_at INTEGER NOT NULL,
			use_count INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (container_tag, key)
		)
	`
	agent.sql`
		INSERT INTO brain_memory_tag (container_tag, key, label, kind, description, created_at, updated_at, last_used_at, use_count)
		SELECT ${SHARED_BRAIN_TAG_SCOPE}, key, label, kind, description, created_at, updated_at, last_used_at, use_count
		FROM brain_memory_tag_legacy
	`
	agent.sql`DROP TABLE brain_memory_tag_legacy`
}

export function normalizeBrainTagKey(key: string): string {
	return (
		key
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9/]+/g, "_")
			.replace(/_*\/_*/g, "/")
			.replace(/\/{2,}/g, "/")
			.replace(/^[/_]+|[/_]+$/g, "")
			.slice(0, TAG_KEY_MAX) || "other"
	)
}

export function nodePathSegments(path: string): string[] {
	return path.split(NODE_PATH_DELIM).filter(Boolean)
}

export function nodeLabel(path: string): string {
	const segs = nodePathSegments(path)
	return (segs[segs.length - 1] ?? path).replace(/_/g, " ")
}

function normalizeTagKind(kind: unknown): BrainMemoryTagKind {
	return typeof kind === "string" && TAG_KINDS.has(kind as BrainMemoryTagKind)
		? (kind as BrainMemoryTagKind)
		: "other"
}

export function normalizeBrainMemoryTags(
	tags: Array<Partial<BrainMemoryTag>> | undefined,
	options?: { allowedPersonSlackUserIds?: string[] },
): BrainMemoryTag[] {
	const seen = new Set<string>()
	const out: BrainMemoryTag[] = []
	// A supplied allowlist (even empty) means enforce; [] drops all person_* tags.
	// Only omitting the option entirely skips person-key validation.
	const enforcePersonKeys = options?.allowedPersonSlackUserIds !== undefined
	const allowedPersonKeys = new Set(
		options?.allowedPersonSlackUserIds
			?.filter((id) => id?.trim())
			.map(personBrainTagKey) ?? [],
	)
	for (const tag of tags ?? []) {
		const key = normalizeBrainTagKey(String(tag.key ?? tag.label ?? ""))
		if (!key || seen.has(key)) continue
		const isPersonKey = key.startsWith("person_")
		const isChannelKey = key.startsWith("channel_")
		if (enforcePersonKeys && isPersonKey && !allowedPersonKeys.has(key)) {
			continue
		}
		const kind = isPersonKey
			? "person"
			: isChannelKey
				? "channel"
				: normalizeTagKind(tag.kind)
		seen.add(key)
		const label = String(tag.label ?? key.replace(/_/g, " ")).trim()
		const description = tag.description?.trim()
		out.push({
			key,
			label: label.slice(0, TAG_LABEL_MAX) || key,
			kind,
			description: description
				? description.slice(0, TAG_DESCRIPTION_MAX)
				: null,
		})
		if (out.length >= MAX_BRAIN_TAGS_PER_MEMORY) break
	}
	return out
}

export function personBrainTagKey(slackUserId: string): string {
	return normalizeBrainTagKey(`person_${slackUserId}`)
}

// A channel's memory tag — id-scoped like person_, so a channel's disposition
// and recurring patterns are flagged and pre-injected the same way (ENG-1105).
export function channelBrainTagKey(channelId: string): string {
	return normalizeBrainTagKey(`channel_${channelId}`)
}

const KIND_PREFIXES = BRAIN_MEMORY_TAG_KINDS.map((kind) => `${kind}_`)

const GENERIC_TOKENS = new Set([
	"data",
	"team",
	"plan",
	"work",
	"scale",
	"scaling",
	"core",
	"main",
	"prod",
	"test",
	"infra",
	"api",
	"app",
	"user",
	"users",
	"stuff",
	"misc",
	"general",
	"update",
	"updates",
	"status",
	"issue",
	"issues",
	"note",
	"notes",
	"thing",
])

function tagCore(key: string): string {
	const k = normalizeBrainTagKey(key)
	for (const prefix of KIND_PREFIXES) {
		if (k.startsWith(prefix)) return k.slice(prefix.length)
	}
	return k
}

function coreTokens(core: string): string[] {
	return core.split("_").filter((t) => t.length >= 3)
}

function tokenAkin(a: string, b: string): boolean {
	if (a === b) return true
	const [short, long] = a.length <= b.length ? [a, b] : [b, a]
	return short.length >= 4 && long.startsWith(short)
}

function canonicalMatch(
	proposed: Partial<BrainMemoryTag>,
	existing: BrainMemoryTag[],
): BrainMemoryTag | null {
	const key = normalizeBrainTagKey(String(proposed.key ?? proposed.label ?? ""))
	if (!key) return null
	const core = tagCore(key)
	// Same-kind only: project_acme must not canonicalize onto customer_acme.
	for (const e of existing) {
		if (e.kind === proposed.kind && tagCore(e.key) === core) return e
	}
	if (key.startsWith("person_") || key.startsWith("channel_")) return null
	const tokens = coreTokens(core)
	for (const e of existing) {
		if (
			e.kind !== proposed.kind ||
			e.key.startsWith("person_") ||
			e.key.startsWith("channel_")
		)
			continue
		const eTokens = coreTokens(tagCore(e.key))
		if (
			tokens.some(
				(t) => !GENERIC_TOKENS.has(t) && eTokens.some((et) => tokenAkin(t, et)),
			)
		) {
			return e
		}
	}
	return null
}

export function canonicalizeProposedTags(
	existing: BrainMemoryTag[],
	proposed: Array<Partial<BrainMemoryTag>> | undefined,
): Array<Partial<BrainMemoryTag>> {
	if (!proposed?.length || !existing.length) return proposed ?? []
	return proposed.map((tag) => {
		const canon = canonicalMatch(tag, existing)
		return canon
			? {
					key: canon.key,
					label: canon.label,
					kind: canon.kind,
					description: tag.description ?? canon.description,
				}
			: tag
	})
}

export function registerBrainMemoryTags(
	agent: CompanyBrainAgent,
	containerTag: string,
	tags: BrainMemoryTag[],
): void {
	const scope = normalizeBrainTagScope(containerTag)
	if (!scope || !tags.length) return
	ensureBrainMemoryTagTable(agent)
	const now = Date.now()
	for (const tag of tags) {
		agent.sql`
			INSERT INTO brain_memory_tag (container_tag, key, label, kind, description, created_at, updated_at, last_used_at, use_count)
			VALUES (${scope}, ${tag.key}, ${tag.label}, ${tag.kind}, ${tag.description ?? null}, ${now}, ${now}, ${now}, 1)
			ON CONFLICT(container_tag, key) DO UPDATE SET
				label = excluded.label,
				kind = excluded.kind,
				description = COALESCE(excluded.description, brain_memory_tag.description),
				updated_at = excluded.updated_at,
				last_used_at = excluded.last_used_at,
				use_count = brain_memory_tag.use_count + 1
		`
	}
}

export function listBrainMemoryTags(
	agent: CompanyBrainAgent,
	params: {
		/** Full read set (shared + scope + any DM-accessible channels). */
		currentContainerTags?: string[] | null
		kinds?: BrainMemoryTagKind[]
		limit?: number
	} = {},
): BrainMemoryTag[] {
	const limit = params.limit ?? MAX_BRAIN_TAGS_IN_PROMPT
	const kinds = [...new Set(params.kinds ?? [])].filter((kind) =>
		TAG_KINDS.has(kind),
	)
	const scopes = [
		...new Set(
			[SHARED_BRAIN_TAG_SCOPE, ...(params.currentContainerTags ?? [])]
				.map((tag) => normalizeBrainTagScope(tag))
				.filter((tag): tag is string => Boolean(tag)),
		),
	]
	try {
		ensureBrainMemoryTagTable(agent)
		type TagRow = {
			key: string
			label: string
			kind: string
			description: string | null
			use_count: number
			updated_at: number
		}
		const queryRows = (
			containerTag: string,
			kind?: BrainMemoryTagKind,
		): TagRow[] =>
			kind
				? agent.sql<TagRow>`
						SELECT key, label, kind, description, use_count, updated_at
						FROM brain_memory_tag
						WHERE container_tag = ${containerTag} AND kind = ${kind}
						ORDER BY use_count DESC, updated_at DESC
						LIMIT ${limit}
					`
				: agent.sql<TagRow>`
						SELECT key, label, kind, description, use_count, updated_at
						FROM brain_memory_tag
						WHERE container_tag = ${containerTag}
						ORDER BY use_count DESC, updated_at DESC
						LIMIT ${limit}
					`
		const rows = scopes
			.flatMap((tag) =>
				kinds.length
					? kinds.flatMap((kind) => queryRows(tag, kind))
					: queryRows(tag),
			)
			.sort((a, b) => b.use_count - a.use_count || b.updated_at - a.updated_at)
		// Same tag key can live in multiple container scopes — keep the strongest.
		const seen = new Set<string>()
		const out: BrainMemoryTag[] = []
		for (const row of rows) {
			const key = normalizeBrainTagKey(row.key)
			if (seen.has(key)) continue
			seen.add(key)
			out.push({
				key,
				label: row.label,
				kind: normalizeTagKind(row.kind),
				description: row.description,
			})
			if (out.length >= limit) break
		}
		return out
	} catch (error) {
		console.warn("[brain-memory-tags] list failed", error)
		return []
	}
}

function normalizeBrainTagScope(containerTag: string | null): string | null {
	const trimmed = containerTag?.trim()
	return trimmed || null
}

const notForgotten = sql`(${memoryEntry.forgetAfter} IS NULL OR ${memoryEntry.forgetAfter} > now())`

export async function fetchTaggedBrainMemories(
	env: Env,
	params: {
		orgId: string
		containerTags: string[]
		tagKeys: string[]
		limit: number
	},
): Promise<string[]> {
	const keys = [
		...new Set(params.tagKeys.map(normalizeBrainTagKey).filter(Boolean)),
	]
	if (!keys.length) return []
	const containerTags = [...new Set(params.containerTags.filter(Boolean))]
	if (!containerTags.length) return []
	const rows = await db(env)
		.select({ memory: memoryEntry.memory })
		.from(memoryEntry)
		.innerJoin(space, eq(memoryEntry.spaceId, space.id))
		.where(
			and(
				eq(space.orgId, params.orgId),
				inArray(space.containerTag, containerTags),
				eq(memoryEntry.isLatest, true),
				eq(memoryEntry.isForgotten, false),
				notForgotten,
				sql`(COALESCE(${memoryEntry.metadata}::jsonb, '{}'::jsonb)->${sql.raw(`'${BRAIN_TAGS_METADATA_KEY}'`)}) ?| ARRAY[${sql.join(
					keys.map((key) => sql`${key}`),
					sql`, `,
				)}]::text[]`,
			),
		)
		.orderBy(desc(memoryEntry.updatedAt))
		.limit(params.limit)
	return rows
		.map((row) => row.memory?.trim())
		.filter((m): m is string => Boolean(m))
}

function queryTokens(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9]+/g)
			.filter((token) => token.length >= 3),
	)
}

export function relevantBrainTagKeys(params: {
	tags: BrainMemoryTag[]
	query?: string | null
	slackUserIds?: string[]
	limit?: number
}): string[] {
	const keys = new Set<string>()
	for (const id of params.slackUserIds ?? []) {
		if (id?.trim()) keys.add(personBrainTagKey(id))
	}
	const tokens = [...queryTokens(params.query ?? "")]
	for (const tag of params.tags) {
		if (keys.has(tag.key)) continue
		const haystack = [tag.key, tag.label, tag.description ?? ""]
			.join(" ")
			.toLowerCase()
		if (tokens.some((token) => haystack.includes(token))) keys.add(tag.key)
		if (keys.size >= (params.limit ?? 12)) break
	}
	return [...keys].slice(0, params.limit ?? 12)
}
