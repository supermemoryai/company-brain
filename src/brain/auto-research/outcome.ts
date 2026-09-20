import { decryptToken } from "@/lib/crypto"
import {
	getSlackMessageReactions,
	getSlackThreadHistory,
	type SlackMessageReaction,
} from "../slack/client"
import { getWorkspaceByTeamId } from "../slack/workspace"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { getHomeChannel } from "../turn/home-channel"
import { getAutoResearchDraft, listSentDraftsForScope } from "./store"

// What happened after we sent a post. Without this the loop has no idea whether
// anything it sent was any good, which is the only real signal on draft quality.

export type DraftOutcome = {
	draftId: string
	destination: string | null
	/** What the post was about, so engagement can be matched to the right one. */
	targetLabel: string | null
	opening: string
	sentAt: number | null
	reactions: SlackMessageReaction[]
	replies: Array<{ user: string | null; text: string }>
	/** False when Slack could not be read: absence of data is not absence of engagement. */
	engagementKnown: boolean
	/** True when the thread was longer than we fetched. */
	repliesTruncated: boolean
}

async function readOutcome(
	agent: CompanyBrainAgent,
	draft: NonNullable<ReturnType<typeof getAutoResearchDraft>>,
): Promise<DraftOutcome | null> {
	if (draft.status !== "sent" || !draft.slackTs) return null
	const env = brainAgent(agent).env
	const teamId = draft.teamId ?? getHomeChannel(agent)?.teamId
	if (!teamId) return null
	const ws = await getWorkspaceByTeamId(env, teamId)
	if (!ws || ws.orgId !== agent.name) return null
	const channelId = draft.channelId ?? getHomeChannel(agent)?.channelId
	if (!channelId) return null
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)

	const [reactions, thread] = await Promise.all([
		getSlackMessageReactions(botToken, channelId, draft.slackTs).catch(
			() => null,
		),
		getSlackThreadHistory(botToken, channelId, draft.slackTs, {
			maxMessages: 20,
		}).catch(() => null),
	])
	const replies = (thread?.messages ?? [])
		.filter((m) => m.ts !== draft.slackTs)
		.map((m) => ({
			user: m.user ?? null,
			text: (m.text ?? "").slice(0, 600),
		}))
		.filter((m) => m.text.trim().length > 0)
	return {
		draftId: draft.id,
		destination: draft.destination,
		targetLabel: draft.targetLabel ?? draft.recipientLabel,
		opening: draft.body.replace(/\s+/g, " ").slice(0, 120),
		sentAt: draft.decidedAt,
		reactions: reactions ?? [],
		replies,
		// reactions.get failing and conversations.replies returning ok:false both
		// mean unknown, which must not be reported as nothing.
		engagementKnown: reactions !== null && thread?.ok !== false,
		repliesTruncated: thread?.complete === false,
	}
}

export async function readDraftOutcome(
	agent: CompanyBrainAgent,
	draftId: string,
): Promise<DraftOutcome | null> {
	const draft = getAutoResearchDraft(agent, draftId)
	return draft ? readOutcome(agent, draft) : null
}

export type OutcomeScope = {
	/** Include channel sends. */
	channel: boolean
	/** Include DM sends to exactly these supermemory user ids. */
	recipientUserIds: string[]
}

// Recent sends and how they landed. A DM's replies are private context, so they
// only return when the operator selected that person's surface.
export async function recentDraftOutcomes(
	agent: CompanyBrainAgent,
	scope: OutcomeScope,
	limit = 5,
): Promise<DraftOutcome[]> {
	const sent = listSentDraftsForScope(agent, scope, limit)
	if (!sent.length) return []
	const outcomes = await Promise.all(sent.map((d) => readOutcome(agent, d)))
	return outcomes.filter((o): o is DraftOutcome => o !== null)
}
