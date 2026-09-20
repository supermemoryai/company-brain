import { decryptToken } from "@/lib/crypto"
import { resolvedApprovalBlocks, updateSlackMessage } from "../slack/client"
import { getWorkspaceByTeamId } from "../slack/workspace"
import { brainAgent, type CompanyBrainAgent } from "./agent"
import {
	approvalIsExpired,
	loadApproval,
	markApprovalTerminal,
	type PendingApproval,
} from "./approval"
import { resolveApprovalIconUrl } from "./approval-icons"

export type ApprovalExpiryPayload = { approvalId: string; attempt?: number }

const RETRY_DELAY_SECONDS = 60
const MAX_ATTEMPTS = 3

export async function armApprovalExpiry(
	agent: CompanyBrainAgent,
	approval: Pick<PendingApproval, "approvalId" | "expiresAt">,
): Promise<void> {
	const delaySeconds = Math.max(
		1,
		Math.ceil((approval.expiresAt - Date.now()) / 1000),
	)
	await agent.schedule(delaySeconds, "runApprovalExpiry", {
		approvalId: approval.approvalId,
	})
}

// Collapse the still-live approval card once nobody decided in time.
export async function runApprovalExpiry(
	agent: CompanyBrainAgent,
	payload: ApprovalExpiryPayload,
): Promise<void> {
	const attempt = payload.attempt ?? 0
	const approval = loadApproval(agent, payload.approvalId)
	if (!approval) return
	if (approval.status === "pending") {
		if (!approvalIsExpired(approval)) {
			await armApprovalExpiry(agent, approval)
			return
		}
		markApprovalTerminal(agent, approval.approvalId, "expired")
	} else if (approval.status !== "expired" || attempt === 0) {
		// Retries may still collapse an expired card; anything else is decided.
		return
	}
	if (!approval.cardTs) return
	const env = brainAgent(agent).env
	const ws = await getWorkspaceByTeamId(env, approval.teamId)
	if (!ws || ws.orgId !== agent.name) return
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	const updated = await updateSlackMessage(
		botToken,
		approval.channel,
		approval.cardTs,
		"This approval expired after 15 minutes.",
		resolvedApprovalBlocks(
			{
				approvalId: approval.approvalId,
				summary: approval.summary,
				toolName: approval.toolName,
				slug: approval.slug,
				iconUrl: await resolveApprovalIconUrl({
					env,
					orgId: approval.orgId,
					actor: approval.state.actor,
					slug: approval.slug,
					toolName: approval.toolName,
				}),
				askerUser: approval.askerUser,
				expiresAt: approval.expiresAt,
			},
			"Expired",
		),
	)
	if (!updated && attempt + 1 < MAX_ATTEMPTS) {
		await agent.schedule(RETRY_DELAY_SECONDS, "runApprovalExpiry", {
			approvalId: approval.approvalId,
			attempt: attempt + 1,
		})
	}
}
