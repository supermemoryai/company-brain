import { generateId } from "@repo/lib/generate-id"
import { decryptToken } from "@/lib/crypto"
import { captureLeaseRequest, type LeaseRequestOutcome } from "@/lib/posthog"
import {
	deleteSlackInteractionResponse,
	getSlackBotIdentity,
	getSlackThread,
	getSlackUserInfo,
	type LeaseCardStatus,
	postSlackApprovalCard,
	postSlackMessage,
	resolvedLeaseBlocks,
	type SlackLeaseCard,
	updateSlackInteractionResponse,
} from "../slack/client"
import { buildThreadContext } from "../slack/message-trace"
import { createSlackReplyReferenceResolver } from "../slack/references"
import { createSlackStreamSession } from "../slack/stream"
import {
	attachTurnCancelNotifier,
	fencedProgress,
	isThreadTurnCurrent,
	markThreadTurnCompleted,
	markThreadTurnWaitingForApproval,
	type RunningTurnControl,
	resumeThreadTurn,
	type TurnControlSnapshot,
} from "../slack/turn-control"
import { getWorkspaceByTeamId, type SlackOrg } from "../slack/workspace"
import { getConnectionById } from "../tools/mcp/store"
import { computeTurn } from "../turn"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import {
	APPROVAL_EXPIRY_MS,
	insertPendingApproval,
	markApprovalTerminal,
	type PendingApproval,
	setApprovalCardTs,
} from "../turn/approval"
import { armApprovalExpiry } from "../turn/approval-expiry"
import {
	raceWithAbortSignal,
	retainAbandoned,
	turnDeadlineSignal,
} from "../turn/util"
import { describeGrantedCapabilities, serverDisplayName } from "./capabilities"
import { isEligibleLeaseOwner, isOrgMember } from "./policy"
import {
	armLeaseRequestExpiry,
	deleteLeaseCards,
	leaseApprovedMessage,
	updateLeaseCardsStatus,
} from "./routing"
import {
	activateAccessLease,
	hasPendingLeaseRequestForTurn,
	leaseRequestIsExpired,
	loadAccessLease,
	loadLeaseRequest,
	markLeaseRequestTerminalIfPending,
	revokeAccessLease,
	updateLeaseOwnerDelivery,
} from "./store"
import {
	type AccessLease,
	LEASE_TTL_MS,
	type LeaseEscalationPayload,
	type LeaseMode,
	type LeaseRequest,
	type SlackLeaseDecision,
} from "./types"

function cardFromRequest(request: LeaseRequest): SlackLeaseCard {
	const ownerSlackUsers = [
		...new Set(
			request.cardDeliveries.flatMap((delivery) => {
				const slackUserId =
					request.candidateOwners[delivery.ownerIndex]?.slackUserId
				return slackUserId ? [slackUserId] : []
			}),
		),
	]
	return {
		requestId: request.requestId,
		serverSlug: request.serverSlug,
		serverName: serverDisplayName(request.serverSlug),
		askerUser: request.lesseeSlackUser,
		ownerSlackUsers,
		channel: request.channel,
		reason: request.reason,
		capabilities: request.capabilitySummary,
		expiresAt: request.expiresAt,
	}
}

function turnStillCurrent(
	agent: CompanyBrainAgent,
	control: TurnControlSnapshot | undefined,
): boolean {
	return !control || isThreadTurnCurrent(agent, control)
}

function turnWasInterrupted(
	agent: CompanyBrainAgent,
	control: RunningTurnControl | undefined,
): boolean {
	return Boolean(control?.signal.aborted || !turnStillCurrent(agent, control))
}

async function ephemeral(
	decision: SlackLeaseDecision,
	text: string,
): Promise<void> {
	if (!decision.responseUrl) return
	await updateSlackInteractionResponse(decision.responseUrl, {
		text,
		responseType: "ephemeral",
	})
}

async function resolveCard(
	decision: SlackLeaseDecision,
	request: LeaseRequest,
	status: LeaseCardStatus,
	text: string,
	leaseId?: string,
): Promise<void> {
	if (!decision.responseUrl) return
	await updateSlackInteractionResponse(decision.responseUrl, {
		text,
		replaceOriginal: true,
		blocks: resolvedLeaseBlocks(
			cardFromRequest(request),
			status,
			leaseId,
			text,
		),
	})
}

function ownerDeliveryForSlackUser(
	request: LeaseRequest,
	slackUserId: string,
): { ownerIndex: number; deliveryOrdinal: number } | undefined {
	for (
		let deliveryOrdinal = 0;
		deliveryOrdinal < request.cardDeliveries.length;
		deliveryOrdinal++
	) {
		const delivery = request.cardDeliveries[deliveryOrdinal]
		if (!delivery) continue
		const owner = request.candidateOwners[delivery.ownerIndex]
		if (owner?.slackUserId === slackUserId) {
			return { ownerIndex: delivery.ownerIndex, deliveryOrdinal }
		}
	}
}

async function captureLeaseOutcome(
	request: LeaseRequest,
	outcome: LeaseRequestOutcome,
	approverOrdinal?: number,
): Promise<void> {
	await captureLeaseRequest({
		distinctId: request.lesseeUserId,
		orgId: request.orgId,
		serverSlug: request.serverSlug,
		ownersFound: request.ownersFound,
		fanoutCount: request.cardDeliveries.length,
		capped: request.fanoutCapped,
		outcome,
		timeToDecisionMs: Math.max(0, Date.now() - request.createdAt),
		approverOrdinal,
	})
}

async function leaseWorkspace(
	agent: CompanyBrainAgent,
	request: LeaseRequest,
): Promise<Awaited<ReturnType<typeof getWorkspaceByTeamId>> | undefined> {
	if (request.orgId !== agent.name) {
		console.error(
			`[company-brain] lease delivery dropped: request belongs to another org request=${request.requestId} requestOrg=${request.orgId} agentOrg=${agent.name}`,
		)
		return undefined
	}
	const env = brainAgent(agent).env
	const workspace = await getWorkspaceByTeamId(env, request.teamId)
	if (!workspace) return undefined
	if (workspace.orgId !== agent.name) {
		console.error(
			`[company-brain] lease delivery dropped: workspace rebound request=${request.requestId} team=${request.teamId} requestOrg=${agent.name} currentOrg=${workspace.orgId}`,
		)
		return undefined
	}
	return workspace
}

async function leaseBotToken(
	agent: CompanyBrainAgent,
	request: LeaseRequest,
): Promise<string | undefined> {
	const workspace = await leaseWorkspace(agent, request)
	if (!workspace) return undefined
	return decryptToken(
		workspace.botTokenEnc,
		brainAgent(agent).env.ENCRYPTION_SECRET,
	)
}

async function removeLeaseRequestCards(
	agent: CompanyBrainAgent,
	decision: SlackLeaseDecision,
	request: LeaseRequest,
	onlyPending = false,
): Promise<string | undefined> {
	const botToken = await leaseBotToken(agent, request)
	const deleted = botToken
		? await deleteLeaseCards(botToken, request, onlyPending)
		: false
	if (!deleted && decision.responseUrl) {
		await deleteSlackInteractionResponse(decision.responseUrl)
	}
	return botToken
}

async function finishLeaseTurn(
	agent: CompanyBrainAgent,
	request: LeaseRequest,
	reply: string,
	failed = false,
): Promise<void> {
	const turnControl = request.turnControl
		? (resumeThreadTurn(agent, request.turnControl) ?? undefined)
		: undefined
	if (request.turnControl && !turnControl) return
	const env = brainAgent(agent).env
	const ws = await leaseWorkspace(agent, request)
	if (!ws) {
		markThreadTurnCompleted(agent, turnControl ?? request.turnControl)
		return
	}
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	const stream = createSlackStreamSession({
		botToken,
		channel: request.channel,
		threadTs: request.threadTs,
		recipientUserId: request.lesseeSlackUser,
		teamId: request.teamId,
		orgId: request.orgId,
		publicProgress: true,
		prepareReply: createSlackReplyReferenceResolver({
			env,
			teamId: request.teamId,
			botToken,
		}),
	})
	if (turnControl) {
		attachTurnCancelNotifier(agent, turnControl, async (status) => {
			await stream.discard(
				status === "cancelled" ? "Got it, stopping here." : undefined,
			)
		})
	}
	try {
		if (turnStillCurrent(agent, turnControl ?? request.turnControl)) {
			const finalized = await stream.finalize(reply, failed)
			if (reply.trim() && !finalized.streamed) {
				await stream.postFallback(reply)
			}
		}
	} finally {
		markThreadTurnCompleted(agent, turnControl ?? request.turnControl)
	}
}

export async function runSlackLeaseDecision(
	agent: CompanyBrainAgent,
	decision: SlackLeaseDecision,
): Promise<void> {
	if (decision.decision === "revoke") {
		await runLeaseRevoke(agent, decision)
		return
	}
	if (!decision.requestId) {
		await ephemeral(decision, "Something went wrong handling that action.")
		return
	}
	const env = brainAgent(agent).env
	const request = loadLeaseRequest(agent, decision.requestId)
	if (!request) {
		await ephemeral(
			decision,
			"I couldn't find that access request. It may have already expired.",
		)
		return
	}
	if (request.teamId !== decision.teamId) {
		await ephemeral(
			decision,
			"That request belongs to a different Slack workspace.",
		)
		return
	}
	const ownerDelivery = ownerDeliveryForSlackUser(
		request,
		decision.approverSlackUser,
	)
	if (!ownerDelivery) {
		await ephemeral(
			decision,
			"Only a connection owner who received this request can approve or decline it.",
		)
		return
	}
	const { ownerIndex, deliveryOrdinal } = ownerDelivery
	const owner = request.candidateOwners[ownerIndex]
	const delivery = request.cardDeliveries[deliveryOrdinal]
	if (!owner || !delivery) {
		await ephemeral(
			decision,
			"That connection-owner request is no longer valid.",
		)
		return
	}
	if (request.status !== "pending") {
		const alreadyHandled =
			request.status === "active" && request.decidedBy
				? `That request was already approved by <@${request.decidedBy}>.`
				: `That request is already ${request.status}.`
		await ephemeral(decision, alreadyHandled)
		return
	}
	if (delivery.status !== "pending") {
		await ephemeral(
			decision,
			delivery.status === "declined"
				? "You already declined this request."
				: "That owner request is no longer active.",
		)
		return
	}
	if (leaseRequestIsExpired(request)) {
		const expired = markLeaseRequestTerminalIfPending(
			agent,
			request.requestId,
			"expired",
		)
		if (!expired) {
			await ephemeral(decision, "That's already been handled.")
			return
		}
		await removeLeaseRequestCards(agent, decision, request, true)
		await captureLeaseOutcome(request, "expired")
		await finishLeaseTurn(
			agent,
			request,
			`Nobody with ${serverDisplayName(request.serverSlug)} connected approved in time, so I can't use it for this request.`,
		)
		return
	}
	if (!turnStillCurrent(agent, request.turnControl)) {
		if (
			!markLeaseRequestTerminalIfPending(agent, request.requestId, "cancelled")
		) {
			await ephemeral(decision, "That's already been handled.")
			return
		}
		await resolveCard(
			decision,
			request,
			"Cancelled",
			"That access request was superseded by a newer instruction in the thread.",
		)
		const botToken = await leaseBotToken(agent, request)
		if (botToken) {
			await updateLeaseCardsStatus(
				botToken,
				request,
				"Cancelled",
				"That access request was superseded by a newer instruction.",
				ownerIndex,
				true,
			)
		}
		return
	}

	if (!(await isOrgMember(env, request.orgId, request.lesseeUserId))) {
		if (
			!markLeaseRequestTerminalIfPending(agent, request.requestId, "cancelled")
		) {
			await ephemeral(decision, "That's already been handled.")
			return
		}
		await resolveCard(
			decision,
			request,
			"Cancelled",
			"The requester is no longer a workspace member, so no access was granted.",
		)
		const botToken = await leaseBotToken(agent, request)
		if (botToken) {
			await updateLeaseCardsStatus(
				botToken,
				request,
				"Cancelled",
				"The requester is no longer a workspace member.",
				ownerIndex,
				true,
			)
		}
		await finishLeaseTurn(
			agent,
			request,
			`I can't continue with ${serverDisplayName(request.serverSlug)} because the requester is no longer a workspace member.`,
			true,
		)
		return
	}
	const conn = await getConnectionById(env, owner.connectionId)
	const eligible = await isEligibleLeaseOwner(
		env,
		request.orgId,
		request.serverSlug,
		owner.userId,
		owner.connectionId,
	)
	if (
		!conn ||
		conn.id !== owner.connectionId ||
		conn.orgId !== request.orgId ||
		conn.serverSlug !== request.serverSlug ||
		conn.status !== "active" ||
		conn.userId !== owner.userId ||
		!eligible
	) {
		const invalidated = updateLeaseOwnerDelivery(
			agent,
			request.requestId,
			ownerIndex,
			"invalidated",
			decision.approverSlackUser,
		)
		if (invalidated.outcome === "stale") {
			await ephemeral(decision, "That's already been handled.")
			return
		}
		if (invalidated.outcome === "pending") {
			await ephemeral(
				decision,
				`Your ${serverDisplayName(request.serverSlug)} connection is no longer available. The request is still waiting for another tagged connection owner.`,
			)
			return
		}
		await resolveCard(
			decision,
			request,
			"Unavailable",
			`Your ${serverDisplayName(request.serverSlug)} connection is no longer available, so no access was shared.`,
		)
		await captureLeaseOutcome(invalidated.request ?? request, "none")
		await finishLeaseTurn(
			agent,
			invalidated.request ?? request,
			`Nobody with an active ${serverDisplayName(request.serverSlug)} connection is still available to approve this request.`,
		)
		return
	}

	if (decision.decision === "deny") {
		const declined = updateLeaseOwnerDelivery(
			agent,
			request.requestId,
			ownerIndex,
			"declined",
			decision.approverSlackUser,
		)
		if (declined.outcome === "stale") {
			await ephemeral(decision, "That's already been handled.")
			return
		}
		if (declined.outcome === "pending") {
			await ephemeral(
				decision,
				"You declined. The request is still waiting for another tagged connection owner.",
			)
			return
		}
		const terminalRequest = declined.request ?? request
		if (declined.outcome === "all_declined") {
			await resolveCard(
				decision,
				terminalRequest,
				"Declined",
				"All tagged connection owners declined; no access was shared.",
			)
			await captureLeaseOutcome(terminalRequest, "all_denied")
			await finishLeaseTurn(
				agent,
				terminalRequest,
				`Everyone with ${serverDisplayName(request.serverSlug)} connected declined, so I can't use it for this request.`,
			)
			return
		}
		await resolveCard(
			decision,
			terminalRequest,
			"Unavailable",
			"No tagged connection owner with an active connection remains available.",
		)
		await captureLeaseOutcome(terminalRequest, "none")
		await finishLeaseTurn(
			agent,
			terminalRequest,
			`Nobody with an active ${serverDisplayName(request.serverSlug)} connection is still available to approve this request.`,
		)
		return
	}

	const mode: LeaseMode = request.mode
	const now = Date.now()
	const lease: AccessLease = {
		leaseId: generateId(),
		requestId: request.requestId,
		orgId: request.orgId,
		teamId: request.teamId,
		channel: request.channel,
		threadTs: request.threadTs,
		lesseeUserId: request.lesseeUserId,
		lessorUserId: owner.userId,
		lessorConnectionId: owner.connectionId,
		serverSlug: request.serverSlug,
		mode,
		reason: request.reason,
		status: "active",
		approvedBySlack: decision.approverSlackUser,
		createdAt: now,
		expiresAt: now + LEASE_TTL_MS,
	}
	const activated = activateAccessLease(agent, ownerIndex, lease)
	if (!activated) {
		await ephemeral(decision, "That's already been handled.")
		return
	}
	const turnControl = request.turnControl
		? (resumeThreadTurn(agent, request.turnControl) ?? undefined)
		: undefined
	if (request.turnControl && !turnControl) {
		revokeAccessLease(agent, lease.leaseId)
		await resolveCard(
			decision,
			activated,
			"Cancelled",
			"That access request was superseded by a newer instruction in the thread.",
		)
		const botToken = await leaseBotToken(agent, request)
		if (botToken) {
			await updateLeaseCardsStatus(
				botToken,
				activated,
				"Cancelled",
				"That access request was superseded by a newer instruction.",
				ownerIndex,
			)
		}
		return
	}
	const approvedCopy = leaseApprovedMessage(
		serverDisplayName(request.serverSlug),
		decision.approverSlackUser,
	)
	const botToken = await removeLeaseRequestCards(agent, decision, activated)
	if (botToken) {
		await postSlackMessage(
			botToken,
			request.channel,
			approvedCopy,
			request.threadTs,
		)
	}
	await captureLeaseOutcome(
		{ ...activated, createdAt: request.createdAt },
		"approved",
		ownerIndex + 1,
	)
	await runLeaseFollowUp(agent, request, mode, turnControl)
}

export async function runLeaseEscalation(
	agent: CompanyBrainAgent,
	payload: LeaseEscalationPayload,
): Promise<void> {
	const request = loadLeaseRequest(agent, payload.requestId)
	if (!request || request.status !== "pending") return
	if (!leaseRequestIsExpired(request)) {
		await armLeaseRequestExpiry(agent, request)
		return
	}
	if (!turnStillCurrent(agent, request.turnControl)) {
		const cancelled = markLeaseRequestTerminalIfPending(
			agent,
			request.requestId,
			"cancelled",
		)
		if (!cancelled) return
		const botToken = await leaseBotToken(agent, request)
		if (botToken) {
			await updateLeaseCardsStatus(
				botToken,
				request,
				"Cancelled",
				"That access request was superseded by a newer instruction.",
				undefined,
				true,
			)
		}
		return
	}
	const expired = markLeaseRequestTerminalIfPending(
		agent,
		request.requestId,
		"expired",
	)
	if (!expired) return
	const botToken = await leaseBotToken(agent, request)
	if (botToken) {
		await deleteLeaseCards(botToken, request, true)
	}
	await captureLeaseOutcome(request, "expired")
	await finishLeaseTurn(
		agent,
		request,
		`Nobody with ${serverDisplayName(request.serverSlug)} connected approved in time, so I can't use it for this request.`,
	)
}

async function runLeaseRevoke(
	agent: CompanyBrainAgent,
	decision: SlackLeaseDecision,
): Promise<void> {
	if (!decision.leaseId) {
		await ephemeral(decision, "Something went wrong handling that action.")
		return
	}
	const lease = loadAccessLease(agent, decision.leaseId)
	if (!lease) {
		await ephemeral(decision, "That access grant no longer exists.")
		return
	}
	if (lease.teamId !== decision.teamId) {
		await ephemeral(
			decision,
			"That grant belongs to a different Slack workspace.",
		)
		return
	}
	if (lease.approvedBySlack !== decision.approverSlackUser) {
		await ephemeral(
			decision,
			"Only the connection owner who granted this access can revoke it.",
		)
		return
	}
	const revoked = revokeAccessLease(agent, lease.leaseId)
	const text = revoked ? "Access revoked." : "That access had already ended."
	const request = loadLeaseRequest(agent, lease.requestId)
	if (request) {
		await resolveCard(decision, request, "Revoked", text)
	} else {
		await ephemeral(decision, text)
	}
}
async function runLeaseFollowUp(
	agent: CompanyBrainAgent,
	request: LeaseRequest,
	mode: LeaseMode,
	turnControl: RunningTurnControl | undefined,
): Promise<void> {
	const env = brainAgent(agent).env
	const ws = await leaseWorkspace(agent, request)
	if (!ws) return
	const org: SlackOrg = {
		id: ws.orgId,
		name: ws.orgName,
		slug: ws.orgSlug,
		metadata: ws.orgMetadata,
	}
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	const traceId = generateId()
	const [{ botId: slackBotId }, thread, askerInfo] = await Promise.all([
		getSlackBotIdentity(botToken),
		getSlackThread(botToken, request.channel, request.threadTs),
		getSlackUserInfo(botToken, request.lesseeSlackUser),
	])
	const threadText = buildThreadContext(
		agent,
		request.channel,
		thread,
		ws.botUserId,
		slackBotId,
		undefined,
	)
	const asker = { ...askerInfo, slackUserId: request.lesseeSlackUser }
	const framed = `You now have temporary ${describeGrantedCapabilities(request.serverSlug, mode)}, approved by the connection owner and scoped to this thread. Answer the asker's earlier request now using it — your reply text is posted to this thread automatically, so do NOT use any tool to post to Slack; just produce the answer.\n\nWhat the asker needs: ${request.reason}`
	const stream = createSlackStreamSession({
		botToken,
		channel: request.channel,
		threadTs: request.threadTs,
		recipientUserId: request.lesseeSlackUser,
		teamId: request.teamId,
		orgId: org.id,
		publicProgress: true,
		prepareReply: createSlackReplyReferenceResolver({
			env,
			teamId: request.teamId,
			botToken,
		}),
	})
	if (turnControl) {
		attachTurnCancelNotifier(agent, turnControl, async (status) => {
			await stream.discard(
				status === "cancelled" ? "Got it, stopping here." : undefined,
			)
		})
	}

	let reply = ""
	let failed = false
	let suspended = false
	const { deadline: leaseDeadline, signal: leaseAbortSignal } =
		turnDeadlineSignal(turnControl?.signal)
	const compute = computeTurn({
		agent,
		org,
		userId: request.lesseeUserId,
		actor: {
			orgId: org.id,
			userId: request.lesseeUserId,
			personalConnectionsOnly: true,
			memberLookup: "found",
		},
		question: framed,
		threadText,
		asker,
		slackLookup: {
			botToken,
			channel: request.channel,
			threadTs: request.threadTs,
			teamId: request.teamId,
		},
		progress: fencedProgress(agent, turnControl, stream.progress),
		env,
		options: {
			abortSignal: leaseAbortSignal,
			turnControl,
		},
	})
	try {
		const out = await raceWithAbortSignal(compute, leaseAbortSignal)
		if (out.status === "suspended") {
			if (
				turnControl &&
				!markThreadTurnWaitingForApproval(agent, turnControl)
			) {
				return
			}
			suspended = true
			await suspendLeaseFollowUp(
				agent,
				request,
				botToken,
				stream,
				out,
				turnControl,
			)
			return
		}
		reply = out.reply
	} catch (err) {
		retainAbandoned(compute, (promise) => brainAgent(agent).waitUntil(promise))
		if (turnWasInterrupted(agent, turnControl)) {
			return
		}
		if (leaseDeadline.aborted) {
			console.warn(
				`[company-brain][${traceId}] lease follow-up hit wall-clock deadline`,
			)
			reply = `I got temporary access to ${serverDisplayName(request.serverSlug)}, but this is taking longer than usual so I paused here. Reply in the thread and I'll pick it back up.`
		} else {
			failed = true
			console.error(`[company-brain][${traceId}] lease follow-up failed:`, err)
			reply = `I got temporary access to ${serverDisplayName(request.serverSlug)}, but hit an error answering. Mind asking again in this thread?`
		}
	}
	try {
		if (turnStillCurrent(agent, turnControl)) {
			const finalizeResult = await stream.finalize(reply, failed)
			if (reply.trim() && !finalizeResult.streamed) {
				await stream.postFallback(reply)
			}
		}
	} finally {
		if (!suspended) {
			if (turnControl && hasPendingLeaseRequestForTurn(agent, turnControl)) {
				markThreadTurnWaitingForApproval(agent, turnControl)
			} else {
				markThreadTurnCompleted(agent, turnControl)
			}
		}
	}
}
async function suspendLeaseFollowUp(
	agent: CompanyBrainAgent,
	request: LeaseRequest,
	botToken: string,
	stream: ReturnType<typeof createSlackStreamSession>,
	out: Extract<
		Awaited<ReturnType<typeof computeTurn>>,
		{ status: "suspended" }
	>,
	turnControl: RunningTurnControl | undefined,
): Promise<void> {
	const now = Date.now()
	const pending: PendingApproval = {
		approvalId: out.approval.approvalId,
		turnId: `lease:${request.requestId}:${out.approval.approvalId}`,
		orgId: request.orgId,
		teamId: request.teamId,
		channel: request.channel,
		threadTs: request.threadTs,
		askerUser: request.lesseeSlackUser,
		toolName: out.approval.toolName,
		slug: out.approval.slug,
		toolInput: out.approval.input,
		summary: out.approval.summary,
		state: out.state,
		status: "pending",
		createdAt: now,
		expiresAt: now + APPROVAL_EXPIRY_MS,
	}
	insertPendingApproval(agent, pending)
	await stream.finalize("", false)
	const cardTs = await postSlackApprovalCard(
		botToken,
		request.channel,
		request.threadTs,
		{
			approvalId: pending.approvalId,
			summary: pending.summary,
			toolName: pending.toolName,
			slug: pending.slug,
			askerUser: pending.askerUser,
			expiresAt: pending.expiresAt,
		},
	)
	if (cardTs) {
		setApprovalCardTs(agent, pending.approvalId, cardTs)
		await armApprovalExpiry(agent, pending)
	} else {
		markApprovalTerminal(agent, pending.approvalId, "error")
		await stream.postFallback(
			"I got access, but couldn't post the approval buttons for that action. Mind asking again?",
		)
		markThreadTurnCompleted(agent, turnControl ?? request.turnControl)
	}
}
