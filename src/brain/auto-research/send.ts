import { decryptToken } from "@/lib/crypto"
import { getCompanyBrainEntitlement } from "@/lib/payments/company-brain-entitlement"
import {
	openSlackConversation,
	postSlackMessageIdempotent,
} from "../slack/client"
import { getWorkspaceByTeamId } from "../slack/workspace"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { getHomeChannel } from "../turn/home-channel"
import {
	type AutoResearchDraft,
	claimAutoResearchDraftForSend,
	finalizeAutoResearchDraft,
	getAutoResearchDraft,
	releaseAutoResearchDraft,
} from "./store"
import {
	pruneWatchTargets,
	upsertWatchTarget,
	type WatchTargetKind,
} from "./watchlist"

// Delivery is a separate, explicit act: a reviewer picks one draft and sends it.

export type SendDraftResult =
	| { ok: true; slackTs: string; channelId: string }
	| { ok: false; error: string }

function isPersistableKind(kind: string | null): kind is WatchTargetKind {
	return (
		kind === "competitor" ||
		kind === "person" ||
		kind === "product" ||
		kind === "topic" ||
		kind === "term"
	)
}

// The channel a draft goes to. DM channels are reopened rather than trusted from
// the draft row, and channel drafts follow the home channel as it is now.
async function resolveTarget(
	agent: CompanyBrainAgent,
	draft: AutoResearchDraft,
	botToken: string,
): Promise<string | undefined> {
	if (draft.kind === "dm")
		return draft.recipientSlackUserId
			? await openSlackConversation(botToken, draft.recipientSlackUserId)
			: undefined
	return getHomeChannel(agent)?.channelId ?? draft.channelId ?? undefined
}

export async function sendAutoResearchDraft(
	agent: CompanyBrainAgent,
	draftId: string,
): Promise<SendDraftResult> {
	const env = brainAgent(agent).env
	const existing = getAutoResearchDraft(agent, draftId)
	if (!existing) return { ok: false, error: "draft_not_found" }
	if (existing.status !== "draft")
		return { ok: false, error: `draft_already_${existing.status}` }

	// Drafting is internal work; delivery is the org receiving Company Brain, which
	// is what the entitlement gate governs everywhere else.
	const entitlement = await getCompanyBrainEntitlement(env, agent.name, (p) =>
		agent.waitUntil(p),
	)
	if (!entitlement.allowed) {
		console.log(
			`[company-brain] auto-research send blocked: entitlement org=${agent.name} reason=${entitlement.reason ?? "unknown"}`,
		)
		return {
			ok: false,
			error: `not_entitled_${entitlement.reason ?? "unknown"}`,
		}
	}

	const teamId = existing.teamId ?? getHomeChannel(agent)?.teamId
	if (!teamId) return { ok: false, error: "no_slack_workspace" }
	const ws = await getWorkspaceByTeamId(env, teamId)
	if (!ws) return { ok: false, error: "no_slack_workspace" }
	// Fail closed: a home-channel record can outlive or rebind a workspace, and we
	// must never deliver one org's research into another org's Slack.
	if (ws.orgId !== agent.name) {
		console.warn(
			`[company-brain] auto-research send blocked: workspace rebound team=${teamId} org=${agent.name} wsOrg=${ws.orgId}`,
		)
		return { ok: false, error: "workspace_org_mismatch" }
	}
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	const channelId = await resolveTarget(agent, existing, botToken)
	if (!channelId) return { ok: false, error: "no_delivery_target" }

	// Claim before the network call so a lost response can't double-post.
	const draft = claimAutoResearchDraftForSend(agent, draftId)
	if (!draft) return { ok: false, error: "draft_already_claimed" }

	// The draft id is a bare UUID, which is what client_msg_id requires.
	const res = await postSlackMessageIdempotent(
		botToken,
		channelId,
		draft.body,
		draft.id,
	)
	if (!res.ok) {
		releaseAutoResearchDraft(agent, draftId)
		console.warn(
			`[company-brain] auto-research send failed org=${agent.name} draft=${draftId}: ${res.error}`,
		)
		return { ok: false, error: res.error ?? "slack_post_failed" }
	}
	finalizeAutoResearchDraft(agent, draftId, res.ts, channelId)
	// Only targets we actually sent about earn a watchlist slot.
	if (isPersistableKind(draft.targetKind) && draft.targetLabel) {
		upsertWatchTarget(agent, {
			kind: draft.targetKind,
			label: draft.targetLabel,
		})
		pruneWatchTargets(agent)
	}
	console.log(
		`[company-brain] auto-research sent org=${agent.name} draft=${draftId} kind=${draft.kind} channel=${channelId} ts=${res.ts}`,
	)
	return { ok: true, slackTs: res.ts, channelId }
}
