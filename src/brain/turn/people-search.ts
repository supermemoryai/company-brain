import type { SlackMember } from "../slack/client"

function normalizeSearchText(value: string): string {
	return value.normalize("NFKC").trim().toLowerCase()
}

function memberAliases(member: SlackMember): string[] {
	return [
		member.id,
		member.name,
		member.displayName,
		member.handle,
		member.handle ? `@${member.handle}` : undefined,
		member.email,
	]
		.filter((value): value is string => Boolean(value?.trim()))
		.map(normalizeSearchText)
}

function memberSearchScore(member: SlackMember, query: string): number {
	const normalized = normalizeSearchText(query)
	if (!normalized) return 1
	const aliases = memberAliases(member)
	if (aliases.includes(normalized)) return 100
	const terms = normalized.split(/\s+/).filter(Boolean)
	let score = 0
	for (const alias of aliases) {
		if (alias.includes(normalized)) score = Math.max(score, 50)
		const matchedTerms = terms.filter((term) => alias.includes(term)).length
		score = Math.max(score, matchedTerms * 5)
	}
	return score
}

export function searchDirectoryMembers(args: {
	directory: SlackMember[]
	query: string
	includeBots?: boolean
	limit?: number
}): SlackMember[] {
	const query = args.query.trim()
	if (!query) return []
	const limit = Math.min(Math.max(args.limit ?? 10, 1), 20)
	return args.directory
		.filter((member) => args.includeBots || !member.isBot)
		.map((member, index) => ({
			member,
			index,
			score: memberSearchScore(member, query),
		}))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, limit)
		.map((entry) => entry.member)
}
