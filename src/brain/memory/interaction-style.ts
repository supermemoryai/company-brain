import { and, db, desc, eq, sql } from "@repo/db"
import { memoryEntry, space } from "@repo/db/schema/spaces"
import { AGENT_SELF_CONTAINER_TAG } from "@/lib/spaces/provisioning"
import { personBrainTagKey } from "./tags"

export type InteractionStyleProfile = {
	voice?: string[]
	social?: string[]
	culture?: string[]
	doNot?: string[]
	selfConcept?: string[]
	operating?: string[]
}

const BUCKET_TO_FACET: Record<string, keyof InteractionStyleProfile> = {
	voice: "voice",
	social: "social",
	culture: "culture",
	do_not: "doNot",
	self_concept: "selfConcept",
	operating: "operating",
}

export async function loadInteractionStyleProfile(
	env: Env,
	orgId: string,
	askerSlackUserId?: string | null,
): Promise<InteractionStyleProfile | null> {
	const rows = await db(env)
		.select({
			memory: memoryEntry.memory,
			buckets: memoryEntry.buckets,
			tags: sql<
				string[] | null
			>`(${memoryEntry.metadata}::jsonb -> 'sm_brain_tags')`,
		})
		.from(memoryEntry)
		.innerJoin(space, eq(memoryEntry.spaceId, space.id))
		.where(
			and(
				eq(space.orgId, orgId),
				eq(space.containerTag, AGENT_SELF_CONTAINER_TAG),
				eq(memoryEntry.isLatest, true),
				eq(memoryEntry.isForgotten, false),
				sql`(${memoryEntry.forgetAfter} IS NULL OR ${memoryEntry.forgetAfter} > now())`,
			),
		)
		.orderBy(desc(memoryEntry.updatedAt))
		.limit(80)

	const personKey = askerSlackUserId?.trim()
		? personBrainTagKey(askerSlackUserId)
		: null
	const isPersonScoped = (tags: string[] | null) =>
		(tags ?? []).some((t) => t.startsWith("person_"))
	const matchesAsker = (tags: string[] | null) =>
		personKey ? (tags ?? []).includes(personKey) : false
	const ordered = [
		...rows.filter((r) => matchesAsker(r.tags)),
		...rows.filter((r) => !isPersonScoped(r.tags)),
	]

	const profile: InteractionStyleProfile = {}
	for (const row of ordered) {
		const text = row.memory?.trim()
		if (!text) continue
		for (const bucket of row.buckets ?? []) {
			const facet = BUCKET_TO_FACET[bucket]
			if (!facet) continue
			const list = profile[facet] ?? []
			list.push(text)
			profile[facet] = list
		}
	}
	return Object.keys(profile).length ? profile : null
}

const SECTIONS: Array<[keyof InteractionStyleProfile, string]> = [
	["voice", "Voice"],
	["social", "Social (occasional — keep it sparing)"],
	["culture", "Team references"],
	["operating", "How this team works"],
	["doNot", "Avoid"],
	["selfConcept", "Self"],
]

export function renderInteractionStyle(
	profile: InteractionStyleProfile | null | undefined,
): string | null {
	if (!profile) return null
	const parts: string[] = []
	for (const [facet, title] of SECTIONS) {
		const items = (profile[facet] ?? []).flatMap((item) => {
			const text = item.trim()
			return text ? [text] : []
		})
		if (items.length) parts.push(`${title}:`, ...items.map((i) => `- ${i}`))
	}
	return parts.length ? parts.join("\n") : null
}
