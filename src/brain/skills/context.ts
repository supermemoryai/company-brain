import type { CompanyBrainAgent } from "../turn/agent"
import { listVisibleRuntimeSkills, type RuntimeSkill } from "./store"
import { isSystemSkillId } from "./system"
import { SKILL_DESCRIPTION_MAX_CHARS } from "./validation"

/** Past this budget the least recently used skills keep their name and lose
 * their description. Names are capped before XML escaping, which can expand a
 * character fivefold, so dropping every description is not guaranteed to fit;
 * whatever still overflows is cut from the list and reported in the notice. */
export const SKILL_INDEX_MAX_CHARS = 16_000

/** Wrapper tags, the routing directive, and the truncation notice, which the
 * line budget below has to leave room for. */
const INDEX_OVERHEAD_CHARS = 600

const INDEX_DIRECTIVE =
	"Scan this list before answering. If a skill is even partially relevant to the task, load the closest one or two with load_skill and follow them; prefer loading over guessing. Names are exact."

export type AvailableSkillsContext = {
	text: string
	skillIds: string[]
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
}

/** One line per skill, so newlines in a stored description would forge entries. */
function indexDescription(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim()
	return normalized.length <= SKILL_DESCRIPTION_MAX_CHARS
		? normalized
		: `${normalized.slice(0, Math.max(0, SKILL_DESCRIPTION_MAX_CHARS - 1)).trimEnd()}…`
}

function fullLine(skill: RuntimeSkill): string {
	const description = indexDescription(skill.description)
	if (!description) return escapeXml(skill.name)
	return `${escapeXml(skill.name)} — ${escapeXml(description)}`
}

function recency(skill: RuntimeSkill): number {
	return skill.lastUsedAt ?? skill.updatedAt
}

function planIndexLines(skills: RuntimeSkill[]): {
	lines: string[]
	nameOnly: number
	dropped: number
} {
	const budget = SKILL_INDEX_MAX_CHARS - INDEX_OVERHEAD_CHARS
	const described = new Set(skills.map((skill) => skill.id))
	const dropped = new Set<string>()
	const systemChars = skills
		.filter((skill) => isSystemSkillId(skill.id))
		.reduce((sum, skill) => sum + fullLine(skill).length + 1, 0)
	if (systemChars > budget) {
		throw new Error("system skills exceed the available-skills index budget")
	}
	const byRecency = skills
		.filter((skill) => !isSystemSkillId(skill.id))
		.sort((a, b) => recency(a) - recency(b))
	let total = skills.reduce((sum, skill) => sum + fullLine(skill).length + 1, 0)
	for (const skill of byRecency) {
		if (total <= budget) break
		total -= fullLine(skill).length - escapeXml(skill.name).length
		described.delete(skill.id)
	}
	for (const skill of byRecency) {
		if (total <= budget) break
		total -= escapeXml(skill.name).length + 1
		dropped.add(skill.id)
	}
	return {
		lines: skills
			.filter((skill) => !dropped.has(skill.id))
			.map((skill) =>
				described.has(skill.id) ? fullLine(skill) : escapeXml(skill.name),
			),
		nameOnly: skills.length - described.size - dropped.size,
		dropped: dropped.size,
	}
}

export function renderAvailableSkills(skills: RuntimeSkill[]): string {
	if (!skills.length) return ""
	const { lines, nameOnly, dropped } = planIndexLines(skills)
	const notices: string[] = []
	if (nameOnly) {
		notices.push(
			`${nameOnly} of ${skills.length} skills show a name only; load one to read what it does`,
		)
	}
	if (dropped) {
		notices.push(`${dropped} could not be listed at all`)
	}
	return [
		"<available_skills>",
		INDEX_DIRECTIVE,
		...(notices.length ? [`(${notices.join("; ")})`] : []),
		...lines,
		"</available_skills>",
	].join("\n")
}

export function buildAvailableSkillsContext(args: {
	agent: CompanyBrainAgent
	userId?: string
}): AvailableSkillsContext | null {
	const visible = listVisibleRuntimeSkills(args.agent, {
		userId: args.userId,
	})
	if (!visible.length) return null
	const selected = [...visible].sort((a, b) => a.name.localeCompare(b.name))
	return {
		text: renderAvailableSkills(selected),
		skillIds: selected.map((skill) => skill.id),
	}
}
