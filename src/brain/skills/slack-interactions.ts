import { decryptToken } from "@/lib/crypto"
import {
	lookupSlackUserInfo,
	updateSlackInteractionResponse,
} from "../slack/client"
import {
	getOrgActorBySlackIdentity,
	getWorkspaceByTeamId,
	type SlackOrg,
} from "../slack/workspace"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { createSkillWithSideEffects } from "./operations"
import {
	cancelPendingSkillDraft,
	claimPendingSkillDraft,
	failClaimedSkillDraft,
	finishClaimedSkillDraft,
	getPendingSkillDraft,
	resolvedSkillDraftBlocks,
} from "./slack-drafts"
import { validateSkillInput } from "./validation"

export type SlackSkillDraftInteraction = {
	teamId: string
	slackUserId: string
	draftId: string
	action: "personal" | "org" | "approve" | "cancel"
	responseUrl?: string
}

type VerifiedSlackActor = {
	org: SlackOrg
	botToken: string
	actor: { userId: string; isAdmin: boolean }
}

type ConfiguredSkillWorkspace = Omit<VerifiedSlackActor, "actor">

async function respond(
	responseUrl: string | undefined,
	text: string,
	options?: { blocks?: unknown[]; replaceOriginal?: boolean },
): Promise<void> {
	if (!responseUrl) return
	await updateSlackInteractionResponse(responseUrl, {
		text,
		blocks: options?.blocks,
		replaceOriginal: options?.replaceOriginal,
		responseType: options?.replaceOriginal ? undefined : "ephemeral",
	})
}

async function configuredWorkspace(
	agent: CompanyBrainAgent,
	teamId: string,
): Promise<ConfiguredSkillWorkspace | null> {
	const env = brainAgent(agent).env
	const workspace = await getWorkspaceByTeamId(env, teamId)
	if (!workspace || workspace.orgId !== agent.name) {
		return null
	}
	const botToken = await decryptToken(
		workspace.botTokenEnc,
		env.ENCRYPTION_SECRET,
	)
	return {
		org: {
			id: workspace.orgId,
			name: workspace.orgName,
			slug: workspace.orgSlug,
			metadata: workspace.orgMetadata,
		},
		botToken,
	}
}

async function verifiedActor(
	agent: CompanyBrainAgent,
	teamId: string,
	slackUserId: string,
): Promise<VerifiedSlackActor | null> {
	const configured = await configuredWorkspace(agent, teamId)
	if (!configured) return null
	const profile = await lookupSlackUserInfo(configured.botToken, slackUserId)
	if (!profile.ok) return null
	const resolution = await getOrgActorBySlackIdentity(brainAgent(agent).env, {
		orgId: configured.org.id,
		teamId,
		slackUserId,
		email: profile.user.email,
	})
	if (!resolution.actor) return null
	return { ...configured, actor: resolution.actor }
}

export async function runSlackSkillDraftInteraction(
	agent: CompanyBrainAgent,
	interaction: SlackSkillDraftInteraction,
): Promise<void> {
	const draft = getPendingSkillDraft(agent, interaction.draftId)
	if (!draft || draft.teamId !== interaction.teamId) {
		await respond(interaction.responseUrl, "That skill draft is unavailable.")
		return
	}
	const verified = await verifiedActor(
		agent,
		interaction.teamId,
		interaction.slackUserId,
	)
	if (
		!verified ||
		draft.creatorSlackUserId !== interaction.slackUserId ||
		draft.creatorUserId !== verified.actor.userId
	) {
		await respond(
			interaction.responseUrl,
			"Only the person who created this draft can choose its scope, approve it, or deny it.",
		)
		return
	}
	if (draft.status !== "pending") {
		await respond(
			interaction.responseUrl,
			"That skill draft was already handled.",
		)
		return
	}
	if (draft.expiresAt <= Date.now()) {
		cancelPendingSkillDraft(agent, draft.id)
		await respond(interaction.responseUrl, "This skill draft expired.", {
			blocks: resolvedSkillDraftBlocks(draft, "expired"),
			replaceOriginal: true,
		})
		return
	}
	if (interaction.action === "cancel") {
		const cancelled = cancelPendingSkillDraft(agent, draft.id)
		const denied = Boolean(draft.requestedScope)
		await respond(
			interaction.responseUrl,
			cancelled
				? denied
					? "Skill approval denied."
					: "Skill draft cancelled."
				: "That draft was already handled.",
			cancelled
				? {
						blocks: resolvedSkillDraftBlocks(
							draft,
							"cancelled",
							denied ? "Skill approval denied." : undefined,
						),
						replaceOriginal: true,
					}
				: undefined,
		)
		return
	}

	const scope =
		interaction.action === "approve" ? draft.requestedScope : interaction.action
	if (!scope) {
		await respond(
			interaction.responseUrl,
			"Choose a scope for this skill before approving it.",
		)
		return
	}
	if (scope === "org" && !verified.actor.isAdmin) {
		await respond(
			interaction.responseUrl,
			"Only organization admins and owners can save whole-organization skills. You can still save this as Personal.",
		)
		return
	}
	const input = validateSkillInput({ ...draft.input, scope })
	const claimed = claimPendingSkillDraft(agent, draft.id)
	if (!claimed) {
		await respond(
			interaction.responseUrl,
			"That skill draft was already handled.",
		)
		return
	}

	try {
		const skill = createSkillWithSideEffects(
			agent,
			verified.org,
			{
				...input,
				origin: "slack",
				creatorSlackUserId: draft.creatorSlackUserId,
				sourceTeamId: draft.teamId,
				sourceThread: draft.sourceThread ?? null,
			},
			draft.creatorUserId,
			verified.actor.isAdmin,
		)
		claimed.createdSkillId = skill.id
		if (!finishClaimedSkillDraft(agent, claimed)) {
			console.warn(
				`[company-brain] skill draft completion claim lost org=${agent.name} draft=${draft.id} skill=${skill.id}`,
			)
		}
		const savedMessage =
			scope === "org"
				? "Saved as an organization-wide skill."
				: "Saved as a personal skill."
		await respond(interaction.responseUrl, savedMessage, {
			blocks: resolvedSkillDraftBlocks(draft, "created", undefined, scope),
			replaceOriginal: true,
		})
	} catch (error) {
		failClaimedSkillDraft(agent, claimed)
		const message =
			error instanceof Error ? error.message : "Couldn't save this skill."
		await respond(interaction.responseUrl, message, {
			blocks: resolvedSkillDraftBlocks(draft, "error", message),
			replaceOriginal: true,
		})
	}
}
