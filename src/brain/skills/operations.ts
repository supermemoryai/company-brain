import { captureBrainSkillEvent } from "@/lib/posthog"
import type { SlackOrg } from "../slack/workspace"
import type { CompanyBrainAgent } from "../turn/agent"
import {
	type BrainSkill,
	createSkill,
	deleteSkill,
	type SkillCreateInput,
	type SkillEditableInput,
	updateSkill,
} from "./store"

export function createSkillWithSideEffects(
	agent: CompanyBrainAgent,
	org: SlackOrg,
	input: SkillCreateInput,
	creatorUserId: string,
	isAdmin: boolean,
): BrainSkill {
	const skill = createSkill(agent, input, creatorUserId, isAdmin)
	captureBrainSkillEvent({
		distinctId: creatorUserId,
		orgId: org.id,
		action: "created",
		skillId: skill.id,
		scope: skill.scope,
		origin: skill.origin,
	})
	return skill
}

export function updateSkillWithSideEffects(
	agent: CompanyBrainAgent,
	org: SlackOrg,
	id: string,
	input: SkillEditableInput,
	userId: string,
	isAdmin: boolean,
	expectedVersion: number,
): BrainSkill {
	const skill = updateSkill(agent, id, input, userId, isAdmin, expectedVersion)
	captureBrainSkillEvent({
		distinctId: userId,
		orgId: org.id,
		action: "edited",
		skillId: skill.id,
		scope: skill.scope,
		origin: skill.origin,
	})
	return skill
}

export function deleteSkillWithSideEffects(
	agent: CompanyBrainAgent,
	id: string,
	userId: string,
	isAdmin: boolean,
	expectedVersion: number,
): BrainSkill | null {
	return deleteSkill(agent, id, userId, isAdmin, expectedVersion)
}
