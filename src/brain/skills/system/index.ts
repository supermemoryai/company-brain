import type { RuntimeSkill } from "../store"
import { SUPERMEMORY_DOCS_SKILL } from "./supermemory-docs"

export const SYSTEM_SKILLS: readonly RuntimeSkill[] = [SUPERMEMORY_DOCS_SKILL]

const SYSTEM_SKILL_IDS = new Set(SYSTEM_SKILLS.map((skill) => skill.id))

export function isSystemSkillId(id: string): boolean {
	return SYSTEM_SKILL_IDS.has(id)
}
