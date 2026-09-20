import { generateId } from "@repo/lib/generate-id"
import { decryptToken } from "@/lib/crypto"
import {
	companyBrainDenialMessage,
	getCompanyBrainEntitlement,
	orgCanRunCompanyBrain,
} from "@/lib/payments/company-brain-entitlement"
import { companyBrainActivateUrl } from "@/lib/payments/company-brain-trial"
import { hasPendingLeaseRequestForTurn } from "../lease/store"
import { maybeSyncBrainProfileConfig } from "../memory/profile-sync"
import {
	type MemoryWriteback,
	memoryDocsFromWriteback,
	type SlackMemoryScope,
} from "../memory/writeback"
import type { BrainObservabilityInput } from "../observability"
import {
	botSpokePrevious,
	buildThreadConversation,
	cleanMention,
	computeInteractionContext,
	formatThreadParticipants,
	formatWorkspaceGroups,
	isConnectOnlyRequest,
	isOurSlackBotMessage,
	originalRequestForConnectAcceptance,
} from "../prompt/build"
import { getCatalogEntry, isMcpCatalogSlug } from "../tools/mcp/catalog"
import { startMcpConnect } from "../tools/mcp/connect"
import {
	getDirectoryEntryBySlug,
	mcpAppDisplayName,
} from "../tools/mcp/directory"
import type { TurnActor } from "../turn/actor"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import {
	APPROVAL_EXPIRY_MS,
	approvalIsExpired,
	checkpointApprovalResumeState,
	insertPendingApproval,
	loadApproval,
	markApprovalDecided,
	markApprovalTerminal,
	type PendingApproval,
	setApprovalCardTs,
} from "../turn/approval"
import { armApprovalExpiry } from "../turn/approval-expiry"
import { resolveApprovalIconUrl } from "../turn/approval-icons"
import { computeTurn } from "../turn/compute"
import { getHomeChannel } from "../turn/home-channel"
import { type Effort, resolveBrainTriageProfile } from "../turn/model-profile"
import {
	armPostTurnReflect,
	cancelPostTurnReflect,
} from "../turn/post-turn-reflect"
import { resumeTurnAfterApproval } from "../turn/resume"
import type {
	SlackTurnFiberControl,
	SlackTurnFiberSnapshot,
} from "../turn/slack-turn-fiber"
import type { ComputeTurnResult, TurnToolTraceEntry } from "../turn/types"
import {
	raceWithAbortSignal,
	retainAbandoned,
	turnDeadlineSignal,
} from "../turn/util"
import { postSlackAccountLinkPrompt } from "./account-link"
import {
	applyActiveTurnPolicy,
	triageActiveTurnMessage,
} from "./active-turn-gate"
import { collectTurnFiles, loadThreadAttachmentParts } from "./attachments"
import { collectBotAddressAliases, isBotAddressedByName } from "./bot-address"
import {
	formatChannelMessageText,
	formatSlackTsHuman,
	type SlackLookupContext,
} from "./channel-lookup"
import {
	canUseAnswerFallback,
	type PassiveInvestigationClaim,
	releasePassiveInvestigation,
	reserveChimeAnswer,
	reservePassiveInvestigation,
} from "./chime-budget"
import {
	addSlackReaction,
	buildSlackBotIdentity,
	clearAssistantThreadStatus,
	getCachedSlackConversationInfo,
	getSlackBotIdentity,
	getSlackMessageBlocks,
	getSlackTeamDirectory,
	getSlackThread,
	getSlackThreadHistory,
	getSlackUserGroups,
	getSlackUserInfo,
	lookupSlackUserInfo,
	postSlackApprovalCard,
	postSlackEphemeral,
	postSlackMessage,
	removeSlackReaction,
	resolvedApprovalBlocks,
	type SlackConversationInfo,
	type SlackThreadMessage,
	type SlackUserInfo,
	type SlackUserInfoLookup,
	setAssistantThreadStatus,
	swapSlackReaction,
	updateSlackInteractionResponse,
	updateSlackMessage,
} from "./client"
import { deliverSlackDebugTrace } from "./debug-trace-delivery"
import {
	claimLocalContextWarmup,
	claimStoredEventForTriage,
	getPreviousHumanChannelActivityAt,
	getStoredSlackEventAudit,
	isLocalContextHistoryComplete,
	loadLocalThreadContext,
	markLocalContextWarm,
	markStoredEventFiltered,
	mergeSlackThreadHistoryIntoLocalContext,
	recordSlackEvent,
	recordStoredActionOutcome,
	recordStoredSuppression,
	recordStoredTriageDecision,
	type SlackEventIdentity,
} from "./event-store"
import {
	BRAIN_MUTE_REACTION,
	isAssistantThreadMessage,
	isBotMentioned,
	isDirectMessage,
	isEmojiOnlySlackText,
	isPrivateSlackChannel,
	isSlackContentMessageSubtype,
	mentionedUserIds,
	type SlackTurnMessage,
	triageProfileUserIds,
} from "./events"
import { BRAIN_TRACE_POSTHOG_BASE } from "./format"
import {
	postSlackMcpConnectButtons,
	stampSlackMcpConnectButtons,
} from "./mcp-connect"
import {
	buildThreadContext,
	lookupMessageTraceRecords,
	recordMessageTrace,
} from "./message-trace"
import {
	PROACTIVITY_FILTER_REASON,
	resolveChannelProactivity,
} from "./proactivity"
import {
	getCachedSlackChannelInfo,
	getCachedSlackUserInfo,
	getCachedSlackUserProfiles,
} from "./profile-cache"
import { enqueuePassiveReaction } from "./reaction-queue"
import { createSlackReplyReferenceResolver } from "./references"
import { resolveSlackReplyTarget } from "./routing"
import { CONTEXT_FOOTER_BLOCK_ID, createSlackStreamSession } from "./stream"
import {
	scheduleTriageOutcome,
	type TriageAddressedTarget,
	type TriageObservabilityContext,
	triageChimeMessage,
} from "./triage"
import { reserveTriageTraceSample } from "./triage-sampling"
import {
	attachTurnCancelNotifier,
	beginThreadTurn,
	classifyTurnSteering,
	completeInterruptedThreadTurn,
	fencedProgress,
	getThreadTurn,
	interruptThreadTurn,
	isSteerableThreadTurn,
	isThreadTurnCurrent,
	markThreadTurnCompleted,
	markThreadTurnWaitingForApproval,
	type RunningTurnControl,
	reapUnfinishedThreadTurn,
	resumeThreadTurn,
	slackThreadTurnKey,
	supersedeInterruptedThreadTurn,
	type ThreadTurnStartExpectation,
	type TurnControlSnapshot,
	threadTurnStartExpectation,
	waitForThreadTurnFinalization,
} from "./turn-control"
import {
	discardTurnUpdateReservation,
	listCurrentTurnUpdates,
	reserveTurnUpdate,
	resolveTurnUpdate,
	waitForTurnUpdateClassification,
} from "./turn-inbox"
import {
	ensureWorkspaceBotUserId,
	formatSlackOrgMemberDenial,
	formatSlackProfileLookupFailure,
	getOrgActorBySlackIdentity,
	getWorkspaceByTeamId,
	type SlackOrg,
	shouldPostSlackOrgMemberDenial,
	slackUserDisplayName,
} from "./workspace"

const THREAD_CONTEXT_PAGE_SIZE = 200
const THREAD_CONTEXT_MAX_MESSAGES = 600
const THREAD_CONTEXT_MAX_PAGES = 4
const THREAD_TRIAGE_CONTEXT_LIMIT = 50
const SLACK_ACK_REACTION = "ack"
const SLACK_ACK_FALLBACK_REACTION = "white_check_mark"
const SLACK_COMPLETED_REPLY_REACTION = "brain"

function slackMemoryScopeForTurn(args: {
	isDM: boolean
	channel: string
	channelType?: string
	userId?: string
	slackUserId?: string
	conversationInfo?: SlackConversationInfo
}): SlackMemoryScope {
	const { isDM, channel, channelType, userId, slackUserId, conversationInfo } =
		args
	const base = {
		channelId: channel,
		...(channelType ? { channelType } : {}),
	}
	const scopedUser = userId ? { userId } : {}
	if (isDM) {
		return {
			kind: "dm",
			...base,
			...scopedUser,
			...(slackUserId ? { slackUserId } : {}),
		}
	}

	// Privacy signals are intentionally monotonic: a live private event must
	// win over cached public conversation info, and cached private info remains
	// the safer scope when the event is ambiguous.
	const isPrivate =
		isPrivateSlackChannel(channel, channelType) ||
		conversationInfo?.isPrivate === true

	return isPrivate
		? { kind: "private_channel", ...base, ...scopedUser }
		: { kind: "shared", ...base }
}

function slackMemoryWriterUserId(
	scope: SlackMemoryScope | undefined,
	fallbackUserId: string | undefined,
): string | undefined {
	if (scope?.kind === "dm" || scope?.kind === "private_channel") {
		return scope.userId
	}
	return fallbackUserId
}

function trustedSlackUserIdsForMemoryTags(
	message: { user?: string; text?: string },
	thread: Array<{ user?: string; text?: string }>,
	botUserId?: string,
): string[] {
	return [
		...new Set(
			[
				message.user,
				...mentionedUserIds(message.text, botUserId),
				...thread.flatMap((m) => [
					m.user,
					...mentionedUserIds(m.text, botUserId),
				]),
			].filter((id): id is string => Boolean(id?.trim())),
		),
	]
}

function lastSeen(
	agent: CompanyBrainAgent,
	userId: string,
): number | undefined {
	const rows = agent.sql<{ last_seen: number }>`
		SELECT last_seen FROM brain_user_seen WHERE user_id = ${userId}
	`
	return rows[0]?.last_seen
}

function markSeen(agent: CompanyBrainAgent, userId: string, ts: number): void {
	agent.sql`
		INSERT INTO brain_user_seen (user_id, last_seen) VALUES (${userId}, ${ts})
		ON CONFLICT(user_id) DO UPDATE SET last_seen = ${ts}
	`
}

export type SlackApprovalDecision = {
	teamId: string
	approvalId: string
	approved: boolean
	userId: string
	responseUrl?: string
}

async function updateDecisionResponse(
	env: Env,
	decision: SlackApprovalDecision,
	approval: PendingApproval,
	status: "Approved" | "Denied" | "Expired" | "Cancelled",
	text: string,
	replaceOriginal = true,
): Promise<void> {
	if (!decision.responseUrl) return
	await updateSlackInteractionResponse(decision.responseUrl, {
		text,
		replaceOriginal,
		responseType: replaceOriginal ? undefined : "ephemeral",
		blocks: replaceOriginal
			? resolvedApprovalBlocks(
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
					status,
				)
			: undefined,
	})
}

async function replyEphemeral(
	decision: SlackApprovalDecision,
	text: string,
): Promise<void> {
	if (!decision.responseUrl) return
	await updateSlackInteractionResponse(decision.responseUrl, {
		text,
		responseType: "ephemeral",
	})
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

export const THREAD_MUTED_FILTER_REASON =
	"A member muted this thread for proactive replies (⏹ reaction)."

const MUTE_OFFER_FOOTER =
	"React :black_square_for_stop: to mute me in this thread"

function mutedFooter(mutedBy: string): string {
	return `Muted by <@${mutedBy}> — mention me anytime`
}

async function updateMuteFooter(
	botToken: string,
	channel: string,
	threadTs: string,
	messageTs: string,
	footerText: string,
): Promise<boolean> {
	const message = await getSlackMessageBlocks(
		botToken,
		channel,
		threadTs,
		messageTs,
	)
	if (!message) return false
	const footerBlock = {
		type: "context",
		block_id: CONTEXT_FOOTER_BLOCK_ID,
		elements: [{ type: "mrkdwn", text: footerText }],
	}
	let found = false
	let blocks = message.blocks.map((block) => {
		const b = block as { block_id?: string }
		if (b.block_id !== CONTEXT_FOOTER_BLOCK_ID) return block
		found = true
		return footerBlock
	})
	if (!found) {
		blocks = message.blocks.length
			? [...message.blocks, footerBlock]
			: [
					{
						type: "section",
						text: { type: "mrkdwn", text: message.text },
					},
					footerBlock,
				]
	}
	return updateSlackMessage(botToken, channel, messageTs, message.text, blocks)
}

function ensureBotThreadTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_bot_thread (
			team_id TEXT NOT NULL,
			channel TEXT NOT NULL,
			thread_ts TEXT NOT NULL,
			updated_at INTEGER NOT NULL,
			muted_at INTEGER,
			muted_by TEXT,
			PRIMARY KEY (team_id, channel, thread_ts)
		)
	`
	const columns = new Set(
		agent.sql<{ name: string }>`
			PRAGMA table_info(brain_bot_thread)
		`.map((column) => column.name),
	)
	if (!columns.has("muted_at")) {
		agent.sql`ALTER TABLE brain_bot_thread ADD COLUMN muted_at INTEGER`
	}
	if (!columns.has("muted_by")) {
		agent.sql`ALTER TABLE brain_bot_thread ADD COLUMN muted_by TEXT`
	}
}

function markBotThread(
	agent: CompanyBrainAgent,
	teamId: string,
	channel: string,
	threadTs: string,
): void {
	ensureBotThreadTable(agent)
	agent.sql`
		INSERT INTO brain_bot_thread (team_id, channel, thread_ts, updated_at)
		VALUES (${teamId}, ${channel}, ${threadTs}, ${Date.now()})
		ON CONFLICT(team_id, channel, thread_ts)
		DO UPDATE SET updated_at = excluded.updated_at
	`
}

function hasBotThread(
	agent: CompanyBrainAgent,
	teamId: string,
	channel: string,
	threadTs: string,
): boolean {
	ensureBotThreadTable(agent)
	const rows = agent.sql<{ thread_ts: string }>`
		SELECT thread_ts FROM brain_bot_thread
		WHERE team_id = ${teamId} AND channel = ${channel} AND thread_ts = ${threadTs}
		LIMIT 1
	`
	return Boolean(rows[0])
}

export function isThreadMuted(
	agent: CompanyBrainAgent,
	teamId: string,
	channel: string,
	threadTs: string,
): boolean {
	ensureBotThreadTable(agent)
	const rows = agent.sql<{ muted_at: number | null }>`
		SELECT muted_at FROM brain_bot_thread
		WHERE team_id = ${teamId} AND channel = ${channel} AND thread_ts = ${threadTs}
		LIMIT 1
	`
	return Boolean(rows[0]?.muted_at)
}

export function setThreadMuted(
	agent: CompanyBrainAgent,
	teamId: string,
	channel: string,
	threadTs: string,
	mutedBy: string,
): void {
	ensureBotThreadTable(agent)
	agent.sql`
		INSERT INTO brain_bot_thread (team_id, channel, thread_ts, updated_at, muted_at, muted_by)
		VALUES (${teamId}, ${channel}, ${threadTs}, ${Date.now()}, ${Date.now()}, ${mutedBy})
		ON CONFLICT(team_id, channel, thread_ts)
		DO UPDATE SET
			muted_at = COALESCE(brain_bot_thread.muted_at, excluded.muted_at),
			muted_by = COALESCE(brain_bot_thread.muted_by, excluded.muted_by)
	`
}

function getThreadMutedBy(
	agent: CompanyBrainAgent,
	teamId: string,
	channel: string,
	threadTs: string,
): string | null {
	ensureBotThreadTable(agent)
	const rows = agent.sql<{ muted_at: number | null; muted_by: string | null }>`
		SELECT muted_at, muted_by FROM brain_bot_thread
		WHERE team_id = ${teamId} AND channel = ${channel} AND thread_ts = ${threadTs}
		LIMIT 1
	`
	return rows[0]?.muted_at ? (rows[0]?.muted_by ?? null) : null
}

export function clearThreadMuted(
	agent: CompanyBrainAgent,
	teamId: string,
	channel: string,
	threadTs: string,
): void {
	ensureBotThreadTable(agent)
	agent.sql`
		UPDATE brain_bot_thread SET muted_at = NULL, muted_by = NULL
		WHERE team_id = ${teamId} AND channel = ${channel} AND thread_ts = ${threadTs}
	`
}

type ConnectContinuationClaim = {
	teamId: string
	channel: string
	threadTs: string
	slackUserId: string
	requestKey: string
}

function connectContinuationRequestKey(question: string | undefined): string {
	return cleanMention(question).toLowerCase().replace(/\s+/g, " ").trim()
}

function ensureConnectContinuationTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_connect_continuation (
			team_id TEXT NOT NULL,
			channel TEXT NOT NULL,
			thread_ts TEXT NOT NULL,
			slack_user_id TEXT NOT NULL,
			request_key TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (team_id, channel, thread_ts, slack_user_id, request_key)
		)
	`
}

function hasConnectContinuation(
	agent: CompanyBrainAgent,
	claim: ConnectContinuationClaim,
): boolean {
	ensureConnectContinuationTable(agent)
	const rows = agent.sql<{ request_key: string }>`
		SELECT request_key FROM brain_connect_continuation
		WHERE team_id = ${claim.teamId}
			AND channel = ${claim.channel}
			AND thread_ts = ${claim.threadTs}
			AND slack_user_id = ${claim.slackUserId}
			AND request_key = ${claim.requestKey}
		LIMIT 1
	`
	return Boolean(rows[0])
}

function markConnectContinuation(
	agent: CompanyBrainAgent,
	claim: ConnectContinuationClaim,
): void {
	ensureConnectContinuationTable(agent)
	const now = Date.now()
	agent.sql`
		DELETE FROM brain_connect_continuation
		WHERE created_at < ${now - 7 * 24 * 60 * 60 * 1000}
	`
	agent.sql`
		INSERT OR IGNORE INTO brain_connect_continuation
			(team_id, channel, thread_ts, slack_user_id, request_key, created_at)
		VALUES (
			${claim.teamId},
			${claim.channel},
			${claim.threadTs},
			${claim.slackUserId},
			${claim.requestKey},
			${now}
		)
	`
}

function releaseConnectContinuation(
	agent: CompanyBrainAgent,
	claim: ConnectContinuationClaim | undefined,
): void {
	if (!claim) return
	ensureConnectContinuationTable(agent)
	agent.sql`
		DELETE FROM brain_connect_continuation
		WHERE team_id = ${claim.teamId}
			AND channel = ${claim.channel}
			AND thread_ts = ${claim.threadTs}
			AND slack_user_id = ${claim.slackUserId}
			AND request_key = ${claim.requestKey}
	`
}

function claimConnectContinuation(
	agent: CompanyBrainAgent,
	args: Omit<ConnectContinuationClaim, "requestKey"> & {
		originalQuestion: string
	},
): ConnectContinuationClaim | undefined {
	const requestKey = connectContinuationRequestKey(args.originalQuestion)
	if (!requestKey) return undefined
	const claim: ConnectContinuationClaim = {
		teamId: args.teamId,
		channel: args.channel,
		threadTs: args.threadTs,
		slackUserId: args.slackUserId,
		requestKey,
	}
	if (hasConnectContinuation(agent, claim)) return undefined
	markConnectContinuation(agent, claim)
	return claim
}

type TurnClaim = { control?: TurnControlSnapshot }

export async function runSlackApprovalDecision(
	agent: CompanyBrainAgent,
	decision: SlackApprovalDecision,
): Promise<void> {
	const claim: TurnClaim = {}
	try {
		await runSlackApprovalDecisionInner(agent, decision, claim)
	} finally {
		reapUnfinishedThreadTurn(agent, claim.control)
	}
}

async function runSlackApprovalDecisionInner(
	agent: CompanyBrainAgent,
	decision: SlackApprovalDecision,
	claim: TurnClaim,
): Promise<void> {
	const env = brainAgent(agent).env
	const approval = loadApproval(agent, decision.approvalId)
	if (!approval) {
		await replyEphemeral(
			decision,
			"I couldn't find that approval request. It may have already expired.",
		)
		return
	}
	if (approval.teamId !== decision.teamId) {
		await replyEphemeral(
			decision,
			"That approval belongs to a different Slack workspace.",
		)
		return
	}
	if (approval.askerUser !== decision.userId) {
		await replyEphemeral(
			decision,
			`Only <@${approval.askerUser}> can approve or deny this action.`,
		)
		return
	}
	if (approval.status !== "pending") {
		await replyEphemeral(
			decision,
			`That approval is already ${approval.status}.`,
		)
		return
	}
	if (approvalIsExpired(approval)) {
		markApprovalTerminal(agent, approval.approvalId, "expired")
		await updateDecisionResponse(
			env,
			decision,
			approval,
			"Expired",
			"This approval expired after 15 minutes.",
		)
		return
	}
	if (approval.state.turnControl) {
		await waitForTurnUpdateClassification(agent, approval.state.turnControl)
	}
	if (!turnStillCurrent(agent, approval.state.turnControl)) {
		markApprovalTerminal(agent, approval.approvalId, "cancelled")
		await updateDecisionResponse(
			env,
			decision,
			approval,
			"Cancelled",
			"That approval was superseded by a newer instruction in the thread.",
		)
		return
	}
	const ws = await getWorkspaceByTeamId(env, decision.teamId)
	if (!ws) {
		await replyEphemeral(
			decision,
			"I couldn't resume that action. The workspace configuration is missing.",
		)
		return
	}
	if (ws.orgId !== agent.name) {
		console.error(
			`[company-brain] approval dropped: workspace rebound team=${decision.teamId} approvalOrg=${agent.name} currentOrg=${ws.orgId}`,
		)
		await replyEphemeral(
			decision,
			"I couldn't resume that action because the workspace configuration changed.",
		)
		return
	}
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	const decisionUserLookup = await lookupSlackUserInfo(
		botToken,
		decision.userId,
	)
	if (!decisionUserLookup.ok) {
		console.warn(
			`[company-brain] approval verification failed org=${ws.orgId} slackUser=${decision.userId} reason=${decisionUserLookup.reason} error=${decisionUserLookup.error ?? "-"}`,
		)
		await replyEphemeral(decision, formatSlackProfileLookupFailure())
		return
	}
	const decisionUserInfo = decisionUserLookup.user
	const decisionResolution = await getOrgActorBySlackIdentity(env, {
		orgId: ws.orgId,
		teamId: decision.teamId,
		slackUserId: decision.userId,
		email: decisionUserInfo.email,
	})
	const decisionActor = decisionResolution.actor
	if (!decisionActor) {
		console.warn(
			`[company-brain] approval denied for non-member org=${ws.orgId} slackUser=${decision.userId} lookup=${decisionResolution.lookup}`,
		)
		await replyEphemeral(
			decision,
			formatSlackOrgMemberDenial({
				personName: slackUserDisplayName(decisionUserInfo),
				orgName: ws.orgName,
			}),
		)
		return
	}
	const decided = markApprovalDecided(
		agent,
		approval.approvalId,
		decision.approved ? "approved" : "denied",
		decision.userId,
	)
	if (!decided) {
		await replyEphemeral(decision, "That's already been handled.")
		return
	}

	await updateDecisionResponse(
		env,
		decision,
		approval,
		decision.approved ? "Approved" : "Denied",
		decision.approved
			? "Approved. I'll continue in the thread."
			: "Denied. I won't run that action.",
	)

	const org: SlackOrg = {
		id: ws.orgId,
		name: ws.orgName,
		slug: ws.orgSlug,
		metadata: ws.orgMetadata,
	}
	const resumeEntitlement = await getCompanyBrainEntitlement(
		env,
		org.id,
		(promise) => agent.waitUntil(promise),
	)
	if (!resumeEntitlement.allowed) {
		console.log(
			`[company-brain] approval resume blocked: entitlement org=${org.id} reason=${resumeEntitlement.reason}`,
		)
		await updateDecisionResponse(
			env,
			decision,
			approval,
			"Cancelled",
			companyBrainDenialMessage(
				resumeEntitlement.reason,
				env,
				companyBrainActivateUrl(env),
			),
		)
		return
	}
	const turnControl =
		(approval.state.turnControl
			? resumeThreadTurn(agent, approval.state.turnControl)
			: undefined) ?? undefined
	claim.control = turnControl
	if (approval.state.turnControl && !turnControl) {
		markApprovalTerminal(agent, approval.approvalId, "cancelled")
		await updateDecisionResponse(
			env,
			decision,
			approval,
			"Cancelled",
			"That approval was superseded by a newer instruction in the thread.",
		)
		return
	}
	const stream = createSlackStreamSession({
		botToken,
		channel: approval.channel,
		threadTs: approval.threadTs,
		recipientUserId: approval.askerUser,
		teamId: decision.teamId,
		orgId: approval.orgId,
		publicProgress: true,
		clearAssistantStatusOnProgress: true,
		prepareReply: createSlackReplyReferenceResolver({
			env,
			teamId: decision.teamId,
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
	void setAssistantThreadStatus(
		botToken,
		approval.channel,
		approval.threadTs,
		decision.approved ? "Running approved action..." : "Wrapping up...",
		["Dreaming"],
	)

	let reply = ""
	let turnResult: ComputeTurnResult | undefined
	let failed = false
	const { deadline: resumeDeadline, signal: resumeAbortSignal } =
		turnDeadlineSignal(turnControl?.signal)
	const resume = resumeTurnAfterApproval({
		agent,
		org,
		approval,
		approved: decision.approved,
		progress: fencedProgress(agent, turnControl, stream.progress),
		obs: {
			traceId: generateId(),
			distinctId: approval.state.actor.userId ?? approval.state.userId,
			sessionId: `${approval.channel}:${approval.threadTs}`,
			channel: approval.channel,
			source: "slack_approval",
		},
		abortSignal: resumeAbortSignal,
		onTerminalProposal: (proposal) => {
			if (proposal) approval.state.terminalProposal = proposal
			else delete approval.state.terminalProposal
			checkpointApprovalResumeState(agent, approval.approvalId, approval.state)
		},
		slackBotToken: botToken,
	})
	try {
		const out = await raceWithAbortSignal(resume, resumeAbortSignal)
		if (out.status === "suspended") {
			if (
				turnControl &&
				!markThreadTurnWaitingForApproval(agent, turnControl)
			) {
				return
			}
			if (decision.approved) {
				markApprovalTerminal(agent, approval.approvalId, "executed")
			}
			const now = Date.now()
			const nextPending: PendingApproval = {
				approvalId: out.approval.approvalId,
				turnId: `${approval.turnId}:${out.approval.approvalId}`,
				orgId: approval.orgId,
				teamId: approval.teamId,
				channel: approval.channel,
				threadTs: approval.threadTs,
				askerUser: approval.askerUser,
				toolName: out.approval.toolName,
				slug: out.approval.slug,
				toolInput: out.approval.input,
				summary: out.approval.summary,
				state: out.state,
				status: "pending",
				createdAt: now,
				expiresAt: now + APPROVAL_EXPIRY_MS,
			}
			insertPendingApproval(agent, nextPending)
			if (!turnStillCurrent(agent, turnControl)) return
			await stream.finalize("", false)
			if (!turnStillCurrent(agent, turnControl)) return
			const cardTs = await postSlackApprovalCard(
				botToken,
				approval.channel,
				approval.threadTs,
				{
					approvalId: nextPending.approvalId,
					summary: nextPending.summary,
					toolName: nextPending.toolName,
					slug: nextPending.slug,
					iconUrl: await resolveApprovalIconUrl({
						env: brainAgent(agent).env,
						orgId: nextPending.orgId,
						actor: nextPending.state.actor,
						slug: nextPending.slug,
						toolName: nextPending.toolName,
					}),
					askerUser: nextPending.askerUser,
					expiresAt: nextPending.expiresAt,
				},
			)
			if (!cardTs) {
				// No buttons reached Slack — don't leave a pending row the asker
				// can never act on; mark it failed and say so in the thread.
				markApprovalTerminal(agent, nextPending.approvalId, "error")
				await stream.postFallback(
					"I ran the approved action, but couldn't post the Approve/Deny buttons for the next step. Mind asking again?",
				)
				markThreadTurnCompleted(agent, turnControl)
				return
			}
			setApprovalCardTs(agent, nextPending.approvalId, cardTs)
			await armApprovalExpiry(agent, nextPending)
			markBotThread(agent, approval.teamId, approval.channel, approval.threadTs)
			return
		}
		turnResult = out
		reply = out.reply
		if (decision.approved) {
			markApprovalTerminal(agent, approval.approvalId, "executed")
		}
	} catch (err) {
		retainAbandoned(resume, (promise) => brainAgent(agent).waitUntil(promise))
		if (turnWasInterrupted(agent, turnControl)) {
			return
		}
		markApprovalTerminal(agent, approval.approvalId, "error")
		if (resumeDeadline.aborted) {
			console.warn("[company-brain] approval resume hit wall-clock deadline")
			// The abandoned write may still land, so never invite a blind retry.
			reply =
				"I lost track of that approved action before it finished, so I can't confirm whether it went through. Please check before running it again."
		} else {
			failed = true
			console.error("[company-brain] approval resume failed:", err)
			reply = "Sorry, I hit an error while resuming that approved action."
		}
	}

	if (turnStillCurrent(agent, turnControl)) {
		const finalizeResult = await stream.finalize(reply, failed)
		if (reply.trim() && !finalizeResult.streamed) {
			await stream.postFallback(reply)
		}
	}
	try {
		const memoryScope = approval.state.memoryScope
		const memoryWriterUserId = slackMemoryWriterUserId(
			memoryScope,
			ws.installedByUserId ?? approval.state.actor.userId,
		)
		const memory = turnResult?.status === "completed" ? turnResult.memory : null
		if (
			memoryDocsFromWriteback(memory).length &&
			memoryWriterUserId &&
			turnStillCurrent(agent, turnControl)
		) {
			const { writeMemories } = await import("../memory")
			await writeMemories(
				brainAgent(agent).env,
				undefined,
				org,
				memoryWriterUserId,
				memory,
				memoryScope,
				agent,
				{ allowedPersonSlackUserIds: approval.state.memoryTagSlackUserIds },
			)
		}
	} finally {
		markThreadTurnCompleted(agent, turnControl)
	}

	if (!failed && !approval.state.skipPostTurnReflect) {
		await armPostTurnReflect(agent, {
			teamId: approval.teamId,
			channel: approval.channel,
			threadTs: approval.threadTs,
			askerSlackUserId: approval.askerUser,
		}).catch((err) => {
			console.warn("[company-brain] post-turn-reflect arm failed:", err)
		})
	}
}

export type RunSlackTurnOptions = {
	/** Skip participation gates and triage; reply in thread on trigger message. */
	forceFullTurn?: boolean
	forceThreadTs?: string
	obsSource?: BrainObservabilityInput["source"]
	/** Reuse an existing PostHog trace (e.g. channel chime → full turn). */
	traceId?: string
	/** Synthetic turns do not have a real Slack message ts to react to. */
	skipReactions?: boolean
	/** Chime escalations only — connect retries leave unset so reflect still re-arms. */
	skipPostTurnReflect?: boolean
	triageResult?: "answer" | "investigate"
	agentMainEffort?: Effort
	fiber?: SlackTurnFiberControl
	/** Internal passive escalation. Never set for an explicit mention or DM. */
	passiveInvestigation?: {
		reason: string
		priority?: "urgent" | "normal"
		obs: TriageObservabilityContext
		identity?: SlackEventIdentity
		claim?: PassiveInvestigationClaim
		/** False when Company Brain is already an active participant in the thread. */
		budgetFinding?: boolean
	}
}

export async function finalizeInterruptedSlackTurn(
	agent: CompanyBrainAgent,
	snapshot: SlackTurnFiberSnapshot,
): Promise<void> {
	if (!snapshot.threadKey || !snapshot.turnId || !snapshot.turnRevision) return
	const recoveredTurn: TurnControlSnapshot = {
		threadKey: snapshot.threadKey,
		turnId: snapshot.turnId,
		revision: snapshot.turnRevision,
	}
	if (!completeInterruptedThreadTurn(agent, recoveredTurn)) return
	const workspace = await getWorkspaceByTeamId(
		brainAgent(agent).env,
		snapshot.message.teamId,
	)
	if (!workspace || workspace.orgId !== agent.name) return
	const botToken = await decryptToken(
		workspace.botTokenEnc,
		brainAgent(agent).env.ENCRYPTION_SECRET,
	)
	const replyTarget = await resolveSlackReplyTarget(
		botToken,
		snapshot.message.event,
	)
	if (!replyTarget) return
	await clearAssistantThreadStatus(
		botToken,
		replyTarget.channel,
		replyTarget.threadTs,
	)
	const terminalReply = snapshot.terminalProposal
		? await createSlackReplyReferenceResolver({
				env: brainAgent(agent).env,
				teamId: snapshot.message.teamId,
				botToken,
			})(snapshot.terminalProposal.reply)
		: "I couldn't finish this after retrying. Reply here to start fresh."
	if (snapshot.progressMessageTs) {
		const updated = await updateSlackMessage(
			botToken,
			replyTarget.channel,
			snapshot.progressMessageTs,
			terminalReply,
			[],
		)
		if (updated) return
	}
	await postSlackMessage(
		botToken,
		replyTarget.channel,
		terminalReply,
		replyTarget.threadTs,
	)
}

export type SlackConnectCompletion = {
	teamId: string
	channel: string
	threadTs: string
	slackUserId: string
	slug: string
	originalQuestion?: string
	/** The private connect card already reflects success. */
	suppressConfirmation?: boolean
}

function syntheticSlackTs(): string {
	const now = Date.now()
	const microseconds = (now % 1000) * 1000
	return `${Math.floor(now / 1000)}.${String(microseconds).padStart(6, "0")}`
}

function scheduleTurnSuppressionTelemetry(
	agent: CompanyBrainAgent,
	obs: TriageObservabilityContext,
	args: {
		reason: string
		priority?: string
		decision: string
		fallbackUsed?: boolean
	},
): void {
	agent.waitUntil(
		(async () => {
			try {
				const { captureBrainProactivitySuppression } = await import(
					"../observability"
				)
				await captureBrainProactivitySuppression({ ...obs, ...args })
			} catch {
				console.warn(
					`[company-brain] proactivity suppression telemetry failed trace=${obs.traceId}`,
				)
			}
		})(),
	)
}

export async function runSlackConnectComplete(
	agent: CompanyBrainAgent,
	completion: SlackConnectCompletion,
): Promise<void> {
	const ws = await getWorkspaceByTeamId(
		brainAgent(agent).env,
		completion.teamId,
	)
	if (!ws) return
	if (ws.orgId !== agent.name) {
		console.error(
			`[company-brain] connect continuation dropped: workspace rebound team=${completion.teamId} continuationOrg=${agent.name} currentOrg=${ws.orgId}`,
		)
		return
	}
	const botToken = await decryptToken(
		ws.botTokenEnc,
		brainAgent(agent).env.ENCRYPTION_SECRET,
	)
	const { userId: authBotUserId, botId: slackBotId } =
		await getSlackBotIdentity(botToken)
	const botUserId =
		(await ensureWorkspaceBotUserId(
			brainAgent(agent).env,
			ws,
			botToken,
			authBotUserId,
		)) ??
		authBotUserId ??
		ws.botUserId ??
		null
	const appName = mcpAppDisplayName(completion.slug)
	const storedOriginalQuestion = completion.originalQuestion?.trim()
	let originalQuestion =
		storedOriginalQuestion && !isConnectOnlyRequest(storedOriginalQuestion)
			? storedOriginalQuestion
			: undefined
	if (!originalQuestion && !storedOriginalQuestion) {
		const thread = await getSlackThread(
			botToken,
			completion.channel,
			completion.threadTs,
		)
		originalQuestion = originalRequestForConnectAcceptance(
			thread,
			"connect it",
			undefined,
			completion.slackUserId,
			botUserId,
			slackBotId ?? null,
		)
	}
	if (!originalQuestion) {
		if (!completion.suppressConfirmation) {
			await postSlackMessage(
				botToken,
				completion.channel,
				`${appName} connected.`,
				completion.threadTs,
			)
		}
		return
	}
	const continuationClaim = claimConnectContinuation(agent, {
		teamId: completion.teamId,
		channel: completion.channel,
		threadTs: completion.threadTs,
		slackUserId: completion.slackUserId,
		originalQuestion,
	})
	if (!continuationClaim) {
		if (!completion.suppressConfirmation) {
			await postSlackMessage(
				botToken,
				completion.channel,
				`${appName} connected.`,
				completion.threadTs,
			)
		}
		return
	}
	if (!completion.suppressConfirmation) {
		await postSlackMessage(
			botToken,
			completion.channel,
			`${appName} connected. Continuing with the original request now.`,
			completion.threadTs,
		)
	}
	let completed = false
	try {
		await runSlackTurn(
			agent,
			{
				teamId: completion.teamId,
				event: {
					type: "message",
					user: completion.slackUserId,
					channel: completion.channel,
					text: originalQuestion,
					ts: syntheticSlackTs(),
					thread_ts: completion.threadTs,
				},
			},
			{
				forceFullTurn: true,
				forceThreadTs: completion.threadTs,
				obsSource: "slack_connect_retry",
				skipReactions: true,
			},
		)
		completed = true
	} finally {
		if (!completed) releaseConnectContinuation(agent, continuationClaim)
	}
}

// Debug-emoji reaction on a bot message → ephemeral PostHog trace link, visible
// only to the reactor. Replaces the old per-message "Debug id" context block.
export async function runSlackDebugReaction(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
): Promise<void> {
	const ev = msg.event
	const channel = ev.item?.channel
	const messageTs = ev.item?.ts
	if (!channel || !messageTs || !ev.user) return

	const ws = await getWorkspaceByTeamId(brainAgent(agent).env, msg.teamId)
	if (!ws) return
	if (ws.orgId !== agent.name) {
		console.error(
			`[company-brain] debug reaction dropped: workspace rebound team=${msg.teamId} eventOrg=${agent.name} currentOrg=${ws.orgId}`,
		)
		return
	}
	const botToken = await decryptToken(
		ws.botTokenEnc,
		brainAgent(agent).env.ENCRYPTION_SECRET,
	)
	const reactorLookup = await lookupSlackUserInfo(botToken, ev.user)
	if (!reactorLookup.ok) {
		console.warn(
			`[company-brain] debug reaction verification failed org=${ws.orgId} slackUser=${ev.user} reason=${reactorLookup.reason} error=${reactorLookup.error ?? "-"}`,
		)
		return
	}
	const reactorInfo = reactorLookup.user
	const reactorResolution = await getOrgActorBySlackIdentity(
		brainAgent(agent).env,
		{
			orgId: ws.orgId,
			teamId: msg.teamId,
			slackUserId: ev.user,
			email: reactorInfo.email,
		},
	)
	const reactorActor = reactorResolution.actor
	if (!reactorActor) {
		console.warn(
			`[company-brain] debug reaction denied for non-member org=${ws.orgId} slackUser=${ev.user} lookup=${reactorResolution.lookup}`,
		)
		return
	}

	const trace = lookupMessageTraceRecords(agent, channel, [messageTs]).get(
		messageTs,
	)
	// Only respond when this message has a recorded trace (i.e. it's one of our
	// bot replies); silent otherwise so reacting to human messages is a no-op.
	if (!trace) {
		console.info(
			`[company-brain] debug reaction ignored channel=${channel} ts=${messageTs} reason=trace_not_found`,
		)
		return
	}
	const { traceId, threadTs } = trace
	const text = `Debug id: <${BRAIN_TRACE_POSTHOG_BASE}/${traceId}|${traceId}>`
	const delivery = await deliverSlackDebugTrace({
		botToken,
		channel,
		reactorUser: ev.user,
		text,
		threadTs,
	})
	const detail = `[company-brain] debug-reaction channel=${channel} ts=${messageTs} parent=${threadTs ?? "legacy-root"} trace=${traceId} delivery=${delivery}`
	if (delivery === "failed") console.warn(detail)
	else console.log(detail)
}

export async function runSlackMuteReaction(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
): Promise<void> {
	const ev = msg.event
	const channel = ev.item?.channel
	const messageTs = ev.item?.ts
	if (!channel || !messageTs || !ev.user) return

	const ws = await getWorkspaceByTeamId(brainAgent(agent).env, msg.teamId)
	if (!ws) return
	if (ws.orgId !== agent.name) {
		console.error(
			`[company-brain] mute reaction dropped: workspace rebound team=${msg.teamId} eventOrg=${agent.name} currentOrg=${ws.orgId}`,
		)
		return
	}
	if (ws.botUserId && ev.user === ws.botUserId) return

	const trace = lookupMessageTraceRecords(agent, channel, [messageTs]).get(
		messageTs,
	)
	if (!trace?.threadTs) {
		console.info(
			`[company-brain] mute reaction ignored channel=${channel} ts=${messageTs} reason=trace_not_found`,
		)
		return
	}
	const threadTs = trace.threadTs

	const botToken = await decryptToken(
		ws.botTokenEnc,
		brainAgent(agent).env.ENCRYPTION_SECRET,
	)
	const reactorLookup = await lookupSlackUserInfo(botToken, ev.user)
	if (!reactorLookup.ok) {
		console.warn(
			`[company-brain] mute reaction verification failed org=${ws.orgId} slackUser=${ev.user} reason=${reactorLookup.reason}`,
		)
		return
	}
	const reactorActor = (
		await getOrgActorBySlackIdentity(brainAgent(agent).env, {
			orgId: ws.orgId,
			teamId: msg.teamId,
			slackUserId: ev.user,
			email: reactorLookup.user.email,
		})
	).actor
	if (!reactorActor) {
		console.warn(
			`[company-brain] mute reaction denied for non-member org=${ws.orgId} slackUser=${ev.user}`,
		)
		return
	}

	if (ev.type === "reaction_added") {
		setThreadMuted(agent, msg.teamId, channel, threadTs, ev.user)
		const owner =
			getThreadMutedBy(agent, msg.teamId, channel, threadTs) ?? ev.user
		console.log(
			`[company-brain] thread muted org=${ws.orgId} channel=${channel} thread=${threadTs} by=${ev.user} owner=${owner}`,
		)
		const edited = await updateMuteFooter(
			botToken,
			channel,
			threadTs,
			messageTs,
			mutedFooter(owner),
		)
		if (!edited) {
			await postSlackEphemeral(
				botToken,
				channel,
				ev.user,
				"Got it — I'll stay out of this thread. Mention me if you need me; remove the :black_square_for_stop: to undo.",
				threadTs,
			)
		}
		return
	}
	const mutedBy = getThreadMutedBy(agent, msg.teamId, channel, threadTs)
	if (!mutedBy) return
	if (mutedBy !== ev.user) {
		console.log(
			`[company-brain] unmute ignored: not the muter org=${ws.orgId} thread=${threadTs} muter=${mutedBy} remover=${ev.user}`,
		)
		await postSlackEphemeral(
			botToken,
			channel,
			ev.user,
			`Only <@${mutedBy}>'s :black_square_for_stop: controls this mute — mention me if you need me now.`,
			threadTs,
		)
		return
	}
	clearThreadMuted(agent, msg.teamId, channel, threadTs)
	console.log(
		`[company-brain] thread unmuted org=${ws.orgId} channel=${channel} thread=${threadTs} by=${ev.user}`,
	)
	const edited = await updateMuteFooter(
		botToken,
		channel,
		threadTs,
		messageTs,
		MUTE_OFFER_FOOTER,
	)
	if (!edited) {
		await postSlackEphemeral(
			botToken,
			channel,
			ev.user,
			"Okay — I can chime in here again.",
			threadTs,
		)
	}
}

async function warmLocalThreadContext(
	agent: CompanyBrainAgent,
	args: {
		teamId: string
		botToken: string
		channel: string
		threadTs: string
		currentMessageTs: string
	},
): Promise<{
	historyComplete: boolean
	messages?: SlackThreadMessage[]
}> {
	if (
		!claimLocalContextWarmup(agent, {
			teamId: args.teamId,
			channel: args.channel,
			threadTs: args.threadTs,
			currentMessageTs: args.currentMessageTs,
		})
	) {
		return {
			historyComplete: isLocalContextHistoryComplete(agent, {
				teamId: args.teamId,
				channel: args.channel,
				threadTs: args.threadTs,
			}),
		}
	}
	try {
		const read = await getSlackThreadHistory(
			args.botToken,
			args.channel,
			args.threadTs,
			{
				pageLimit: 200,
				maxMessages: THREAD_CONTEXT_MAX_MESSAGES,
				maxPages: THREAD_CONTEXT_MAX_PAGES,
			},
		)
		const snapshot = mergeSlackThreadHistoryIntoLocalContext(agent, {
			teamId: args.teamId,
			channel: args.channel,
			threadTs: args.threadTs,
			beforeTs: args.currentMessageTs,
			messages: read.messages,
			limit: THREAD_TRIAGE_CONTEXT_LIMIT,
		})
		const promptHistoryComplete = read.complete && !snapshot.truncated
		const retainedHistoryComplete =
			promptHistoryComplete && snapshot.retainedComplete
		if (read.complete || read.messages.length > 0) {
			markLocalContextWarm(agent, {
				teamId: args.teamId,
				channel: args.channel,
				threadTs: args.threadTs,
				historyComplete: retainedHistoryComplete,
			})
		}
		return {
			historyComplete: promptHistoryComplete,
			messages: snapshot.messages,
		}
	} catch (error) {
		console.warn(
			`[company-brain] local thread context warmup failed channel=${args.channel} thread=${args.threadTs} error=${error instanceof Error ? error.message : String(error)}`,
		)
		return { historyComplete: false }
	}
}

/**
 * Passive thread entry point. Mentions, DMs, name-addresses, and forced turns
 * structurally skip this function, so explicit conversation is never budgeted.
 */
async function runSlackPassiveThread(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
	args: {
		ws: NonNullable<Awaited<ReturnType<typeof getWorkspaceByTeamId>>>
		identity: SlackEventIdentity
		question: string
	},
): Promise<void> {
	const { ws, identity, question } = args
	const ev = msg.event
	const triageClaim = claimStoredEventForTriage(agent, identity)
	if (!triageClaim) return
	msg.triageClaimId = triageClaim.id
	if (!ev.channel || !ev.thread_ts || !ev.user || !ev.ts) {
		markStoredEventFiltered(
			agent,
			identity,
			"Passive thread triage requires a human-authored thread message.",
			triageClaim.id,
		)
		return
	}
	if (
		!isSlackContentMessageSubtype(ev.subtype) ||
		!question.trim() ||
		isEmojiOnlySlackText(question)
	) {
		markStoredEventFiltered(
			agent,
			identity,
			"The Slack thread event is structural noise or has no text.",
			triageClaim.id,
		)
		return
	}

	const botToken = await decryptToken(
		ws.botTokenEnc,
		brainAgent(agent).env.ENCRYPTION_SECRET,
	)
	let botUserId = ws.botUserId
	if (!botUserId) {
		const { userId } = await getSlackBotIdentity(botToken)
		botUserId = await ensureWorkspaceBotUserId(
			brainAgent(agent).env,
			ws,
			botToken,
			userId,
		)
	}
	const askerLookup = await getCachedSlackUserInfo(agent, {
		teamId: msg.teamId,
		botToken,
		userId: ev.user,
	})
	if (!askerLookup.ok) {
		markStoredEventFiltered(
			agent,
			identity,
			`Slack speaker verification failed: ${askerLookup.reason}.`,
			triageClaim.id,
		)
		return
	}
	const orgMember = (
		await getOrgActorBySlackIdentity(brainAgent(agent).env, {
			orgId: ws.orgId,
			teamId: msg.teamId,
			slackUserId: ev.user,
			email: askerLookup.user.email,
		})
	).actor
	if (!orgMember) {
		markStoredEventFiltered(
			agent,
			identity,
			"The Slack speaker is not a current member of this organization.",
			triageClaim.id,
		)
		return
	}

	const warmedContext = await warmLocalThreadContext(agent, {
		teamId: msg.teamId,
		botToken,
		channel: ev.channel,
		threadTs: ev.thread_ts,
		currentMessageTs: ev.ts,
	})
	const thread =
		warmedContext.messages ??
		loadLocalThreadContext(agent, {
			teamId: msg.teamId,
			channel: ev.channel,
			threadTs: ev.thread_ts,
			beforeTs: ev.ts,
			limit: THREAD_TRIAGE_CONTEXT_LIMIT,
		})
	const otherMentionIds = mentionedUserIds(ev.text, botUserId)
	const profileIds = triageProfileUserIds({
		currentUserId: ev.user,
		mentionedIds: otherMentionIds,
		history: thread,
		botUserId,
	})
	const profiles = await getCachedSlackUserProfiles(agent, {
		teamId: msg.teamId,
		botToken,
		userIds: profileIds,
	})
	const userNames = new Map<string, string>()
	const botUserIds = new Set<string>()
	for (const [id, profile] of profiles) {
		userNames.set(id, profile.name ?? profile.displayName ?? id)
		if (profile.isBot) botUserIds.add(id)
	}
	if (botUserId) botUserIds.add(botUserId)
	const knownBotThread = hasBotThread(
		agent,
		msg.teamId,
		ev.channel,
		ev.thread_ts,
	)
	const botInThread =
		knownBotThread ||
		Boolean(botUserId && thread.some((message) => message.user === botUserId))
	const botSpokeLast = thread.length
		? botSpokePrevious(thread, ev.ts, botUserId, null)
		: knownBotThread
	const addressedTargets: TriageAddressedTarget[] = otherMentionIds.map(
		(slackUserId) => ({
			slackUserId,
			name: userNames.get(slackUserId),
			isBot: profiles.get(slackUserId)?.isBot === true,
		}),
	)
	const threadText = buildThreadContext(
		agent,
		ev.channel,
		thread,
		botUserId,
		null,
		ev.ts,
		userNames,
		askerLookup.user.tzOffset,
		undefined,
		botUserIds,
	)
	const traceId = generateId()
	const channelInfo = await getCachedSlackChannelInfo(agent, {
		teamId: msg.teamId,
		botToken,
		channelId: ev.channel,
	})
	const traceSampling = reserveTriageTraceSample(agent, {
		orgId: ws.orgId,
		traceId,
	})
	const obs: TriageObservabilityContext = {
		orgId: ws.orgId,
		distinctId: orgMember.userId,
		traceId,
		sessionId: `${ev.channel}:${ev.thread_ts}`,
		channel: ev.channel,
		messageTs: ev.ts,
		threadTs: ev.thread_ts,
		chimeContext: "thread",
		triageTraceSampled: traceSampling.sampled,
		triageTraceSampleRate: traceSampling.sampleRate,
	}
	const triage = await triageChimeMessage(brainAgent(agent).env, {
		context: "thread",
		profile: resolveBrainTriageProfile(ws.orgMetadata),
		question,
		contextText: threadText,
		waitUntil: (promise) => agent.waitUntil(promise),
		currentSpeaker: {
			name: askerLookup.user.name ?? askerLookup.user.displayName,
			slackUserId: ev.user,
		},
		messageStamp: formatSlackTsHuman(ev.ts, askerLookup.user.tzOffset),
		historyComplete: warmedContext.historyComplete,
		addressedTargets,
		channel: channelInfo,
		threadFollowUpOverride: { botSpokePrevious: botSpokeLast },
		obs,
	})
	const finalized = recordStoredTriageDecision(agent, identity, {
		decision: triage.decision,
		claimId: triageClaim.id,
		source: triage.source,
		...("priority" in triage ? { priority: triage.priority } : {}),
		...("reason" in triage ? { reason: triage.reason } : {}),
		...(triage.decision === "ack" ? { emoji: triage.emoji } : {}),
		...(triage.decision === "answer" && triage.fallbackEmoji
			? { fallbackEmoji: triage.fallbackEmoji }
			: {}),
		traceId,
	})
	if (!finalized) {
		console.warn(
			`[company-brain] thread chime discarded stale triage result team=${identity.teamId} channel=${identity.channel} message=${identity.messageTs}`,
		)
		return
	}
	console.log(
		`[company-brain] thread chime triage=${triage.decision} source=${triage.source} priority=${"priority" in triage ? triage.priority : "-"} agentEffort=${"agentMainEffort" in triage ? (triage.agentMainEffort ?? "-") : "-"} trace=${traceId} org=${ws.orgId} channel=${ev.channel} thread=${ev.thread_ts} botInThread=${botInThread}`,
	)

	if (triage.decision === "pass") {
		recordStoredActionOutcome(agent, identity, "silent_by_judgment")
		return
	}
	if (triage.decision === "ack") {
		await enqueuePassiveReaction(agent, {
			identity,
			emoji: triage.emoji,
			kind: "ack",
			reason: triage.reason,
			obs,
		})
		return
	}
	if (triage.decision === "answer") {
		if (!botInThread) {
			const budget = reserveChimeAnswer(agent, {
				channelId: ev.channel,
				priority: triage.priority,
				lastChannelActivityAt: getPreviousHumanChannelActivityAt(
					agent,
					identity,
				),
			})
			if (!budget.allowed) {
				const fallbackUsed = canUseAnswerFallback(
					budget.suppression,
					Boolean(triage.fallbackEmoji),
					triage.priority,
				)
				recordStoredSuppression(agent, identity, {
					suppression: budget.suppression,
					fallbackUsed,
				})
				scheduleTurnSuppressionTelemetry(agent, obs, {
					reason: budget.suppression,
					priority: triage.priority,
					decision: triage.decision,
					fallbackUsed,
				})
				if (fallbackUsed && triage.fallbackEmoji) {
					await enqueuePassiveReaction(agent, {
						identity,
						emoji: triage.fallbackEmoji,
						kind: "answer_fallback",
						reason:
							"Triage explicitly supplied a semantically valid reaction fallback.",
						obs,
					})
				}
				return
			}
		}
		recordStoredActionOutcome(agent, identity, "answer_budget_reserved")
		await runSlackTurn(agent, msg, {
			forceFullTurn: true,
			forceThreadTs: ev.thread_ts,
			obsSource: "slack_chime_thread",
			traceId,
			skipPostTurnReflect: true,
			triageResult: "answer",
			agentMainEffort: triage.agentMainEffort,
		})
		recordStoredActionOutcome(agent, identity, "answer_turn_completed")
		return
	}

	const investigation = reservePassiveInvestigation(agent, {
		traceId,
		channelId: ev.channel,
		priority: triage.priority,
	})
	if (!investigation.allowed) {
		recordStoredSuppression(agent, identity, {
			suppression: investigation.suppression,
		})
		scheduleTurnSuppressionTelemetry(agent, obs, {
			reason: investigation.suppression,
			priority: triage.priority,
			decision: triage.decision,
		})
		return
	}
	try {
		await runSlackTurn(agent, msg, {
			forceFullTurn: true,
			forceThreadTs: ev.thread_ts,
			obsSource: "slack_chime_thread",
			traceId,
			skipPostTurnReflect: true,
			triageResult: "investigate",
			agentMainEffort: triage.agentMainEffort,
			passiveInvestigation: {
				reason: triage.reason,
				priority: triage.priority,
				obs,
				identity,
				claim: investigation.claim,
				budgetFinding: !botInThread,
			},
		})
		releasePassiveInvestigation(agent, investigation.claim, "silent")
	} catch (error) {
		releasePassiveInvestigation(agent, investigation.claim, "failed")
		throw error
	}
}

const CONNECT_ONLY_TOOLS = new Set([
	"connect_app",
	"post_update",
	"finish_turn",
	"save_memory",
])

// Whether the turn did nothing but hand over a Connect card, so replacing the
// model's reply cannot discard an answer. A directory search counts as a slug
// lookup only when it surfaced a single app; a wider result was the answer.
function turnOnlyConnected(trace: TurnToolTraceEntry[] | undefined): boolean {
	if (!trace?.length) return true
	return trace.every((entry) => {
		if (CONNECT_ONLY_TOOLS.has(entry.tool)) return true
		if (entry.tool !== "search_mcp_directory") return false
		try {
			const parsed = JSON.parse(entry.output ?? "") as {
				apps?: unknown[]
				totalMatches?: number
			}
			return (parsed.apps?.length ?? 0) <= 1 && (parsed.totalMatches ?? 0) <= 1
		} catch {
			return false
		}
	})
}

export async function runSlackTurn(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
	opts?: RunSlackTurnOptions,
): Promise<void> {
	const claim: TurnClaim = {}
	try {
		await runSlackTurnInner(agent, msg, claim, opts)
	} finally {
		reapUnfinishedThreadTurn(agent, claim.control)
	}
}

async function runSlackTurnInner(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
	claim: TurnClaim,
	opts?: RunSlackTurnOptions,
): Promise<void> {
	let ws =
		msg.workspace?.teamId === msg.teamId && msg.workspace.orgId === agent.name
			? msg.workspace
			: await getWorkspaceByTeamId(brainAgent(agent).env, msg.teamId)
	if (!ws) {
		console.warn(
			`[company-brain] no workspace for team ${msg.teamId}; dropping`,
		)
		return
	}
	if (ws.orgId !== agent.name) {
		console.error(
			`[company-brain] Slack turn dropped: workspace rebound team=${msg.teamId} turnOrg=${agent.name} currentOrg=${ws.orgId}`,
		)
		return
	}
	const ev = msg.event
	const storedEventIdentity = recordSlackEvent(agent, msg)
	if (ev.bot_id || ev.app_id || (ws.botUserId && ev.user === ws.botUserId)) {
		if (storedEventIdentity) {
			markStoredEventFiltered(
				agent,
				storedEventIdentity,
				"Bot-authored messages are retained as context and never triaged.",
			)
		}
		return
	}
	const isMention =
		ev.type === "app_mention" || isBotMentioned(ev.text, ws.botUserId)
	const isDM = isDirectMessage(ev)
	const isAssistantThread = isAssistantThreadMessage(ev)
	const forceFullTurn = opts?.forceFullTurn === true
	const skipReactions = opts?.skipReactions === true
	const passiveInvestigation = opts?.passiveInvestigation

	const question = cleanMention(ev.text)
	if (!question) {
		if (storedEventIdentity) {
			markStoredEventFiltered(
				agent,
				storedEventIdentity,
				"The Slack message has no triageable text.",
			)
		}
		return
	}
	if (
		storedEventIdentity &&
		(forceFullTurn ||
			isMention ||
			isDM ||
			isAssistantThread ||
			msg.addressedByName) &&
		!getStoredSlackEventAudit(agent, storedEventIdentity)?.decision
	) {
		recordStoredTriageDecision(agent, storedEventIdentity, {
			decision: "explicit",
			source: "explicit_bypass",
			reason:
				"Explicit Slack conversation bypasses unsolicited proactivity budgets.",
		})
	}
	const pendingThreadTurn =
		ev.channel && ev.thread_ts
			? getThreadTurn(
					agent,
					slackThreadTurnKey(msg.teamId, ev.channel, ev.thread_ts),
				)
			: null
	if (
		!forceFullTurn &&
		storedEventIdentity &&
		ev.thread_ts &&
		!isMention &&
		!isDM &&
		!isAssistantThread &&
		!msg.addressedByName &&
		pendingThreadTurn?.status !== "finalizing" &&
		!isSteerableThreadTurn(agent, pendingThreadTurn)
	) {
		if (
			!(await orgCanRunCompanyBrain(
				brainAgent(agent).env,
				ws.orgId,
				(promise) => agent.waitUntil(promise),
			))
		) {
			return
		}
		const proactivity = resolveChannelProactivity({
			settings: ws.brainProactivity,
			channelId: ev.channel,
			homeChannelId: getHomeChannel(agent)?.channelId,
		})
		if (proactivity === "quiet") {
			markStoredEventFiltered(
				agent,
				storedEventIdentity,
				PROACTIVITY_FILTER_REASON,
			)
			return
		}
		if (isThreadMuted(agent, msg.teamId, ev.channel ?? "", ev.thread_ts)) {
			markStoredEventFiltered(
				agent,
				storedEventIdentity,
				THREAD_MUTED_FILTER_REASON,
			)
			return
		}
		await runSlackPassiveThread(agent, msg, {
			ws,
			identity: storedEventIdentity,
			question,
		})
		return
	}

	const startedAt = Date.now()
	const org: SlackOrg = {
		id: ws.orgId,
		name: ws.orgName,
		slug: ws.orgSlug,
		metadata: ws.orgMetadata,
	}
	const entitlement = await getCompanyBrainEntitlement(
		brainAgent(agent).env,
		org.id,
		(promise) => agent.waitUntil(promise),
	)
	if (!entitlement.allowed) {
		console.log(
			`[company-brain] entitlement blocked org=${org.id} team=${msg.teamId} reason=${entitlement.reason}`,
		)
		// Mentions/DMs get a clear activate path; passive traffic just drops.
		if (isMention || isDM || isAssistantThread) {
			try {
				const botToken = await decryptToken(
					ws.botTokenEnc,
					brainAgent(agent).env.ENCRYPTION_SECRET,
				)
				if (ev.channel) {
					await postSlackMessage(
						botToken,
						ev.channel,
						companyBrainDenialMessage(
							entitlement.reason,
							brainAgent(agent).env,
							companyBrainActivateUrl(brainAgent(agent).env),
						),
						ev.thread_ts ?? ev.ts,
					)
				}
			} catch (err) {
				console.warn("[company-brain] entitlement notice failed:", err)
			}
		}
		return
	}
	const botToken = await decryptToken(
		ws.botTokenEnc,
		brainAgent(agent).env.ENCRYPTION_SECRET,
	)
	let directoryPromise: ReturnType<typeof getSlackTeamDirectory> | undefined
	const loadDirectory = () =>
		(directoryPromise ??= getSlackTeamDirectory(botToken))
	const { userId: authBotUserId, botId: slackBotId } =
		await getSlackBotIdentity(botToken)
	const botUserId =
		(await ensureWorkspaceBotUserId(
			brainAgent(agent).env,
			ws,
			botToken,
			authBotUserId,
		)) ??
		authBotUserId ??
		null
	if (botUserId) ws = { ...ws, botUserId }

	const emptyUser: SlackUserInfo = {}
	const missingAskerLookup: SlackUserInfoLookup = {
		ok: false,
		reason: "missing_user_id",
	}
	const [askerLookup, botProfile] = await Promise.all([
		ev.user
			? lookupSlackUserInfo(botToken, ev.user)
			: Promise.resolve(missingAskerLookup),
		botUserId
			? getSlackUserInfo(botToken, botUserId)
			: Promise.resolve(emptyUser),
	])
	const botIdentity = botUserId
		? buildSlackBotIdentity(botUserId, botProfile)
		: undefined
	const isNameAddressed =
		msg.addressedByName === true ||
		isBotAddressedByName(
			ev.text,
			botIdentity ? collectBotAddressAliases(botIdentity) : [],
		)

	if (
		!forceFullTurn &&
		!isMention &&
		!isDM &&
		!isAssistantThread &&
		!ev.thread_ts &&
		!isNameAddressed
	) {
		return
	}

	const forcedThreadTs = opts?.forceThreadTs ?? ev.ts
	const replyTarget = forceFullTurn
		? ev.channel && forcedThreadTs
			? { channel: ev.channel, threadTs: forcedThreadTs }
			: undefined
		: await resolveSlackReplyTarget(botToken, ev)
	if (!replyTarget) {
		console.warn(
			`[company-brain] no reply target org=${ws.orgId} event=${ev.type} channel=${ev.channel ?? "?"} user=${ev.user ?? "?"}`,
		)
		return
	}
	const { channel, threadTs } = replyTarget
	if (!askerLookup.ok) {
		console.warn(
			`[company-brain] turn verification failed org=${org.id} slackUser=${ev.user ?? "?"} reason=${askerLookup.reason} error=${askerLookup.error ?? "-"}`,
		)
		if (
			shouldPostSlackOrgMemberDenial({
				forceFullTurn,
				isMention,
				isNameAddressed,
				isDM,
				isAssistantThread,
			})
		) {
			await postSlackMessage(
				botToken,
				channel,
				formatSlackProfileLookupFailure(),
				threadTs,
			)
		}
		return
	}
	const asker = ev.user
		? { ...askerLookup.user, slackUserId: ev.user }
		: askerLookup.user
	const actorResolution = await getOrgActorBySlackIdentity(
		brainAgent(agent).env,
		{
			orgId: org.id,
			teamId: msg.teamId,
			slackUserId: ev.user ?? "",
			email: asker?.email,
		},
	)
	const orgMember = actorResolution.actor
	if (!orgMember) {
		console.warn(
			`[company-brain] turn denied for non-member org=${org.id} slackUser=${ev.user ?? "?"} lookup=${actorResolution.lookup}`,
		)
		if (
			shouldPostSlackOrgMemberDenial({
				forceFullTurn,
				isMention,
				isNameAddressed,
				isDM,
				isAssistantThread,
			})
		) {
			if (ev.user) {
				try {
					await postSlackAccountLinkPrompt(brainAgent(agent).env, {
						botToken,
						teamId: msg.teamId,
						slackUserId: ev.user,
						orgId: org.id,
						orgName: org.name,
						channel,
						threadTs,
						isDM,
						slackEmail: asker?.email,
						slackDisplayName: slackUserDisplayName(asker),
					})
				} catch (error) {
					console.warn(
						`[company-brain] account link prompt failed org=${org.id} team=${msg.teamId} slackUser=${ev.user}:`,
						error,
					)
					const denial = formatSlackOrgMemberDenial({
						personName: slackUserDisplayName(asker),
						orgName: org.name,
					})
					if (isDM) {
						await postSlackMessage(botToken, channel, denial, threadTs)
					} else {
						await postSlackEphemeral(
							botToken,
							channel,
							ev.user,
							denial,
							threadTs,
						)
					}
				}
			}
		}
		return
	}
	const telemetryDistinctId = orgMember.userId
	const traceId = opts?.traceId ?? generateId()
	const threadKey = slackThreadTurnKey(msg.teamId, channel, threadTs)
	opts?.fiber?.checkpoint({ phase: "running", threadKey })
	let activeTurn = getThreadTurn(agent, threadKey)
	if (opts?.fiber?.recoveredTurn) {
		if (
			opts.fiber.recoveredTurn.threadKey !== threadKey ||
			!supersedeInterruptedThreadTurn(agent, opts.fiber.recoveredTurn)
		) {
			console.log(
				`[company-brain] skip stale fiber recovery org=${ws.orgId} channel=${channel} thread=${threadTs}`,
			)
			return
		}
		activeTurn = getThreadTurn(agent, threadKey)
	}
	let startExpectation: ThreadTurnStartExpectation
	let effectiveQuestion = question
	let turnSteering: string | undefined
	while (true) {
		if (activeTurn?.status === "finalizing") {
			activeTurn = await waitForThreadTurnFinalization(agent, {
				threadKey,
				turnId: activeTurn.turn_id,
				revision: activeTurn.revision,
			})
			continue
		}
		startExpectation = threadTurnStartExpectation(activeTurn)
		if (!isSteerableThreadTurn(agent, activeTurn)) break

		const authorOwnsTurn = Boolean(ev.user && ev.user === activeTurn.asker_user)
		const deterministicIntent = classifyTurnSteering(question)
		if (authorOwnsTurn && deterministicIntent === "stop") {
			const interrupted = await interruptThreadTurn(
				agent,
				threadKey,
				"cancelled",
				question,
			)
			if (!interrupted.notified) {
				await postSlackMessage(
					botToken,
					channel,
					"Got it, stopping here.",
					threadTs,
				)
			}
			console.log(
				`[company-brain] stopped active turn org=${ws.orgId} channel=${channel} thread=${threadTs} turn=${activeTurn.turn_id}`,
			)
			return
		}

		const messageTs = ev.ts ?? `${Date.now()}.000000`
		const reservation = reserveTurnUpdate(agent, {
			threadKey,
			turnId: activeTurn.turn_id,
			revision: activeTurn.revision,
			messageTs,
			authorUser: ev.user ?? "unknown",
			authorName: asker?.name ?? asker?.displayName,
			instruction: question,
		})
		if (reservation === "duplicate") {
			console.log(
				`[company-brain] active-turn gate ignored duplicate follow-up org=${ws.orgId} channel=${channel} thread=${threadTs}`,
			)
			return
		}
		if (reservation === "inactive") {
			activeTurn = getThreadTurn(agent, threadKey)
			console.log(
				`[company-brain] active turn changed before gate reservation; retrying current state org=${ws.orgId} channel=${channel} thread=${threadTs}`,
			)
			continue
		}

		const currentInstructions = [
			...(activeTurn.latest_instruction ? [activeTurn.latest_instruction] : []),
			...listCurrentTurnUpdates(agent, {
				threadKey,
				turnId: activeTurn.turn_id,
				revision: activeTurn.revision,
			}).map((update) => {
				const author = update.author_name || update.author_user
				return `${author}: ${update.instruction}`
			}),
		]
		const gate = await triageActiveTurnMessage(
			brainAgent(agent).env,
			{
				activeQuestion: activeTurn.original_question,
				currentInstructions,
				message: question,
				authorName: asker?.name ?? asker?.displayName,
				authorOwnsTurn,
				obs: {
					orgId: org.id,
					distinctId: telemetryDistinctId,
					traceId,
					sessionId: `${channel}:${threadTs}`,
					channel,
					messageTs: ev.ts,
					threadTs,
					revision: activeTurn.revision,
				},
			},
			{
				waitUntil: (promise) => agent.waitUntil(promise),
			},
		)
		const latestTurn = getThreadTurn(agent, threadKey)
		if (
			!isSteerableThreadTurn(agent, latestTurn) ||
			latestTurn.turn_id !== activeTurn.turn_id ||
			latestTurn.revision !== activeTurn.revision
		) {
			discardTurnUpdateReservation(agent, {
				threadKey,
				turnId: activeTurn.turn_id,
				revision: activeTurn.revision,
				messageTs,
			})
			activeTurn = latestTurn
			console.log(
				`[company-brain] active turn changed during gate classification; retrying current state org=${ws.orgId} channel=${channel} thread=${threadTs}`,
			)
			continue
		}
		if (gate.outcome === "ignore") {
			resolveTurnUpdate(agent, {
				threadKey,
				messageTs,
				outcome: gate.outcome,
				status: "ignored",
			})
			console.log(
				`[company-brain] active-turn gate ignored follow-up org=${ws.orgId} channel=${channel} thread=${threadTs}`,
			)
			return
		}
		const gateAction = applyActiveTurnPolicy({
			outcome: gate.outcome,
			authorOwnsTurn,
			turnStatus:
				activeTurn.status === "waiting_approval"
					? "waiting_approval"
					: "running",
		})

		if (gateAction === "queue") {
			resolveTurnUpdate(agent, {
				threadKey,
				messageTs,
				outcome: gate.outcome,
				status: "pending",
			})
			console.log(
				`[company-brain] active-turn gate queued outcome=${gate.outcome} action=${gateAction} org=${ws.orgId} channel=${channel} thread=${threadTs} turn=${activeTurn.turn_id}`,
			)
			return
		}

		resolveTurnUpdate(agent, {
			threadKey,
			messageTs,
			outcome: gate.outcome,
			status: "ignored",
		})
		const interrupted = await interruptThreadTurn(
			agent,
			threadKey,
			"superseded",
			question,
		)
		if (!interrupted.row) {
			console.log(
				`[company-brain] skip revised turn start after missing active row org=${ws.orgId} channel=${channel} thread=${threadTs}`,
			)
			return
		}
		startExpectation = {
			turnId: interrupted.row.turn_id,
			revision: interrupted.row.revision,
			status: "superseded",
		}
		effectiveQuestion = interrupted.row.original_question.trim() || question
		turnSteering = question
		console.log(
			`[company-brain] superseded active turn org=${ws.orgId} channel=${channel} thread=${threadTs} turn=${activeTurn.turn_id}`,
		)
		break
	}

	const threadRootTs =
		ev.thread_ts ??
		(forceFullTurn && opts?.forceThreadTs ? opts.forceThreadTs : ev.ts)
	const threadRead = threadRootTs
		? await getSlackThreadHistory(botToken, channel, threadRootTs, {
				pageLimit: THREAD_CONTEXT_PAGE_SIZE,
				maxMessages: THREAD_CONTEXT_MAX_MESSAGES,
				maxPages: THREAD_CONTEXT_MAX_PAGES,
			})
		: { messages: [], complete: true as const }
	const thread = threadRead.messages
	let connectContinuationClaim: ConnectContinuationClaim | undefined
	const connectOriginalQuestion = originalRequestForConnectAcceptance(
		thread,
		effectiveQuestion,
		ev.ts,
		ev.user,
		ws.botUserId,
		slackBotId ?? null,
	)
	if (connectOriginalQuestion) {
		connectContinuationClaim = claimConnectContinuation(agent, {
			teamId: msg.teamId,
			channel,
			threadTs,
			slackUserId: ev.user ?? "",
			originalQuestion: connectOriginalQuestion,
		})
		if (!connectContinuationClaim) {
			await postSlackMessage(
				botToken,
				channel,
				"I already continued that request after the connection completed.",
				threadTs,
			)
			return
		}
		console.log(
			`[company-brain] connect follow-up using prior task org=${ws.orgId} channel=${channel} thread=${threadTs}`,
		)
		effectiveQuestion = connectOriginalQuestion
	}
	const knownBotThread = hasBotThread(agent, msg.teamId, channel, threadTs)
	const botInThread =
		knownBotThread ||
		thread.some((m) =>
			isOurSlackBotMessage(m, ws.botUserId, slackBotId ?? null),
		)
	const inChannelThread = Boolean(ev.thread_ts)
	if (
		!forceFullTurn &&
		!turnSteering &&
		!isMention &&
		!isNameAddressed &&
		!isDM &&
		!isAssistantThread &&
		!inChannelThread
	) {
		console.log(
			`[company-brain] skip thread reply org=${ws.orgId} channel=${channel} thread=${threadTs} botInThread=${botInThread} isMention=${isMention} nameAddressed=${isNameAddressed}`,
		)
		return
	}

	const messageTs = ev.ts ?? ""
	const canReactToMessage = !skipReactions && Boolean(messageTs)
	let ackReactionPromise: Promise<string | null> | null = null
	const ensureAckReaction = async (): Promise<string | null> => {
		if (!canReactToMessage) return null
		if (ackReactionPromise) return await ackReactionPromise
		ackReactionPromise = (async () => {
			if (
				await addSlackReaction(
					botToken,
					channel,
					messageTs,
					SLACK_ACK_REACTION,
					{
						quietErrors: ["invalid_name"],
					},
				)
			) {
				return SLACK_ACK_REACTION
			}
			return (await addSlackReaction(
				botToken,
				channel,
				messageTs,
				SLACK_ACK_FALLBACK_REACTION,
			))
				? SLACK_ACK_FALLBACK_REACTION
				: null
		})()
		return await ackReactionPromise
	}
	const addAckReaction = async (): Promise<void> => {
		await ensureAckReaction()
	}
	const removeAckReaction = async (): Promise<void> => {
		const reactionName = ackReactionPromise ? await ackReactionPromise : null
		if (!reactionName) return
		await removeSlackReaction(botToken, channel, messageTs, reactionName)
	}
	const finishAckReaction = async (current: boolean): Promise<void> => {
		if (!canReactToMessage) return
		const reactionName = ackReactionPromise ? await ackReactionPromise : null
		if (!current) {
			await removeAckReaction()
			return
		}
		if (reactionName) {
			await swapSlackReaction(
				botToken,
				channel,
				messageTs,
				reactionName,
				SLACK_COMPLETED_REPLY_REACTION,
			)
			return
		}
		await addSlackReaction(
			botToken,
			channel,
			messageTs,
			SLACK_COMPLETED_REPLY_REACTION,
		)
	}
	const brainObs: BrainObservabilityInput = {
		traceId,
		distinctId: telemetryDistinctId,
		sessionId: `${channel}:${threadTs}`,
		channel,
		messageTs: messageTs || undefined,
		threadTs,
		source: opts?.obsSource ?? "slack_turn",
		triageResult: opts?.triageResult,
	}

	console.log(
		`[company-brain] turn start trace=${traceId} org=${ws.orgId} channel=${channel} thread=${threadTs} message=${messageTs || "-"} user=${ev.user ?? "?"} q="${effectiveQuestion.slice(0, 60)}" steering=${turnSteering ? "yes" : "no"}`,
	)

	if (!passiveInvestigation) {
		await cancelPostTurnReflect(agent, msg.teamId, channel, threadTs)
	}

	if (!passiveInvestigation) void addAckReaction()

	const proactiveTurn =
		Boolean(passiveInvestigation) ||
		opts?.obsSource === "slack_chime_thread" ||
		opts?.obsSource === "slack_chime_channel"
	const muteOffer = proactiveTurn && !botInThread
	const muteOfferTs = new Set<string>()
	const offerMuteOnMessage = (ts: string | null | undefined): void => {
		if (!muteOffer || !ts || muteOfferTs.has(ts)) return
		muteOfferTs.add(ts)
		if (traceId) recordMessageTrace(agent, channel, ts, traceId, threadTs)
		agent.waitUntil(
			addSlackReaction(botToken, channel, ts, BRAIN_MUTE_REACTION),
		)
	}

	const stream = createSlackStreamSession({
		botToken,
		channel,
		threadTs,
		recipientUserId: ev.user,
		teamId: msg.teamId,
		orgId: ws.orgId,
		publicProgress: true,
		existingPublicProgressTs: opts?.fiber?.progressMessageTs,
		clearAssistantStatusOnProgress: !passiveInvestigation,
		...(muteOffer
			? {
					contextFooter: () => {
						const mutedBy = getThreadMutedBy(
							agent,
							msg.teamId,
							channel,
							threadTs,
						)
						return mutedBy ? mutedFooter(mutedBy) : MUTE_OFFER_FOOTER
					},
				}
			: {}),
		onDeliveryCheckpoint: (update) => {
			offerMuteOnMessage(update.progressMessageTs)
			offerMuteOnMessage(update.replyMessageTs)
			opts?.fiber?.checkpoint({
				...update,
				...(update.replyMessageTs
					? { phase: "answered" as const }
					: update.progressMessageTs
						? { phase: "progress" as const }
						: {}),
			})
		},
		prepareReply: createSlackReplyReferenceResolver({
			env: brainAgent(agent).env,
			teamId: msg.teamId,
			botToken,
		}),
	})
	if (opts?.fiber && opts.fiber.attempt > 0 && !passiveInvestigation) {
		await stream.progress.card(
			`fiber-recovery-${opts.fiber.attempt}`,
			"Trying once more",
			"in_progress",
		)
	}
	if (!passiveInvestigation && (!opts?.fiber || opts.fiber.attempt === 0)) {
		void setAssistantThreadStatus(botToken, channel, threadTs, "Dreaming", [
			"Dreaming",
		])
	}

	const directory = await loadDirectory()
	const groupScanTexts = [...thread.map((m) => m.text ?? ""), ev.text ?? ""]
	const userGroups = groupScanTexts.some((t) => /<!subteam\^/.test(t))
		? await getSlackUserGroups(botToken)
		: []
	const groupsById = new Map(userGroups.map((g) => [g.id, g]))
	const groupHandles = new Map<string, string>()
	for (const g of userGroups) groupHandles.set(g.id, g.handle)
	const actor: TurnActor = {
		orgId: org.id,
		userId: orgMember.userId,
		isAdmin: orgMember.isAdmin,
		personalConnectionsOnly: true,
		readOnly: Boolean(passiveInvestigation),
		memberLookup: "found",
	}
	const conversationInfo = !isDM
		? await getCachedSlackConversationInfo(
				brainAgent(agent).env,
				msg.teamId,
				botToken,
				channel,
			)
		: undefined
	const memoryScope = slackMemoryScopeForTurn({
		isDM,
		channel,
		channelType: ev.channel_type,
		userId: orgMember.userId,
		slackUserId: ev.user,
		...(conversationInfo ? { conversationInfo } : {}),
	})
	const privateChannelName = conversationInfo?.name?.trim()

	const seenAt = Date.now()
	let interaction: ReturnType<typeof computeInteractionContext> | undefined
	if (ev.user) {
		try {
			interaction = computeInteractionContext({
				firstName: asker?.name?.split(/\s+/)[0],
				lastSeen: lastSeen(agent, ev.user),
				now: seenAt,
				botInThread,
				timezone: asker?.timezone,
				tzOffsetSeconds: asker?.tzOffset,
			})
			if (!passiveInvestigation) markSeen(agent, ev.user, seenAt)
		} catch (err) {
			console.warn("[company-brain] interaction signal failed:", err)
		}
	}

	let reply = ""
	let memory: MemoryWriteback = null
	let failed = false
	let paused = false
	let connectOnlySilence = false
	let passiveTerminalReason: string | undefined
	const userNames = new Map<string, string>()
	const botUserIds = new Set<string>()
	for (const member of directory) {
		if (member.id) userNames.set(member.id, member.name)
		if (member.id && member.isBot) botUserIds.add(member.id)
	}
	const unknownIds = new Set<string>()
	for (const m of thread) {
		if (m.user && m.user !== ws.botUserId && !userNames.has(m.user)) {
			unknownIds.add(m.user)
		}
	}
	for (const t of groupScanTexts) {
		for (const id of mentionedUserIds(t, ws.botUserId)) {
			if (!userNames.has(id)) unknownIds.add(id)
		}
	}
	if (unknownIds.size) {
		const ids = [...unknownIds].slice(0, 25)
		const infos = await Promise.all(
			ids.map((id) => getSlackUserInfo(botToken, id).catch(() => undefined)),
		)
		infos.forEach((info, i) => {
			const id = ids[i]
			const name = info?.name ?? info?.displayName
			if (id && name) userNames.set(id, name)
		})
	}
	const displayQuestion =
		turnSteering || connectContinuationClaim
			? effectiveQuestion
			: formatChannelMessageText(ev.text, userNames, groupHandles)
	const humanParticipants = new Set(
		thread
			.filter(
				(message) =>
					message.user &&
					!message.bot_id &&
					!message.app_id &&
					message.subtype !== "bot_message" &&
					!botUserIds.has(message.user) &&
					message.user !== ws.botUserId,
			)
			.map((message) => message.user as string),
	)
	const threadParticipants =
		humanParticipants.size > 1
			? formatThreadParticipants(
					thread,
					userNames,
					directory,
					asker,
					ws.botUserId,
				)
			: undefined
	const workspaceGroups = formatWorkspaceGroups(
		groupScanTexts,
		groupsById,
		userNames,
	)
	const threadText = buildThreadContext(
		agent,
		channel,
		thread,
		ws.botUserId,
		slackBotId,
		ev.ts,
		userNames,
		asker?.tzOffset,
		groupHandles,
	)
	const conversation = buildThreadConversation({
		messages: thread,
		question: displayQuestion,
		historyComplete: threadRead.complete,
		botUserId: ws.botUserId,
		slackBotId,
		excludeTs: ev.ts,
		userNames,
		tzOffsetSeconds: asker?.tzOffset,
		groupHandles,
		botUserIds,
	})
	const conversationMessages = conversation.messages
	const lazyThreadHistory =
		conversation.omittedMessages > 0 || !threadRead.complete
			? {
					...threadRead,
					botUserId: ws.botUserId,
					slackBotId,
					excludeTs: ev.ts,
					botUserIds: [...botUserIds],
				}
			: undefined
	const slackLookup: SlackLookupContext = {
		botToken,
		channel,
		threadTs,
		teamId: msg.teamId,
		tzOffsetSeconds: asker?.tzOffset,
		userNames,
		memoryScope,
	}
	// Keep this org's brain-tag config current (throttled). Tagged memories are
	// discovered lazily by the main agent instead of being preloaded by heuristics.
	const mentionedSlackIds = mentionedUserIds(ev.text, ws.botUserId)
	const memoryTagSlackUserIds = trustedSlackUserIdsForMemoryTags(
		ev,
		thread,
		ws.botUserId ?? undefined,
	)
	const [, attachmentParts] = await Promise.all([
		passiveInvestigation
			? Promise.resolve(null)
			: maybeSyncBrainProfileConfig(agent, {
					orgId: org.id,
					orgName: org.name,
					domain: (org.metadata as { domain?: string } | null)?.domain ?? null,
					installerUserId: ws.installedByUserId,
					asker: orgMember?.userId
						? { userId: orgMember.userId, name: asker?.name }
						: null,
					privateChannel:
						memoryScope.kind === "private_channel"
							? {
									channelId: memoryScope.channelId,
									...(privateChannelName
										? { channelName: privateChannelName }
										: {}),
								}
							: null,
				}).catch(() => null),
		loadThreadAttachmentParts(
			botToken,
			collectTurnFiles(thread, {
				ts: ev.ts,
				user: ev.user,
				text: ev.text,
				files: ev.files,
			}),
		),
	])
	const turnControl = beginThreadTurn(agent, {
		threadKey,
		askerUser: ev.user ?? "",
		originalQuestion: effectiveQuestion,
		latestInstruction: turnSteering,
		expected: startExpectation,
	})
	if (!turnControl) {
		console.log(
			`[company-brain] skip stale turn start org=${ws.orgId} channel=${channel} thread=${threadTs}`,
		)
		if (passiveInvestigation) {
			if (passiveInvestigation.claim) {
				releasePassiveInvestigation(agent, passiveInvestigation.claim, "silent")
			}
			scheduleTriageOutcome(agent, passiveInvestigation.obs, {
				decision: "investigate",
				reason: passiveInvestigation.reason,
				outcome: "silent",
				terminalReason: "stale_turn",
			})
		} else {
			await clearAssistantThreadStatus(botToken, channel, threadTs)
			await removeAckReaction()
		}
		return
	}
	claim.control = turnControl
	opts?.fiber?.checkpoint({
		phase: "running",
		threadKey: turnControl.threadKey,
		turnId: turnControl.turnId,
		turnRevision: turnControl.revision,
	})
	if (!passiveInvestigation) {
		attachTurnCancelNotifier(agent, turnControl, async (status) => {
			await stream.discard(
				status === "cancelled" ? "Got it, stopping here." : undefined,
			)
		})
	}
	const turnControlSignal = opts?.fiber
		? AbortSignal.any([turnControl.signal, opts.fiber.signal])
		: turnControl.signal
	const { deadline: turnDeadline, signal: turnAbortSignal } =
		turnDeadlineSignal(turnControlSignal)
	const compute = computeTurn({
		agent,
		org,
		userId: orgMember.userId,
		actor,
		question: displayQuestion,
		threadText,
		conversationMessages,
		threadHistory: lazyThreadHistory,
		threadParticipants,
		workspaceGroups,
		attachmentParts,
		loc: `channel=${channel} ts=${ev.ts ?? "?"}`,
		asker,
		botIdentity,
		directory,
		progress: passiveInvestigation
			? undefined
			: fencedProgress(agent, turnControl, stream.progress),
		interaction,
		slackLookup,
		mentionedSlackUserIds: mentionedSlackIds,
		memoryTagSlackUserIds,
		agentMainEffort: opts?.agentMainEffort,
		obs: brainObs,
		options: {
			abortSignal: turnAbortSignal,
			turnControl,
			turnSteering,
			onTerminalProposal: opts?.fiber
				? (proposal) => opts.fiber?.checkpoint({ terminalProposal: proposal })
				: undefined,
			passiveInvestigation: passiveInvestigation
				? { reason: passiveInvestigation.reason }
				: undefined,
		},
	})
	try {
		const out = await raceWithAbortSignal(compute, turnAbortSignal)
		if (out.status === "suspended") {
			if (passiveInvestigation) {
				passiveTerminalReason = "approval_suppressed"
				markThreadTurnCompleted(agent, turnControl)
				return
			}
			if (!markThreadTurnWaitingForApproval(agent, turnControl)) {
				return
			}
			const now = Date.now()
			const pending: PendingApproval = {
				approvalId: out.approval.approvalId,
				turnId: `${msg.teamId}:${channel}:${ev.ts ?? threadTs}:${out.approval.approvalId}`,
				orgId: org.id,
				teamId: msg.teamId,
				channel,
				threadTs,
				askerUser: ev.user ?? "",
				toolName: out.approval.toolName,
				slug: out.approval.slug,
				toolInput: out.approval.input,
				summary: out.approval.summary,
				state: {
					...out.state,
					skipPostTurnReflect: opts?.skipPostTurnReflect === true,
				},
				status: "pending",
				createdAt: now,
				expiresAt: now + APPROVAL_EXPIRY_MS,
			}
			insertPendingApproval(agent, pending)
			if (!isThreadTurnCurrent(agent, turnControl)) return
			await stream.finalize("", false)
			if (!isThreadTurnCurrent(agent, turnControl)) return
			const cardTs = await postSlackApprovalCard(botToken, channel, threadTs, {
				approvalId: pending.approvalId,
				summary: pending.summary,
				toolName: pending.toolName,
				slug: pending.slug,
				iconUrl: await resolveApprovalIconUrl({
					env: brainAgent(agent).env,
					orgId: pending.orgId,
					actor: pending.state.actor,
					slug: pending.slug,
					toolName: pending.toolName,
				}),
				askerUser: pending.askerUser,
				expiresAt: pending.expiresAt,
			})
			if (!cardTs) {
				// No buttons reached Slack — don't leave a pending row the asker
				// can never act on; mark it failed and say so in the thread.
				markApprovalTerminal(agent, pending.approvalId, "error")
				await stream.postFallback(
					"I need your sign-off to run that action, but I couldn't post the Approve/Deny buttons just now. Mind asking again?",
				)
				markThreadTurnCompleted(agent, turnControl)
				return
			}
			opts?.fiber?.checkpoint({
				phase: "waiting_approval",
				approvalMessageTs: cardTs,
			})
			setApprovalCardTs(agent, pending.approvalId, cardTs)
			await armApprovalExpiry(agent, pending)
			markBotThread(agent, msg.teamId, channel, threadTs)
			console.log(
				`[company-brain] approval suspended id=${pending.approvalId} org=${org.id} channel=${channel} thread=${threadTs}`,
			)
			return
		}
		reply = out.reply
		memory = passiveInvestigation ? null : out.memory
		if (passiveInvestigation && out.silentConclusion) {
			passiveTerminalReason = "model_no_reply"
		}
		const connectSlugs = passiveInvestigation
			? []
			: [
					...new Set(
						(out.connect ?? [])
							.map((slug) => slug.trim().toLowerCase())
							.filter(
								(slug) =>
									isMcpCatalogSlug(slug) || !!getDirectoryEntryBySlug(slug),
							),
					),
				]
		if (connectSlugs.length) {
			releaseConnectContinuation(agent, connectContinuationClaim)
			connectContinuationClaim = undefined
		}
		const connectSlackUserId = ev.user
		const connectActorUserId = orgMember.userId
		if (connectSlugs.length && connectSlackUserId && connectActorUserId) {
			const connectOutcomes = await Promise.all(
				connectSlugs.map(async (slug) => {
					const catalogEntry = getCatalogEntry(slug)
					const directoryEntry = catalogEntry
						? undefined
						: getDirectoryEntryBySlug(slug)
					if (
						catalogEntry ? catalogEntry.authType !== "oauth" : !directoryEntry
					) {
						return { status: "failed" as const, slug }
					}
					try {
						const connectResult = await startMcpConnect({
							env: brainAgent(agent).env,
							orgId: org.id,
							userId: connectActorUserId,
							slug,
							callbackOrigin: brainAgent(agent).env.PUBLIC_URL,
							slackContext: {
								teamId: msg.teamId,
								channel,
								threadTs,
								slackUserId: connectSlackUserId,
								originalQuestion: effectiveQuestion,
							},
						})
						if (connectResult.ok && "authUrl" in connectResult) {
							return {
								status: "link" as const,
								slug,
								authUrl: connectResult.authUrl,
								stateToken: connectResult.stateToken,
								label: directoryEntry?.name,
							}
						}
						if (
							connectResult.ok &&
							"alreadyAuthorized" in connectResult &&
							connectResult.alreadyAuthorized
						) {
							return { status: "connected" as const, slug }
						}
						if (!connectResult.ok) {
							console.warn(
								`[company-brain] mcp connect start failed slug=${slug} error=${connectResult.error}`,
							)
						} else {
							console.warn(
								`[company-brain] mcp connect start returned no authorization state slug=${slug}`,
							)
						}
						return { status: "failed" as const, slug }
					} catch (error) {
						console.warn(
							`[company-brain] mcp connect start threw slug=${slug} error=${error instanceof Error ? error.message : String(error)}`,
						)
						return { status: "failed" as const, slug }
					}
				}),
			)
			const links = connectOutcomes
				.filter((outcome) => outcome.status === "link")
				.map((outcome) => ({
					slug: outcome.slug,
					authUrl: outcome.authUrl,
					stateToken: outcome.stateToken,
					label: outcome.label,
				}))
			const alreadyConnected = connectOutcomes
				.filter((outcome) => outcome.status === "connected")
				.map((outcome) => outcome.slug)
			const failed = connectOutcomes
				.filter((outcome) => outcome.status === "failed")
				.map((outcome) => outcome.slug)

			if (links.length) {
				try {
					await stampSlackMcpConnectButtons({
						env: brainAgent(agent).env,
						links,
						slackContext: {
							teamId: msg.teamId,
							channel,
							threadTs,
							slackUserId: connectSlackUserId,
							originalQuestion: effectiveQuestion,
						},
					})
				} catch (error) {
					console.warn(
						`[company-brain] mcp connect card state failed error=${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}
			const buttonsPosted =
				links.length > 0 &&
				(await postSlackMcpConnectButtons({
					env: brainAgent(agent).env,
					botToken,
					channel,
					threadTs,
					slackUserId: connectSlackUserId,
					links,
				}))
			if (links.length && !buttonsPosted) {
				failed.push(...links.map((link) => link.slug))
			}

			const appNames = (slugs: string[]): string =>
				slugs
					.map(
						(slug) =>
							getCatalogEntry(slug)?.name ??
							getDirectoryEntryBySlug(slug)?.name ??
							slug,
					)
					.join(", ")
			if (buttonsPosted && turnOnlyConnected(out.toolTrace)) {
				const line = `Sent you a Connect card for ${appNames(
					links.map((link) => link.slug),
				)}.`
				const rewritten = out.narrated
					? await stream.rewriteLastNarration(line)
					: false
				reply = rewritten ? "" : line
				connectOnlySilence = rewritten
			}
			const statusNotes: string[] = []
			if (alreadyConnected.length) {
				statusNotes.push(`${appNames(alreadyConnected)} already connected.`)
			}
			const uniqueFailed = [...new Set(failed)]
			if (uniqueFailed.length) {
				statusNotes.push(
					`I couldn't start ${appNames(uniqueFailed)} authorization just now.`,
				)
			}
			if (statusNotes.length) {
				reply = [buttonsPosted ? reply.trim() : "", ...statusNotes]
					.filter(Boolean)
					.join("\n\n")
			}
		} else if (connectSlugs.length) {
			reply =
				"You'll need a Supermemory account linked to this workspace before I can connect apps for you. Ask an admin to add you, then try again."
		}
	} catch (err) {
		retainAbandoned(compute, (promise) => brainAgent(agent).waitUntil(promise))
		if (turnWasInterrupted(agent, turnControl)) {
			if (passiveInvestigation) passiveTerminalReason = "interrupted"
			return
		}
		if (turnDeadline.aborted) {
			paused = true
			console.warn("[company-brain] turn hit wall-clock deadline")
			if (passiveInvestigation) {
				passiveTerminalReason = "timeout"
				reply = ""
			} else {
				reply =
					"This one is taking longer than usual, so I paused here. Reply in the thread and I'll pick it back up."
			}
		} else {
			failed = true
			console.error("[company-brain] computeTurn failed:", err)
			if (passiveInvestigation) {
				passiveTerminalReason = "error"
				reply = ""
			} else {
				reply =
					"Sorry — I hit an error while working on that. Try again in a moment."
			}
		}
	} finally {
		const current = isThreadTurnCurrent(agent, turnControl)
		if (
			passiveInvestigation &&
			current &&
			reply.trim() &&
			passiveInvestigation.identity &&
			passiveInvestigation.budgetFinding !== false
		) {
			const priority = passiveInvestigation.priority ?? "normal"
			const budget = reserveChimeAnswer(agent, {
				channelId: channel,
				priority,
				lastChannelActivityAt: getPreviousHumanChannelActivityAt(
					agent,
					passiveInvestigation.identity,
				),
				urgentInvestigationFinding: priority === "urgent",
			})
			if (!budget.allowed) {
				recordStoredSuppression(agent, passiveInvestigation.identity, {
					suppression: budget.suppression,
					outcome: "investigation_finding_suppressed",
				})
				scheduleTurnSuppressionTelemetry(agent, passiveInvestigation.obs, {
					reason: budget.suppression,
					priority,
					decision: "investigate",
				})
				passiveTerminalReason = budget.suppression
				reply = ""
			} else {
				recordStoredActionOutcome(
					agent,
					passiveInvestigation.identity,
					"investigation_finding_budget_reserved",
				)
			}
		}
		if (
			proactiveTurn &&
			reply.trim() &&
			isThreadMuted(agent, msg.teamId, channel, threadTs)
		) {
			console.log(
				`[company-brain] proactive reply dropped: thread muted mid-turn channel=${channel} thread=${threadTs}`,
			)
			if (passiveInvestigation) passiveTerminalReason = "thread_muted"
			reply = ""
		}
		const finalizeResult = current
			? await stream.finalize(reply, failed, paused, connectOnlySilence)
			: { streamed: false as const }
		const memoryDocs = memoryDocsFromWriteback(memory)
		console.log(
			`[company-brain] computed in ${Date.now() - startedAt}ms (memoryCount=${memoryDocs.length})`,
		)

		let replyMessageTs = finalizeResult.messageTs
		if (current && reply.trim() && !finalizeResult.streamed) {
			replyMessageTs = (await stream.postFallback(reply)) ?? replyMessageTs
		}
		if (traceId && replyMessageTs) {
			recordMessageTrace(agent, channel, replyMessageTs, traceId, threadTs)
		}
		offerMuteOnMessage(replyMessageTs)
		if (current && (replyMessageTs || reply.trim())) {
			markBotThread(agent, msg.teamId, channel, threadTs)
		}
		console.log(`[company-brain] replied in ${Date.now() - startedAt}ms total`)

		if (passiveInvestigation) {
			const spoke = current && Boolean(reply.trim())
			if (passiveInvestigation.identity) {
				recordStoredActionOutcome(
					agent,
					passiveInvestigation.identity,
					spoke
						? "investigation_spoke"
						: passiveTerminalReason?.startsWith("budget")
							? "investigation_finding_suppressed"
							: "investigation_silent",
				)
			}
			if (passiveInvestigation.claim) {
				releasePassiveInvestigation(
					agent,
					passiveInvestigation.claim,
					spoke
						? "completed"
						: passiveTerminalReason?.includes("budget")
							? "suppressed"
							: failed
								? "failed"
								: "silent",
				)
			}
			scheduleTriageOutcome(agent, passiveInvestigation.obs, {
				decision: "investigate",
				reason: passiveInvestigation.reason,
				outcome: spoke ? "spoke" : "silent",
				...(spoke
					? { deliverySucceeded: Boolean(replyMessageTs) }
					: passiveTerminalReason || !current
						? {
								terminalReason: passiveTerminalReason ?? "superseded",
							}
						: {}),
			})
		} else {
			await finishAckReaction(current)
		}
	}

	if (!isThreadTurnCurrent(agent, turnControl)) return
	if (hasPendingLeaseRequestForTurn(agent, turnControl)) {
		if (!markThreadTurnWaitingForApproval(agent, turnControl)) return
		return
	}

	try {
		const memoryWriterUserId = slackMemoryWriterUserId(
			memoryScope,
			orgMember.userId,
		)
		const memoryDocs = memoryDocsFromWriteback(memory)
		if (
			!passiveInvestigation &&
			memoryDocs.length &&
			memoryWriterUserId &&
			isThreadTurnCurrent(agent, turnControl)
		) {
			const { writeMemories } = await import("../memory")
			await writeMemories(
				brainAgent(agent).env,
				undefined,
				org,
				memoryWriterUserId,
				memory,
				memoryScope,
				agent,
				{ allowedPersonSlackUserIds: memoryTagSlackUserIds },
			)
		}
	} finally {
		markThreadTurnCompleted(agent, turnControl)
	}

	if (
		!passiveInvestigation &&
		!opts?.skipPostTurnReflect &&
		!failed &&
		!paused
	) {
		await armPostTurnReflect(agent, {
			teamId: msg.teamId,
			channel,
			threadTs,
			originTraceId: traceId,
			askerSlackUserId: ev.user,
		}).catch((err) => {
			console.warn("[company-brain] post-turn-reflect arm failed:", err)
		})
	}
}
