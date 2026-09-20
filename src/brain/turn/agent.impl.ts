import {
	runLeaseEscalation as runLeaseEscalationImpl,
	runSlackLeaseDecision,
} from "../lease/decision"
import { ensureLeaseTables, revokeLeasesForConnection } from "../lease/store"
import type { LeaseEscalationPayload, SlackLeaseDecision } from "../lease/types"
import { clearBrainProfileSync } from "../memory/profile-sync"
import { ensureBrainMemoryTagTable } from "../memory/tags"
import {
	advanceBrainMemoryResetEpoch,
	clearBrainMemoryRegistry,
	ensureBrainMemoryNodeTable,
	ensureBrainMemoryStateTable,
} from "../memory/tree"
import { ensureWorkspacePromptTable } from "../memory/workspace-prompt"
import type { MemoryWriteback } from "../memory/writeback"
import { memoryDocsFromWriteback } from "../memory/writeback"
import {
	createSkillWithSideEffects,
	deleteSkillWithSideEffects,
	updateSkillWithSideEffects,
} from "../skills/operations"
import {
	runSlackSkillDraftInteraction,
	type SlackSkillDraftInteraction,
} from "../skills/slack-interactions"
import {
	ensureSkillTables,
	listSkills,
	sweepExpiredSkillDrafts,
} from "../skills/store"
import {
	ensureChannelMembershipTables,
	reconcileChannelMembership as reconcileChannelMembershipImpl,
	runSlackMembershipEvent,
} from "../slack/channel-membership"
import {
	ensureChannelObserveTables,
	reconcileChannelObserveSchedules,
} from "../slack/channel-observe"
import { ensureChimeBudgetTables } from "../slack/chime-budget"
import {
	ensureSlackEventStoreTables,
	getStoredSlackEventAudit,
	markStoredEventFiltered,
	recordSlackEvent,
	recordStoredActionOutcome,
	recordStoredTriageDecision,
} from "../slack/event-store"
import { ensureMessageTraceTable } from "../slack/message-trace"
import { ensureSlackProfileCacheTable } from "../slack/profile-cache"
import { ensurePublicChannelRolloutTables } from "../slack/public-channel-rollout"
import {
	ensureReactionQueueTables,
	type ReactionQueuePayload,
	recoverPassiveReactionQueue,
	runPassiveReactionQueue as runPassiveReactionQueueImpl,
} from "../slack/reaction-queue"
import { ensureTriageTraceSamplingTable } from "../slack/triage-sampling"
import { ensureTurnControlTables } from "../slack/turn-control"
import { brainAgent, type CompanyBrainAgent } from "./agent"
import { ensureApprovalTables } from "./approval"
import {
	type ApprovalExpiryPayload,
	runApprovalExpiry as runApprovalExpiryImpl,
} from "./approval-expiry"
import { computeTurn } from "./compute"
import { maybeNudgeInstallTools } from "./install-nudge"
import { clearInteractionObserveState } from "./interaction-observe"

export {
	getWorkspacePrompt,
	setWorkspacePrompt,
} from "../memory/workspace-prompt"
export { computeInteractionContext } from "../prompt/build"
export { runChannelObserve } from "../slack/channel-observe"
export {
	createAutomation,
	deleteAutomation,
	listAutomations,
	runAutomationNow,
	updateAutomation,
} from "../tools/automations"
export {
	createSkillWithSideEffects,
	deleteSkillWithSideEffects,
	updateSkillWithSideEffects,
}
export { listSkills }
export { runAdminChat } from "../admin/chat"
export { listBrainSurfaces } from "../admin/surfaces"
export { readDraftOutcome } from "../auto-research/outcome"
export { autoResearchRunState, runAutoResearch } from "../auto-research/run"
export { sendAutoResearchDraft } from "../auto-research/send"
export {
	dismissAutoResearchDraft,
	editAutoResearchDraftBody,
	listAutoResearchDrafts,
} from "../auto-research/store"
export { journeySnapshot, resetJourney } from "../journey/debug"
export { armJourney, runJourneyTick } from "../journey/engine"

import {
	cancelAutoResearchSchedules,
	resetAutoResearch,
} from "../auto-research/run"

export { runScheduledTask } from "../tools/scheduling"
export { runPostTurnReflect } from "./post-turn-reflect"
export {
	getResearchState,
	researchCompanyOnSignup,
	runResearchTask,
	syncResearchCardIfDone,
} from "./research"

import type { Schedule } from "agents"
import { flushBrainTelemetry } from "../observability"
import { runSlackChimeIn } from "../slack/chime"
import { isMuteReactionEvent, type SlackTurnMessage } from "../slack/events"
import {
	finalizeInterruptedSlackTurn as finalizeInterruptedSlackTurnImpl,
	runSlackApprovalDecision,
	runSlackConnectComplete,
	runSlackDebugReaction,
	runSlackMuteReaction,
	runSlackTurn,
	type SlackApprovalDecision,
	type SlackConnectCompletion,
} from "../slack/turn"
import type { SlackOrg } from "../slack/workspace"
import { ensureAutomationTable } from "../tools/automations"
import { ensureCodePauseTable } from "../tools/mcp/pause"
import {
	ensureMcpToolCatalogTable,
	invalidateMcpToolCatalog,
} from "../tools/mcp/tool-catalog-store"
import { ensureSandboxSessionTables } from "../tools/sandbox/sessions"
import {
	ensurePostTurnReflectTable,
	reconcilePostTurnReflectSchedules,
} from "./post-turn-reflect"
import type {
	SlackTurnFiberControl,
	SlackTurnFiberSnapshot,
} from "./slack-turn-fiber"
import {
	ensureTeamInviteTables,
	reconcileTeamInviteSchedule,
} from "./team-invite"
import { ensureThreadInvestigationTable } from "./thread-investigation"

export async function onStart(agent: CompanyBrainAgent): Promise<void> {
	ensureBrainMemoryTagTable(agent)
	ensureBrainMemoryNodeTable(agent)
	ensureBrainMemoryStateTable(agent)
	ensureApprovalTables(agent)
	ensureLeaseTables(agent)
	ensureChimeBudgetTables(agent)
	ensureSlackEventStoreTables(agent)
	ensureSlackProfileCacheTable(agent)
	ensureReactionQueueTables(agent)
	ensureTriageTraceSamplingTable(agent)
	ensureTurnControlTables(agent)
	ensureMessageTraceTable(agent)
	ensureSandboxSessionTables(agent)
	ensureAutomationTable(agent)
	ensureChannelObserveTables(agent)
	ensureSkillTables(agent)
	sweepExpiredSkillDrafts(agent)
	ensurePostTurnReflectTable(agent)
	ensureChannelMembershipTables(agent)
	ensureMcpToolCatalogTable(agent)
	ensureCodePauseTable(agent)
	ensureThreadInvestigationTable(agent)
	ensurePublicChannelRolloutTables(agent)
	ensureTeamInviteTables(agent)
	ensureWorkspacePromptTable(agent)
	await recoverPassiveReactionQueue(agent)
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_user_seen (
			user_id TEXT PRIMARY KEY,
			last_seen INTEGER NOT NULL
		)
	`
	const repairs = await Promise.allSettled([
		reconcileChannelObserveSchedules(agent),
		reconcilePostTurnReflectSchedules(agent),
		reconcileTeamInviteSchedule(agent),
		cancelAutoResearchSchedules(agent),
	])
	for (const repair of repairs) {
		if (repair.status === "rejected") {
			console.error(
				"[company-brain] observer schedule repair failed:",
				repair.reason,
			)
		}
	}
	await agent
		.deleteFibers({
			status: ["completed", "error", "aborted"],
			settledBefore: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
			limit: 500,
		})
		.catch((error) => {
			console.warn("[company-brain] settled fiber cleanup failed:", error)
		})
}

/** Tables are created lazily, so a missing one is expected; anything else is not. */
function ifTablesExist(...runs: Array<() => void>): void {
	for (const run of runs) {
		try {
			run()
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (!/no such table/i.test(message)) throw error
		}
	}
}

function slackOwnedScheduleIds(agent: CompanyBrainAgent): string[] {
	const ids: string[] = []
	const collect = (rows: Array<{ schedule_id: string }>) => {
		for (const row of rows) if (row.schedule_id) ids.push(row.schedule_id)
	}
	collect([
		...agent.sql<{
			schedule_id: string
		}>`SELECT schedule_id FROM brain_channel_observe`,
	])
	ifTablesExist(
		() =>
			collect([
				...agent.sql<{
					schedule_id: string
				}>`SELECT schedule_id FROM brain_post_turn_reflect`,
			]),
		() =>
			collect([
				...agent.sql<{
					schedule_id: string
				}>`SELECT schedule_id FROM brain_reaction_queue_schedule`,
			]),
		() =>
			collect([
				...agent.sql<{
					schedule_id: string
				}>`SELECT schedule_id FROM brain_team_invite_run`,
			]),
	)
	return ids
}

export async function resetSlackWorkspaceState(
	agent: CompanyBrainAgent,
): Promise<void> {
	const scheduleIds = slackOwnedScheduleIds(agent)
	ifTablesExist(
		() => agent.sql`DELETE FROM slack_home_channel`,
		() => agent.sql`DELETE FROM brain_channel_observe`,
		() => agent.sql`DELETE FROM brain_channel_observe_scan`,
		() => agent.sql`DELETE FROM brain_channel_observe_pending`,
		() => agent.sql`DELETE FROM brain_channel_observe_batch`,
		() => agent.sql`DELETE FROM brain_channel_observe_retry`,
		() => agent.sql`DELETE FROM brain_channel_observe_probe`,
		() => agent.sql`DELETE FROM brain_public_channel_rollout`,
		() => agent.sql`DELETE FROM brain_public_channel_rollout_card`,
		() => agent.sql`DELETE FROM brain_public_channel_rollout_channel`,
		() => agent.sql`DELETE FROM brain_public_channel_rollout_document`,
		() => agent.sql`DELETE FROM brain_public_channel_rollout_message`,
		() => agent.sql`DELETE FROM brain_public_channel_rollout_thread`,
		() => agent.sql`DELETE FROM brain_public_channel_introduction`,
		() => agent.sql`DELETE FROM brain_team_invite_run`,
		() => agent.sql`DELETE FROM brain_team_invite_settings`,
		() => agent.sql`DELETE FROM brain_team_invite_target`,
		() => agent.sql`DELETE FROM brain_home_welcome`,
		() => agent.sql`DELETE FROM brain_member_notified`,
		() => agent.sql`DELETE FROM brain_channel_membership`,
		() => agent.sql`DELETE FROM brain_channel_backfill`,
		() => agent.sql`DELETE FROM brain_reaction_queue_schedule`,
		() => agent.sql`DELETE FROM brain_trial_reminder_arm`,
	)
	await Promise.all(
		scheduleIds.map((id) => agent.cancelSchedule(id).catch(() => false)),
	)
}

export async function resetMemoryRegistry(
	agent: CompanyBrainAgent,
): Promise<void> {
	advanceBrainMemoryResetEpoch(agent)
	const scheduleIds = [
		...agent.sql<{ schedule_id: string }>`
			SELECT schedule_id FROM brain_post_turn_reflect
		`,
		...agent.sql<{ schedule_id: string }>`
			SELECT schedule_id FROM brain_channel_observe
		`,
	].map((row) => row.schedule_id)
	agent.sql`DELETE FROM brain_post_turn_reflect`
	agent.sql`DELETE FROM brain_post_turn_reflect_retry`
	agent.sql`DELETE FROM brain_post_turn_reflect_probe`
	agent.sql`DELETE FROM brain_channel_observe`
	agent.sql`DELETE FROM brain_channel_observe_scan`
	agent.sql`DELETE FROM brain_channel_observe_pending`
	agent.sql`DELETE FROM brain_channel_observe_batch`
	agent.sql`DELETE FROM brain_channel_observe_retry`
	agent.sql`DELETE FROM brain_channel_observe_probe`
	// carried_state regenerates deleted style and profile-sync's 24h throttle can
	// skip re-provisioning; clear both so reset fully wipes learned behavior.
	clearInteractionObserveState(agent)
	clearBrainProfileSync(agent)
	clearBrainMemoryRegistry(agent)
	// Auto-research keeps its own tables + recurring schedule; wipe them too.
	await resetAutoResearch(agent)
	await Promise.all(
		scheduleIds.map((id) => agent.cancelSchedule(id).catch(() => false)),
	)
}

export async function onApprovalDecision(
	agent: CompanyBrainAgent,
	decision: SlackApprovalDecision,
): Promise<void> {
	try {
		await runSlackApprovalDecision(agent, decision)
	} catch (err) {
		console.error("[company-brain] approval decision failed:", err)
	} finally {
		await flushBrainTelemetry()
	}
}

export async function onLeaseDecision(
	agent: CompanyBrainAgent,
	decision: SlackLeaseDecision,
): Promise<void> {
	try {
		await runSlackLeaseDecision(agent, decision)
	} catch (err) {
		console.error("[company-brain] lease decision failed:", err)
	} finally {
		await flushBrainTelemetry()
	}
}

export async function onSkillDraftInteraction(
	agent: CompanyBrainAgent,
	interaction: SlackSkillDraftInteraction,
): Promise<void> {
	try {
		await runSlackSkillDraftInteraction(agent, interaction)
	} catch (err) {
		console.error("[company-brain] skill draft interaction failed:", err)
	} finally {
		await flushBrainTelemetry()
	}
}

export async function runLeaseEscalation(
	agent: CompanyBrainAgent,
	payload: LeaseEscalationPayload,
): Promise<void> {
	try {
		await runLeaseEscalationImpl(agent, payload)
	} catch (err) {
		console.error("[company-brain] lease escalation failed:", err)
	} finally {
		await flushBrainTelemetry()
	}
}

export async function runApprovalExpiry(
	agent: CompanyBrainAgent,
	payload: ApprovalExpiryPayload,
): Promise<void> {
	try {
		await runApprovalExpiryImpl(agent, payload)
	} catch (err) {
		console.error("[company-brain] approval expiry failed:", err)
	} finally {
		await flushBrainTelemetry()
	}
}

export function onConnectionRevoked(
	agent: CompanyBrainAgent,
	connectionId: string,
): void {
	invalidateMcpToolCatalog(agent, { connectionId })
	const n = revokeLeasesForConnection(agent, connectionId)
	if (n > 0) {
		console.log(
			`[company-brain] revoked ${n} lease(s) for deleted connection ${connectionId}`,
		)
	}
}

export function onConnectionChanged(
	agent: CompanyBrainAgent,
	serverSlug: string,
): void {
	invalidateMcpToolCatalog(agent, { serverSlug })
}

export async function onSlackConnectComplete(
	agent: CompanyBrainAgent,
	completion: SlackConnectCompletion,
): Promise<void> {
	try {
		await runSlackConnectComplete(agent, completion)
	} catch (err) {
		console.error("[company-brain] slack connect completion failed:", err)
	} finally {
		await flushBrainTelemetry()
	}
}

export {
	armPublicChannelBeachhead,
	ensureAdminRolloutCard,
	ensurePublicChannelRolloutCard,
	getPublicChannelRolloutOverview,
	runPublicChannelBeachhead,
	runPublicChannelRollout,
	startPublicChannelRollout,
} from "../slack/public-channel-rollout"
export { getHomeChannel, setHomeChannel } from "./home-channel"
export { armInstallNudge, runInstallNudge } from "./install-nudge"
export { announceResearchIfDone } from "./research-announce"
export {
	attachAutomaticTeamInviteCard,
	onSlackTeamJoin,
	onSlackUserChange,
	recoverTeamInviteCallbackFailure,
	runSlackTeamJoinRetry,
	runSlackUserChangeRetry,
	runTeamInviteDirectoryPage,
	runTeamInviteProvisionStep,
	runTeamInviteStep,
	startAutomaticTeamInviteRollout,
	startTeamInviteWave,
} from "./team-invite"
export { claimTrialGrant, releaseTrialGrant } from "./trial-claim"

export async function onSlackEvent(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
	fiber?: SlackTurnFiberControl,
): Promise<void> {
	try {
		await runSlackTurn(agent, msg, { fiber })
		await maybeNudgeInstallTools(agent, msg)
	} catch (err) {
		markFailedTriageClaim(agent, msg)
		console.error("[company-brain] runTurn failed:", err)
	} finally {
		await flushBrainTelemetry()
	}
}

export async function onSlackChimeIn(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
): Promise<void> {
	try {
		await runSlackChimeIn(agent, msg)
	} catch (err) {
		markFailedTriageClaim(agent, msg)
		console.error("[company-brain] runSlackChimeIn failed:", err)
	} finally {
		await flushBrainTelemetry()
	}
}

export async function finalizeInterruptedSlackTurn(
	agent: CompanyBrainAgent,
	snapshot: SlackTurnFiberSnapshot,
): Promise<void> {
	await finalizeInterruptedSlackTurnImpl(agent, snapshot)
	await flushBrainTelemetry()
}

function markFailedTriageClaim(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
): void {
	if (!msg.triageClaimId) return
	const identity = recordSlackEvent(agent, msg)
	if (!identity) return
	if (getStoredSlackEventAudit(agent, identity)?.decision !== "judging") return
	const finalized = recordStoredTriageDecision(agent, identity, {
		decision: "pass",
		claimId: msg.triageClaimId,
		source: "handler_error",
		reason: "Proactivity handling failed after the event was claimed.",
	})
	if (!finalized) return
	recordStoredActionOutcome(agent, identity, "handler_failed")
}

export async function onSlackContextEvent(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
): Promise<void> {
	try {
		const identity = recordSlackEvent(agent, msg)
		if (!identity) return
		const audit = getStoredSlackEventAudit(agent, identity)
		if (!audit?.decision) {
			markStoredEventFiltered(
				agent,
				identity,
				"Slack event was retained as local context but is not model-triaged.",
			)
		}
	} catch (err) {
		console.error("[company-brain] onSlackContextEvent failed:", err)
	}
}

export async function runPassiveReactionQueue(
	agent: CompanyBrainAgent,
	payload: ReactionQueuePayload,
	schedule: Schedule<ReactionQueuePayload>,
): Promise<void> {
	try {
		await runPassiveReactionQueueImpl(agent, payload, schedule)
	} catch (err) {
		console.error("[company-brain] reaction queue failed:", err)
	} finally {
		await recoverPassiveReactionQueue(agent).catch((err) => {
			console.error("[company-brain] reaction queue recovery failed:", err)
		})
		await flushBrainTelemetry()
	}
}

export async function onSlackReaction(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
): Promise<void> {
	try {
		if (isMuteReactionEvent(msg.event)) {
			await runSlackMuteReaction(agent, msg)
			return
		}
		await runSlackDebugReaction(agent, msg)
	} catch (err) {
		console.error("[company-brain] onSlackReaction failed:", err)
	}
}

export async function onSlackMembershipEvent(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
): Promise<void> {
	try {
		await runSlackMembershipEvent(agent, msg)
	} catch (err) {
		console.error("[company-brain] runSlackMembershipEvent failed:", err)
	}
}

export async function reconcileChannelMembership(
	agent: CompanyBrainAgent,
	teamId: string,
): Promise<void> {
	try {
		await reconcileChannelMembershipImpl(agent, teamId)
	} catch (err) {
		console.error("[company-brain] reconcileChannelMembership failed:", err)
	}
}

export async function debugTurn(
	agent: CompanyBrainAgent,
	input: { text: string; userId?: string },
): Promise<{
	reply: string
	memory: MemoryWriteback
	written: boolean
}> {
	const [{ db, eq }, { organization }, { writeMemories }] = await Promise.all([
		import("@repo/db"),
		import("@repo/db/schema/auth"),
		import("../memory"),
	])
	const [row] = await db(brainAgent(agent).env)
		.select({
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
			metadata: organization.metadata,
		})
		.from(organization)
		.where(eq(organization.id, agent.name))
		.limit(1)
	if (!row) {
		return {
			reply: `No org found for id "${agent.name}".`,
			memory: null,
			written: false,
		}
	}
	const org: SlackOrg = {
		id: row.id,
		name: row.name,
		slug: row.slug,
		metadata: row.metadata as Record<string, unknown> | null,
	}
	const out = await computeTurn({
		agent,
		org,
		userId: input.userId ?? org.id,
		actor: { orgId: org.id, userId: input.userId },
		question: input.text,
		threadText: "",
		obs: input.userId
			? { distinctId: input.userId, source: "api" }
			: { source: "api" },
	})
	if (out.status === "suspended") {
		return {
			reply: `Approval needed for ${out.approval.slug ?? out.approval.toolName}.`,
			memory: null,
			written: false,
		}
	}
	const { reply, memory } = out
	let written = false
	if (memoryDocsFromWriteback(memory).length && input.userId) {
		written =
			(
				await writeMemories(
					brainAgent(agent).env,
					undefined,
					org,
					input.userId,
					memory,
					undefined,
					agent,
				)
			).written > 0
	}
	await flushBrainTelemetry()
	return { reply, memory, written }
}
