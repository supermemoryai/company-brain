import type { SlackMember } from "../slack/client"
import { searchDirectoryMembers } from "../turn/people-search"

export type RelatedPersonInput = {
	name?: string
	slackUserId?: string
	role: "direct_target" | "primary_participant"
}

export type DeriveScheduleRelatedPeopleInput = {
	requestText?: string
	instruction: string
	creatorSlackUserId?: string
	directMentionSlackUserIds?: string[]
	directory?: SlackMember[]
	relatedSlackUserIds?: string[]
	relatedPeople?: RelatedPersonInput[]
	emptyRelatedInputIsExplicit?: boolean
}

const DIRECT_TARGET_VERBS = [
	"ping",
	"notify",
	"send",
	"give",
	"tell",
	"update",
	"follow up with",
	"check in with",
]
const PRIVATE_TERMS = [
	"performance review",
	"compensation",
	"salary",
	"hr",
	"feedback",
	"discipline",
	"confidential",
	"private",
	"pip",
]

function normalizeText(value: string | undefined): string {
	return (value ?? "").normalize("NFKC").toLowerCase()
}

function escapedPattern(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function hasExcludedSubjectPattern(text: string, target: string): boolean {
	const normalized = normalizeText(text)
	if (PRIVATE_TERMS.some((term) => normalized.includes(term))) return true
	const targetPattern = escapedPattern(target.toLowerCase())
	const maybeMentionTarget = `(?:<@)?${targetPattern}(?:>)?`
	return [
		`\\btalk\\s+to\\s+${maybeMentionTarget}\\s+about\\b`,
		`\\bremind\\s+me\\s+to\\s+(?:ask|follow\\s+up\\s+with|message|talk\\s+to|meet(?:ing)?)\\s+${maybeMentionTarget}\\b`,
		`\\bbefore\\s+(?:i\\s+)?meet(?:ing)?\\s+${maybeMentionTarget}`,
		`\\bprep\\s+before\\s+(?:i\\s+)?meet(?:ing)?\\s+${maybeMentionTarget}`,
	].some((pattern) => new RegExp(pattern, "i").test(normalized))
}

function hasTargetLanguage(text: string, target: string): boolean {
	const normalized = normalizeText(text)
	const targetPattern = escapedPattern(target.toLowerCase())
	const terminator = "(?=\\s|$|[.,!?])"
	if (
		new RegExp(
			`\\bremind\\s+(?:${targetPattern}|me\\s+and\\s+${targetPattern}|${targetPattern}\\s+and\\s+me)${terminator}`,
			"i",
		).test(normalized)
	) {
		return true
	}
	return DIRECT_TARGET_VERBS.some((verb) => {
		const verbPattern = escapedPattern(verb)
		return new RegExp(`\\b${verbPattern}\\b.{0,80}${targetPattern}`, "i").test(
			normalized,
		)
	})
}

function memberTargets(member: SlackMember): string[] {
	return [
		`<@${member.id}>`,
		member.id,
		member.name,
		member.displayName,
		member.handle,
		member.handle ? `@${member.handle}` : undefined,
	]
		.filter((value): value is string => Boolean(value?.trim()))
		.map((value) => value.trim())
}

function findMember(
	directory: SlackMember[],
	id: string,
): SlackMember | undefined {
	return directory.find((member) => member.id === id)
}

function resolveNamedMember(
	directory: SlackMember[],
	person: RelatedPersonInput,
): SlackMember | undefined {
	if (person.slackUserId) return findMember(directory, person.slackUserId)
	if (!person.name?.trim()) return undefined
	const matches = searchDirectoryMembers({
		directory,
		query: person.name,
		limit: 2,
	})
	return matches.length === 1 ? matches[0] : undefined
}

function isEligibleInText(text: string, targets: string[]): boolean {
	const normalized = normalizeText(text)
	if (/\bprep\s+before\s+(?:i\s+)?meet(?:ing)?\b/.test(normalized)) {
		return false
	}
	if (targets.some((target) => hasExcludedSubjectPattern(text, target))) {
		return false
	}
	return targets.some((target) => hasTargetLanguage(text, target))
}

export function deriveScheduleRelatedPeople(
	input: DeriveScheduleRelatedPeopleInput,
): string[] {
	const directory = input.directory ?? []
	const allowed = new Set<string>()
	const directMentions = new Set(input.directMentionSlackUserIds ?? [])
	const text = `${input.requestText ?? ""}\n${input.instruction}`

	for (const id of directMentions) {
		if (id === input.creatorSlackUserId) continue
		const member = findMember(directory, id)
		const targets = member ? memberTargets(member) : [`<@${id}>`, id]
		if (isEligibleInText(text, targets)) allowed.add(id)
	}

	const requested = new Set(input.relatedSlackUserIds ?? [])
	for (const person of input.relatedPeople ?? []) {
		const member = resolveNamedMember(directory, person)
		if (member) requested.add(member.id)
		if (!member || member.id === input.creatorSlackUserId) continue
		if (isEligibleInText(text, memberTargets(member))) allowed.add(member.id)
	}

	const hasExplicitRelatedInput =
		input.emptyRelatedInputIsExplicit === true
			? input.relatedSlackUserIds !== undefined ||
				input.relatedPeople !== undefined
			: Boolean(
					input.relatedSlackUserIds?.length || input.relatedPeople?.length,
				)
	return [...allowed].filter(
		(id) => !hasExplicitRelatedInput || requested.has(id),
	)
}
