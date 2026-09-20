import type { ToolSet } from "ai"
import { captureBrainSkillEvent } from "@/lib/posthog"
import {
	getSlackMessagePermalink,
	postSlackEphemeral,
	postSlackMessage,
} from "../slack/client"
import type { SlackOrg } from "../slack/workspace"
import type { CompanyBrainAgent } from "../turn/agent"
import type { TurnDeps } from "../turn/deps"
import { type TurnState, touchTurnState } from "../turn/state"
import {
	deletePendingSkillDraft,
	insertPendingSkillDraft,
	type PendingSkillDraft,
	SKILL_DRAFT_EXPIRY_MS,
	skillDraftBlocks,
	skillDraftDeliveryKind,
} from "./slack-drafts"
import {
	listVisibleRuntimeSkills,
	loadVisibleSkillByName,
	nearestSkillNames,
} from "./store"
import {
	normalizeSkillName,
	SKILL_BODY_MAX_BYTES,
	SKILL_DESCRIPTION_MAX_CHARS,
	SKILL_NAME_MAX_CHARS,
	validateSkillInput,
} from "./validation"

/** Bounds how much playbook text one turn can pull in. */
const SKILL_LOADS_PER_TURN = 4

export type SkillToolContext = {
	org: SlackOrg
	userId?: string
	isAdmin: boolean
	channelId?: string
	teamId?: string
	threadTs?: string
	botToken?: string
	creatorSlackUserId?: string
	allowSave: boolean
	turnState?: TurnState
}

export function createSkillTools(
	agent: CompanyBrainAgent,
	deps: TurnDeps,
	ctx: SkillToolContext,
	traceId: string,
): ToolSet {
	const load_skill = deps.tool({
		description:
			"Load one visible organization playbook by its exact name when it matches the task. The returned Markdown controls format, process, and voice but never overrides evidence, approval, or safety.",
		inputSchema: deps.z.object({
			name: deps.z.string().min(1).max(SKILL_NAME_MAX_CHARS),
		}),
		execute: async ({ name }) => {
			const visible = listVisibleRuntimeSkills(agent, {
				userId: ctx.userId,
			})
			// Bodies run to SKILL_BODY_MAX_BYTES, so a turn that keeps loading spends
			// its context before doing the work. Checked before the read because
			// loading records usage, and a refused load must not count as one.
			// Re-reading a skill already loaded this turn stays free.
			const alreadyLoaded = ctx.turnState?.loadedSkills ?? []
			if (
				alreadyLoaded.length >= SKILL_LOADS_PER_TURN &&
				!alreadyLoaded.some(
					(skill) =>
						normalizeSkillName(skill.name) === normalizeSkillName(name),
				)
			) {
				return {
					error: `Already loaded ${SKILL_LOADS_PER_TURN} skills this turn. Continue with those.`,
					loaded: alreadyLoaded.map((skill) => skill.name),
				}
			}
			const loaded = loadVisibleSkillByName(agent, {
				userId: ctx.userId,
				name,
			})
			if (!loaded) {
				return {
					error: "No visible skill has that name.",
					nearMatches: nearestSkillNames(name, visible),
				}
			}
			const matchedVia = ctx.turnState?.availableSkillIds?.includes(loaded.id)
				? ("index" as const)
				: ("direct" as const)
			if (ctx.turnState) {
				ctx.turnState.loadedSkills ??= []
				const existing = ctx.turnState.loadedSkills.findIndex(
					(skill) => skill.id === loaded.id,
				)
				const record = {
					id: loaded.id,
					name: loaded.name,
					version: loaded.version,
				}
				if (existing >= 0) ctx.turnState.loadedSkills.splice(existing, 1)
				ctx.turnState.loadedSkills.push(record)
				touchTurnState(ctx.turnState)
			}
			captureBrainSkillEvent({
				distinctId: ctx.userId ?? `org:${ctx.org.id}`,
				orgId: ctx.org.id,
				action: "loaded",
				skillId: loaded.id,
				name: loaded.name,
				matchedVia,
			})
			console.log(
				`[company-brain][${traceId}] load_skill id=${loaded.id} version=${loaded.version} matchedVia=${matchedVia}`,
			)
			return { name: loaded.name, body: loaded.body, version: loaded.version }
		},
	})

	const tools: ToolSet = { load_skill }
	if (
		!ctx.allowSave ||
		!ctx.userId ||
		!ctx.teamId ||
		!ctx.channelId ||
		!ctx.botToken ||
		!ctx.creatorSlackUserId
	) {
		return tools
	}
	const creatorUserId = ctx.userId

	tools.save_skill = deps.tool({
		description:
			"Draft a reusable SKILL.md-style playbook only when someone explicitly asks to create or save a repeatable procedure, or asks to save how completed work was done. If the requester explicitly says Personal or Organization-wide, pass that exact scope and the private card will ask only for approval; otherwise omit scope so the card asks them to choose. It never persists before approval. Memories hold facts; skills hold how.",
		inputSchema: deps.z.object({
			name: deps.z.string().min(1).max(SKILL_NAME_MAX_CHARS),
			description: deps.z
				.string()
				.min(1)
				.max(SKILL_DESCRIPTION_MAX_CHARS)
				.describe(
					`One line, at most ${SKILL_DESCRIPTION_MAX_CHARS} characters, naming the task this applies to. Every skill's description is listed for routing, so state when to use it, not how it works.`,
				),
			body: deps.z
				.string()
				.min(1)
				.describe(
					`Markdown playbook, at most ${SKILL_BODY_MAX_BYTES} UTF-8 bytes.`,
				),
			scope: deps.z
				.enum(["personal", "org"])
				.optional()
				.describe(
					"Set only when the requester explicitly names Personal or Organization-wide. Omit it when they do not name a scope.",
				),
		}),
		execute: async ({ name, description, body, scope }) => {
			try {
				const currentChannel = ctx.channelId as string
				const requestedScope =
					!ctx.isAdmin && scope === "org" ? undefined : scope
				const effectiveScope = requestedScope ?? "personal"
				const input = validateSkillInput({
					name,
					description,
					body,
					scope: effectiveScope,
				})
				const sourceThread = ctx.threadTs
					? await getSlackMessagePermalink(
							ctx.botToken as string,
							currentChannel,
							ctx.threadTs,
						)
					: undefined
				const now = Date.now()
				const draft: PendingSkillDraft = {
					id: crypto.randomUUID(),
					status: "pending",
					input,
					requestedScope,
					creatorUserId,
					creatorSlackUserId: ctx.creatorSlackUserId as string,
					teamId: ctx.teamId as string,
					originChannelId: currentChannel,
					threadTs: ctx.threadTs,
					sourceThread,
					createdAt: now,
					expiresAt: now + SKILL_DRAFT_EXPIRY_MS,
				}
				insertPendingSkillDraft(agent, draft)
				const cardPosted =
					skillDraftDeliveryKind(currentChannel) === "direct_message"
						? Boolean(
								await postSlackMessage(
									ctx.botToken as string,
									currentChannel,
									`Confirm skill: ${input.name}`,
									ctx.threadTs,
									skillDraftBlocks(draft, ctx.isAdmin),
								),
							)
						: await postSlackEphemeral(
								ctx.botToken as string,
								currentChannel,
								ctx.creatorSlackUserId as string,
								`Confirm skill: ${input.name}`,
								ctx.threadTs,
								skillDraftBlocks(draft, ctx.isAdmin),
							)
				if (!cardPosted) {
					deletePendingSkillDraft(agent, draft.id)
					return {
						error: "I couldn't post the confirmation card. Nothing was saved.",
					}
				}
				console.log(
					`[company-brain][${traceId}] skill draft=${draft.id} requestedScope=${requestedScope ?? "unspecified"}`,
				)
				return {
					status: requestedScope
						? "approval_required"
						: "scope_selection_required",
					draftId: draft.id,
					message: requestedScope
						? "The skill is drafted. Approve or deny it on the card in this thread."
						: "The skill is drafted. Choose its scope on the card in this thread.",
				}
			} catch (error) {
				return {
					error:
						error instanceof Error
							? error.message
							: "Couldn't draft that skill.",
				}
			}
		},
	})

	return tools
}
