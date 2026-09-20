import { generateId } from "@repo/lib/generate-id"
import type { Schedule } from "agents"
import { decryptToken } from "@/lib/crypto"
import {
	companyBrainDenialMessage,
	getCompanyBrainEntitlement,
	orgCanRunCompanyBrain,
} from "@/lib/payments/company-brain-entitlement"
import { companyBrainActivateUrl } from "@/lib/payments/company-brain-trial"
import {
	getSlackTeamDirectory,
	inviteSlackUserToChannel,
	listSlackUsersPage,
	lookupSlackUserInfo,
	openSlackConversation,
	postSlackEphemeral,
	postSlackMessage,
	postSlackMessageIdempotent,
	updateSlackMessage,
} from "../slack/client"
import { firstNameOf } from "../slack/greet"
import { composeStarters } from "../slack/install-greeting"
import {
	provisionSlackWorkspaceMember,
	revokeSlackWorkspaceMember,
} from "../slack/member-provisioning"
import {
	AUTOMATIC_TEAM_INVITE_FALLBACK,
	automaticTeamInviteProgressBlocks,
	isEligibleFullMember,
	memberIntroBlocks,
	memberIntroText,
	TEAM_INVITE_CARD_FALLBACK,
	teamInviteCardBlocks,
} from "../slack/team-invite-card"
import {
	getOrgActorBySlackIdentity,
	getWorkspaceByTeamId,
} from "../slack/workspace"
import { mcpAppDisplayName } from "../tools/mcp/directory"
import { brainAgent, type CompanyBrainAgent } from "./agent"
import { getHomeChannel } from "./home-channel"
import { getResearchState } from "./research"
import { researchBrief } from "./research-brief"

const STEP_DELAY_SECONDS = 1
const MAX_TARGET_ATTEMPTS = 3
const MAX_WAVE_MEMBERS = 5000
const MEMBER_CONNECT_SLUGS = ["linear", "notion"] as const

export type TeamInviteStart = {
	teamId: string
	mode: "selected" | "all"
	userIds?: string[]
	requestedBySlackUserId: string
	cardChannel: string
	cardTs?: string
}

export type AutomaticTeamInviteStart = {
	teamId: string
	installerSlackUserId: string
	adminChannel?: string
	adminMessageTs?: string
}

export type AutomaticTeamInviteCard = {
	teamId: string
	adminChannel: string
	adminMessageTs: string
}

export type TeamInvitePayload = { runId: string }

export type SlackTeamJoinPayload = {
	teamId: string
	user: {
		id: string
		is_bot?: boolean
		is_restricted?: boolean
		is_ultra_restricted?: boolean
		is_stranger?: boolean
		team_id?: string
		deleted?: boolean
	}
}

export type SlackUserChangePayload = SlackTeamJoinPayload
export type SlackTeamJoinRetryPayload = SlackTeamJoinPayload & {
	attempt: number
}
export type SlackUserChangeRetryPayload = SlackUserChangePayload & {
	attempt: number
}

type SlackLifecycleOutcome =
	| { terminal: true }
	| { terminal: false; retryAfterSeconds?: number }

const TERMINAL_LIFECYCLE_OUTCOME: SlackLifecycleOutcome = { terminal: true }

function retryLifecycleOutcome(
	retryAfterSeconds?: number,
): SlackLifecycleOutcome {
	return {
		terminal: false,
		...(retryAfterSeconds ? { retryAfterSeconds } : {}),
	}
}

type RunRow = {
	run_id: string
	team_id: string
	mode: string
	status: string
	sent: number
	skipped: number
	total: number
	card_channel: string
	card_ts: string | null
	starters_json: string | null
	failure_count: number
	directory_cursor: string | null
	requested_by_slack_user_id: string | null
	deduped: number
	schedule_id: string | null
}

type TeamInviteScheduleCallback =
	| "runTeamInviteDirectoryPage"
	| "runTeamInviteProvisionStep"
	| "runTeamInviteStep"

const ACTIVE_AUTOMATIC_RUN_STATUSES = [
	"enumerating",
	"provisioning",
	"preparing",
	"running",
] as const

export function ensureTeamInviteTables(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_member_notified (
			slack_user_id TEXT PRIMARY KEY,
			notified_at INTEGER NOT NULL,
			reason TEXT NOT NULL,
			client_msg_id TEXT
		)
	`
	try {
		agent.sql`ALTER TABLE brain_member_notified ADD COLUMN client_msg_id TEXT`
	} catch {}
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_team_invite_run (
			id INTEGER PRIMARY KEY,
			run_id TEXT NOT NULL,
			team_id TEXT NOT NULL,
			mode TEXT NOT NULL,
			status TEXT NOT NULL,
			sent INTEGER NOT NULL DEFAULT 0,
			skipped INTEGER NOT NULL DEFAULT 0,
			total INTEGER NOT NULL DEFAULT 0,
			card_channel TEXT NOT NULL,
			card_ts TEXT,
			starters_json TEXT,
			failure_count INTEGER NOT NULL DEFAULT 0,
			deduped INTEGER NOT NULL DEFAULT 0,
			directory_cursor TEXT,
			requested_by_slack_user_id TEXT,
			schedule_id TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`
	try {
		agent.sql`ALTER TABLE brain_team_invite_run ADD COLUMN directory_cursor TEXT`
	} catch {}
	try {
		agent.sql`ALTER TABLE brain_team_invite_run ADD COLUMN requested_by_slack_user_id TEXT`
	} catch {}
	try {
		agent.sql`ALTER TABLE brain_team_invite_run ADD COLUMN deduped INTEGER NOT NULL DEFAULT 0`
	} catch {}
	try {
		agent.sql`ALTER TABLE brain_team_invite_run ADD COLUMN schedule_id TEXT`
	} catch {}
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_team_invite_settings (
			id INTEGER PRIMARY KEY,
			team_id TEXT NOT NULL,
			lifecycle_enabled INTEGER NOT NULL DEFAULT 0,
			updated_at INTEGER NOT NULL
		)
	`
	// Backfill durable lifecycle opt-in for organizations that ran automatic
	// onboarding before this setting was introduced.
	agent.sql`
		INSERT INTO brain_team_invite_settings (
			id, team_id, lifecycle_enabled, updated_at
		)
		SELECT 1, team_id, 1, ${Date.now()}
		FROM brain_team_invite_run
		WHERE id = 1 AND mode = 'automatic'
		ON CONFLICT(id) DO NOTHING
	`
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_team_invite_target (
			run_id TEXT NOT NULL,
			slack_user_id TEXT NOT NULL,
			status TEXT NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			client_msg_id TEXT,
			email TEXT,
			display_name TEXT,
			supermemory_user_id TEXT,
			last_error TEXT,
			PRIMARY KEY (run_id, slack_user_id)
		)
	`
	try {
		agent.sql`ALTER TABLE brain_team_invite_target ADD COLUMN client_msg_id TEXT`
	} catch {}
	try {
		agent.sql`ALTER TABLE brain_team_invite_target ADD COLUMN email TEXT`
	} catch {}
	try {
		agent.sql`ALTER TABLE brain_team_invite_target ADD COLUMN display_name TEXT`
	} catch {}
	try {
		agent.sql`ALTER TABLE brain_team_invite_target ADD COLUMN supermemory_user_id TEXT`
	} catch {}
	try {
		agent.sql`ALTER TABLE brain_team_invite_target ADD COLUMN last_error TEXT`
	} catch {}
}

function currentRun(agent: CompanyBrainAgent): RunRow | undefined {
	return agent.sql<RunRow>`
		SELECT run_id, team_id, mode, status, sent, skipped, total,
			card_channel, card_ts, starters_json, failure_count, directory_cursor,
			requested_by_slack_user_id, deduped, schedule_id
		FROM brain_team_invite_run WHERE id = 1
	`[0]
}

function automaticLifecycleEnabled(
	agent: CompanyBrainAgent,
	teamId: string,
): boolean {
	return Boolean(
		agent.sql<{ lifecycle_enabled: number }>`
			SELECT lifecycle_enabled
			FROM brain_team_invite_settings
			WHERE id = 1 AND team_id = ${teamId}
		`[0]?.lifecycle_enabled,
	)
}

function enableAutomaticLifecycle(
	agent: CompanyBrainAgent,
	teamId: string,
): void {
	agent.sql`
		INSERT INTO brain_team_invite_settings (
			id, team_id, lifecycle_enabled, updated_at
		) VALUES (1, ${teamId}, 1, ${Date.now()})
		ON CONFLICT(id) DO UPDATE SET
			team_id = excluded.team_id,
			lifecycle_enabled = 1,
			updated_at = excluded.updated_at
	`
}

type MemberNotificationClaim =
	| { status: "complete" }
	| { status: "pending"; clientMessageId: string }

function notificationReasonIsPending(reason: string): boolean {
	return reason === "welcome_pending" || reason === "team_join_pending"
}

function memberNotificationComplete(
	agent: CompanyBrainAgent,
	userId: string,
): boolean {
	const row = agent.sql<{ reason: string }>`
		SELECT reason FROM brain_member_notified
		WHERE slack_user_id = ${userId}
	`[0]
	return Boolean(row && !notificationReasonIsPending(row.reason))
}

function claimMemberNotification(
	agent: CompanyBrainAgent,
	userId: string,
	proposedClientMessageId: string,
): MemberNotificationClaim {
	const inserted = agent.sql<{
		reason: string
		client_msg_id: string | null
	}>`
		INSERT INTO brain_member_notified (
			slack_user_id, notified_at, reason, client_msg_id
		) VALUES (
			${userId}, ${Date.now()}, 'welcome_pending', ${proposedClientMessageId}
		)
		ON CONFLICT(slack_user_id) DO NOTHING
		RETURNING reason, client_msg_id
	`[0]
	let row =
		inserted ??
		agent.sql<{ reason: string; client_msg_id: string | null }>`
			SELECT reason, client_msg_id FROM brain_member_notified
			WHERE slack_user_id = ${userId}
		`[0]
	if (!row || !notificationReasonIsPending(row.reason)) {
		return { status: "complete" }
	}
	if (!row.client_msg_id) {
		row =
			agent.sql<{ reason: string; client_msg_id: string | null }>`
				UPDATE brain_member_notified
				SET client_msg_id = ${proposedClientMessageId}
				WHERE slack_user_id = ${userId}
					AND reason IN ('welcome_pending', 'team_join_pending')
					AND client_msg_id IS NULL
				RETURNING reason, client_msg_id
			`[0] ?? row
	}
	return {
		status: "pending",
		clientMessageId: row.client_msg_id ?? proposedClientMessageId,
	}
}

function completeMemberNotification(
	agent: CompanyBrainAgent,
	userId: string,
	clientMessageId: string,
	reason: string,
): void {
	agent.sql`
		UPDATE brain_member_notified
		SET reason = ${reason}, notified_at = ${Date.now()}
		WHERE slack_user_id = ${userId}
			AND client_msg_id = ${clientMessageId}
			AND reason IN ('welcome_pending', 'team_join_pending')
	`
}

function skipActiveTeamInviteTarget(
	agent: CompanyBrainAgent,
	teamId: string,
	slackUserId: string,
	reason: string,
): boolean {
	const run = currentRun(agent)
	if (
		!run ||
		run.team_id !== teamId ||
		!["enumerating", "provisioning", "preparing", "running"].includes(
			run.status,
		)
	) {
		return false
	}
	const skipped = agent.sql<{ slack_user_id: string }>`
		UPDATE brain_team_invite_target
		SET status = 'skipped', last_error = ${reason}
		WHERE run_id = ${run.run_id}
			AND slack_user_id = ${slackUserId}
			AND status IN ('discovered', 'provisioned', 'pending')
		RETURNING slack_user_id
	`
	if (!skipped[0]) return false
	agent.sql`
		UPDATE brain_team_invite_run
		SET skipped = skipped + 1, updated_at = ${Date.now()}
		WHERE id = 1 AND run_id = ${run.run_id}
	`
	return true
}

function parseStarters(json: string | null): string[] | null {
	if (!json) return null
	try {
		const value = JSON.parse(json)
		return Array.isArray(value) && value.every((v) => typeof v === "string")
			? value
			: null
	} catch {
		return null
	}
}

async function refreshCard(
	agent: CompanyBrainAgent,
	botToken: string,
	run: RunRow,
	status: "running" | "done" | "failed",
): Promise<void> {
	if (!run.card_ts) return
	if (run.mode === "automatic") {
		const latest = currentRun(agent) ?? run
		const cardTs = latest.card_ts ?? run.card_ts
		if (!cardTs) return
		const counts = agent.sql<{
			provisioned: number
			finished: number
		}>`
			SELECT
				SUM(CASE WHEN status != 'discovered' THEN 1 ELSE 0 END) AS provisioned,
				SUM(CASE WHEN status IN ('sent', 'skipped', 'deduped') THEN 1 ELSE 0 END) AS finished
			FROM brain_team_invite_target
			WHERE run_id = ${latest.run_id}
		`[0]
		const phase =
			status === "done"
				? ("done" as const)
				: status === "failed"
					? ("failed" as const)
					: latest.status === "enumerating"
						? ("enumerating" as const)
						: latest.status === "provisioning" || latest.status === "preparing"
							? ("provisioning" as const)
							: ("notifying" as const)
		await updateSlackMessage(
			botToken,
			latest.card_channel,
			cardTs,
			AUTOMATIC_TEAM_INVITE_FALLBACK,
			automaticTeamInviteProgressBlocks({
				phase,
				total: latest.total,
				processed:
					phase === "provisioning"
						? (counts?.provisioned ?? 0)
						: (counts?.finished ?? 0),
				sent: latest.sent,
				skipped: latest.skipped,
				deduped: latest.deduped,
			}),
		).catch(() => {})
		return
	}
	await updateSlackMessage(
		botToken,
		run.card_channel,
		run.card_ts,
		TEAM_INVITE_CARD_FALLBACK,
		teamInviteCardBlocks({
			status,
			sent: run.sent,
			skipped: run.skipped,
			total: run.total,
		}),
	).catch(() => {})
}

function ownsTeamInviteSchedule(
	run: RunRow,
	schedule: Schedule<TeamInvitePayload> | undefined,
): boolean {
	return run.mode !== "automatic" || run.schedule_id === schedule?.id
}

function failOwnedTeamInviteCallback(
	agent: CompanyBrainAgent,
	payload: TeamInvitePayload,
	schedule: Schedule<TeamInvitePayload> | undefined,
	reason: string,
): void {
	const run = currentRun(agent)
	if (
		!run ||
		run.run_id !== payload.runId ||
		run.mode !== "automatic" ||
		!ownsTeamInviteSchedule(run, schedule)
	) {
		return
	}
	agent.sql`
		UPDATE brain_team_invite_run
		SET status = 'failed', schedule_id = NULL,
			failure_count = failure_count + 1,
			updated_at = ${Date.now()}
		WHERE id = 1 AND run_id = ${run.run_id}
			AND schedule_id = ${schedule?.id ?? run.schedule_id}
	`
	console.error(
		`[slack] automatic team invite callback failed run=${run.run_id} reason=${reason}`,
	)
}

export async function recoverTeamInviteCallbackFailure(
	agent: CompanyBrainAgent,
	payload: TeamInvitePayload,
	schedule: Schedule<TeamInvitePayload> | undefined,
	error: unknown,
): Promise<void> {
	failOwnedTeamInviteCallback(
		agent,
		payload,
		schedule,
		error instanceof Error ? error.message.slice(0, 500) : String(error),
	)
}

async function scheduleTeamInviteCallback(
	agent: CompanyBrainAgent,
	runId: string,
	callback: TeamInviteScheduleCallback,
	delaySeconds: number,
): Promise<boolean> {
	const run = currentRun(agent)
	if (!run || run.run_id !== runId) return false
	if (run.mode !== "automatic") {
		await agent.schedule(delaySeconds, callback, { runId })
		return true
	}

	let lastError: unknown
	for (let attempt = 1; attempt <= MAX_TARGET_ATTEMPTS; attempt++) {
		let scheduled: Schedule<TeamInvitePayload> | undefined
		try {
			scheduled = await agent.schedule(delaySeconds, callback, { runId })
			const claimed = agent.sql<{ run_id: string }>`
				UPDATE brain_team_invite_run
				SET schedule_id = ${scheduled.id}, updated_at = ${Date.now()}
				WHERE id = 1 AND run_id = ${runId}
					AND status NOT IN ('done', 'failed', 'aborted')
				RETURNING run_id
			`[0]
			if (!claimed) {
				await agent.cancelSchedule(scheduled.id).catch(() => {})
				return false
			}
			return true
		} catch (error) {
			lastError = error
			if (scheduled) await agent.cancelSchedule(scheduled.id).catch(() => {})
		}
	}

	console.error(
		`[slack] team invite scheduling failed run=${runId} callback=${callback}:`,
		lastError,
	)
	agent.sql`
		UPDATE brain_team_invite_run
		SET status = 'failed', schedule_id = NULL,
			failure_count = failure_count + 1, updated_at = ${Date.now()}
		WHERE id = 1 AND run_id = ${runId}
	`
	const failed = currentRun(agent)
	if (failed) {
		const env = brainAgent(agent).env
		const ws = await getWorkspaceByTeamId(env, failed.team_id).catch(
			() => undefined,
		)
		if (ws?.orgId === agent.name) {
			const botToken = await decryptToken(
				ws.botTokenEnc,
				env.ENCRYPTION_SECRET,
			).catch(() => undefined)
			if (botToken) await refreshCard(agent, botToken, failed, "failed")
		}
	}
	return false
}

export async function reconcileTeamInviteSchedule(
	agent: CompanyBrainAgent,
): Promise<void> {
	ensureTeamInviteTables(agent)
	const run = currentRun(agent)
	if (
		!run ||
		run.mode !== "automatic" ||
		!ACTIVE_AUTOMATIC_RUN_STATUSES.includes(
			run.status as (typeof ACTIVE_AUTOMATIC_RUN_STATUSES)[number],
		)
	) {
		return
	}
	if (run.schedule_id && agent.getSchedules({ id: run.schedule_id }).length)
		return

	let callback: TeamInviteScheduleCallback
	if (run.status === "enumerating") {
		callback = "runTeamInviteDirectoryPage"
	} else if (run.status === "provisioning" || run.status === "preparing") {
		if (run.status === "preparing") {
			agent.sql`
				UPDATE brain_team_invite_run
				SET status = 'provisioning', schedule_id = NULL,
					updated_at = ${Date.now()}
				WHERE id = 1 AND run_id = ${run.run_id}
			`
		}
		callback = "runTeamInviteProvisionStep"
	} else {
		callback = "runTeamInviteStep"
	}
	await scheduleTeamInviteCallback(
		agent,
		run.run_id,
		callback,
		STEP_DELAY_SECONDS,
	)
}

// Starters are one LLM call per wave, shared by every member DM.
async function waveStarters(
	agent: CompanyBrainAgent,
	orgId: string,
	companyName: string | null,
): Promise<string[] | null> {
	try {
		const state = await getResearchState(agent)
		const brief = state.status === "done" ? researchBrief(state.events) : ""
		if (!brief) return null
		return await composeStarters(
			brainAgent(agent).env,
			orgId,
			brief,
			companyName ?? state.domain ?? "the company",
			"team_invite_starters",
		)
	} catch {
		return null
	}
}

export async function startAutomaticTeamInviteRollout(
	agent: CompanyBrainAgent,
	payload: AutomaticTeamInviteStart,
): Promise<void> {
	ensureTeamInviteTables(agent)
	const prior = currentRun(agent)
	const env = brainAgent(agent).env
	const ws = await getWorkspaceByTeamId(env, payload.teamId)
	if (!ws || ws.orgId !== agent.name) return

	if (
		!(await orgCanRunCompanyBrain(env, ws.orgId, (promise) =>
			agent.waitUntil(promise),
		))
	) {
		if (
			prior?.team_id === payload.teamId &&
			prior.mode === "automatic" &&
			ACTIVE_AUTOMATIC_RUN_STATUSES.includes(
				prior.status as (typeof ACTIVE_AUTOMATIC_RUN_STATUSES)[number],
			)
		) {
			agent.sql`
				UPDATE brain_team_invite_run
				SET status = 'failed', schedule_id = NULL,
					card_channel = ${payload.adminChannel ?? prior.card_channel},
					card_ts = ${payload.adminMessageTs ?? prior.card_ts},
					updated_at = ${Date.now()}
				WHERE id = 1 AND run_id = ${prior.run_id}
			`
			if (prior.schedule_id) {
				await agent.cancelSchedule(prior.schedule_id).catch(() => {})
			}
			const failed = currentRun(agent)
			if (failed) {
				const botToken = await decryptToken(
					ws.botTokenEnc,
					env.ENCRYPTION_SECRET,
				)
				await refreshCard(agent, botToken, failed, "failed")
			}
		} else if (payload.adminMessageTs) {
			const botToken = await decryptToken(
				ws.botTokenEnc,
				env.ENCRYPTION_SECRET,
			)
			await updateSlackMessage(
				botToken,
				payload.adminChannel ?? "",
				payload.adminMessageTs,
				AUTOMATIC_TEAM_INVITE_FALLBACK,
				automaticTeamInviteProgressBlocks({ phase: "failed" }),
			).catch(() => {})
		}
		return
	}
	enableAutomaticLifecycle(agent, payload.teamId)

	if (
		prior?.team_id === payload.teamId &&
		prior.mode === "automatic" &&
		ACTIVE_AUTOMATIC_RUN_STATUSES.includes(
			prior.status as (typeof ACTIVE_AUTOMATIC_RUN_STATUSES)[number],
		)
	) {
		agent.sql`
			UPDATE brain_team_invite_run
			SET card_channel = ${payload.adminChannel ?? prior.card_channel},
				card_ts = ${payload.adminMessageTs ?? prior.card_ts},
				requested_by_slack_user_id = ${payload.installerSlackUserId},
				updated_at = ${Date.now()}
			WHERE id = 1 AND run_id = ${prior.run_id}
		`
		await reconcileTeamInviteSchedule(agent)
		return
	}

	const runId = generateId()
	const now = Date.now()
	agent.sql`DELETE FROM brain_team_invite_target`
	agent.sql`
		INSERT INTO brain_team_invite_run (
			id, run_id, team_id, mode, status, sent, skipped, total,
			card_channel, card_ts, starters_json, failure_count, directory_cursor,
			requested_by_slack_user_id, schedule_id, created_at, updated_at
		) VALUES (
			1, ${runId}, ${payload.teamId}, 'automatic', 'enumerating', 0, 0, 0,
			${payload.adminChannel ?? ""}, ${payload.adminMessageTs ?? null}, NULL, 0, NULL,
			${payload.installerSlackUserId}, NULL, ${now}, ${now}
		)
		ON CONFLICT(id) DO UPDATE SET
			run_id = excluded.run_id, team_id = excluded.team_id,
			mode = excluded.mode, status = excluded.status,
			sent = 0, skipped = 0, deduped = 0, total = 0,
			card_channel = excluded.card_channel, card_ts = excluded.card_ts,
			starters_json = NULL, failure_count = 0, directory_cursor = NULL,
			requested_by_slack_user_id = excluded.requested_by_slack_user_id,
			schedule_id = NULL,
			created_at = excluded.created_at, updated_at = excluded.updated_at
	`
	await scheduleTeamInviteCallback(
		agent,
		runId,
		"runTeamInviteDirectoryPage",
		STEP_DELAY_SECONDS,
	)
}

export async function attachAutomaticTeamInviteCard(
	agent: CompanyBrainAgent,
	payload: AutomaticTeamInviteCard,
): Promise<void> {
	ensureTeamInviteTables(agent)
	const run = currentRun(agent)
	if (!run || run.team_id !== payload.teamId || run.mode !== "automatic") {
		const env = brainAgent(agent).env
		const ws = await getWorkspaceByTeamId(env, payload.teamId)
		if (!ws || ws.orgId !== agent.name) return
		const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
		await updateSlackMessage(
			botToken,
			payload.adminChannel,
			payload.adminMessageTs,
			AUTOMATIC_TEAM_INVITE_FALLBACK,
			automaticTeamInviteProgressBlocks({ phase: "failed" }),
		).catch(() => {})
		return
	}
	agent.sql`
		UPDATE brain_team_invite_run
		SET card_channel = ${payload.adminChannel},
			card_ts = ${payload.adminMessageTs},
			updated_at = ${Date.now()}
		WHERE id = 1 AND run_id = ${run.run_id}
	`
	const latest = currentRun(agent)
	if (!latest) return
	const env = brainAgent(agent).env
	const ws = await getWorkspaceByTeamId(env, payload.teamId)
	if (!ws || ws.orgId !== agent.name) return
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	await refreshCard(
		agent,
		botToken,
		latest,
		latest.status === "done"
			? "done"
			: latest.status === "failed" || latest.status === "aborted"
				? "failed"
				: "running",
	)
	await reconcileTeamInviteSchedule(agent)
}

export async function runTeamInviteDirectoryPage(
	agent: CompanyBrainAgent,
	payload: TeamInvitePayload,
	schedule?: Schedule<TeamInvitePayload>,
): Promise<void> {
	ensureTeamInviteTables(agent)
	const run = currentRun(agent)
	if (
		!run ||
		run.run_id !== payload.runId ||
		run.status !== "enumerating" ||
		run.mode !== "automatic" ||
		!ownsTeamInviteSchedule(run, schedule)
	) {
		return
	}

	const env = brainAgent(agent).env
	const ws = await getWorkspaceByTeamId(env, run.team_id)
	if (!ws || ws.orgId !== agent.name) {
		failOwnedTeamInviteCallback(
			agent,
			payload,
			schedule,
			"workspace_missing_or_rebound",
		)
		return
	}
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	if (
		!(await orgCanRunCompanyBrain(env, ws.orgId, (promise) =>
			agent.waitUntil(promise),
		))
	) {
		agent.sql`
			UPDATE brain_team_invite_run
			SET status = 'failed', schedule_id = NULL, updated_at = ${Date.now()}
			WHERE id = 1 AND run_id = ${run.run_id}
		`
		const failed = currentRun(agent)
		if (failed) await refreshCard(agent, botToken, failed, "failed")
		return
	}
	const page = await listSlackUsersPage(botToken, {
		cursor: run.directory_cursor ?? undefined,
	})

	if (!page.ok) {
		if (page.retryAfterSeconds) {
			await scheduleTeamInviteCallback(
				agent,
				run.run_id,
				"runTeamInviteDirectoryPage",
				page.retryAfterSeconds,
			)
			return
		}
		const failures = run.failure_count + 1
		agent.sql`
			UPDATE brain_team_invite_run
			SET failure_count = ${failures}, updated_at = ${Date.now()},
				status = ${failures >= MAX_TARGET_ATTEMPTS ? "failed" : "enumerating"},
				schedule_id = ${failures >= MAX_TARGET_ATTEMPTS ? null : run.schedule_id}
			WHERE id = 1 AND run_id = ${run.run_id}
		`
		if (failures >= MAX_TARGET_ATTEMPTS) {
			const failed = currentRun(agent)
			if (failed) await refreshCard(agent, botToken, failed, "failed")
		}
		if (failures < MAX_TARGET_ATTEMPTS) {
			await scheduleTeamInviteCallback(
				agent,
				run.run_id,
				"runTeamInviteDirectoryPage",
				STEP_DELAY_SECONDS * failures,
			)
		}
		return
	}

	const existingTotal =
		agent.sql<{ count: number }>`
			SELECT COUNT(*) AS count FROM brain_team_invite_target
			WHERE run_id = ${run.run_id}
		`[0]?.count ?? 0
	let added = 0
	for (const slackMember of page.items) {
		if (
			slackMember.id === run.requested_by_slack_user_id ||
			!isEligibleFullMember(slackMember, ws.botUserId, run.team_id)
		) {
			continue
		}
		if (existingTotal + added >= MAX_WAVE_MEMBERS) break
		agent.sql`
			INSERT INTO brain_team_invite_target (
				run_id, slack_user_id, status, attempts, client_msg_id,
				email, display_name
			) VALUES (
				${run.run_id}, ${slackMember.id}, 'discovered', 0,
				${crypto.randomUUID()}, ${slackMember.email?.trim().toLowerCase() ?? null},
				${slackMember.displayName ?? slackMember.name}
			)
			ON CONFLICT(run_id, slack_user_id) DO NOTHING
		`
		added += 1
	}

	const total = agent.sql<{ count: number }>`
		SELECT COUNT(*) AS count FROM brain_team_invite_target
		WHERE run_id = ${run.run_id}
	`[0]?.count
	const capped = (total ?? 0) >= MAX_WAVE_MEMBERS
	const complete = page.complete || capped
	agent.sql`
		UPDATE brain_team_invite_run
		SET total = ${total ?? run.total + added},
			directory_cursor = ${complete ? null : (page.nextCursor ?? null)},
			failure_count = 0,
			status = ${complete ? "provisioning" : "enumerating"},
			updated_at = ${Date.now()}
		WHERE id = 1 AND run_id = ${run.run_id}
	`
	const updated = currentRun(agent)
	if (updated) await refreshCard(agent, botToken, updated, "running")
	if (complete) {
		await scheduleTeamInviteCallback(
			agent,
			run.run_id,
			"runTeamInviteProvisionStep",
			STEP_DELAY_SECONDS,
		)
	} else {
		await scheduleTeamInviteCallback(
			agent,
			run.run_id,
			"runTeamInviteDirectoryPage",
			STEP_DELAY_SECONDS,
		)
	}
}

export async function runTeamInviteProvisionStep(
	agent: CompanyBrainAgent,
	payload: TeamInvitePayload,
	schedule?: Schedule<TeamInvitePayload>,
): Promise<void> {
	ensureTeamInviteTables(agent)
	const run = currentRun(agent)
	if (
		!run ||
		run.run_id !== payload.runId ||
		run.status !== "provisioning" ||
		run.mode !== "automatic" ||
		!ownsTeamInviteSchedule(run, schedule)
	) {
		return
	}

	const env = brainAgent(agent).env
	const ws = await getWorkspaceByTeamId(env, run.team_id)
	if (!ws || ws.orgId !== agent.name) {
		failOwnedTeamInviteCallback(
			agent,
			payload,
			schedule,
			"workspace_missing_or_rebound",
		)
		return
	}
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	if (
		!(await orgCanRunCompanyBrain(env, ws.orgId, (promise) =>
			agent.waitUntil(promise),
		))
	) {
		agent.sql`
			UPDATE brain_team_invite_run
			SET status = 'failed', schedule_id = NULL, updated_at = ${Date.now()}
			WHERE id = 1 AND run_id = ${run.run_id}
		`
		const failed = currentRun(agent)
		if (failed) await refreshCard(agent, botToken, failed, "failed")
		return
	}

	const target = agent.sql<{
		slack_user_id: string
		email: string | null
		display_name: string | null
		attempts: number
	}>`
		SELECT slack_user_id, email, display_name, attempts
		FROM brain_team_invite_target
		WHERE run_id = ${run.run_id} AND status = 'discovered'
		LIMIT 1
	`[0]
	if (!target) {
		const provisionedCount =
			agent.sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM brain_team_invite_target
				WHERE run_id = ${run.run_id} AND status = 'provisioned'
			`[0]?.count ?? 0
		if (provisionedCount === 0) {
			agent.sql`
				UPDATE brain_team_invite_run
				SET status = 'done', schedule_id = NULL, updated_at = ${Date.now()}
				WHERE id = 1 AND run_id = ${run.run_id}
			`
			const finished = currentRun(agent)
			if (finished) await refreshCard(agent, botToken, finished, "done")
			return
		}
		agent.sql`
			UPDATE brain_team_invite_run
			SET status = 'preparing', updated_at = ${Date.now()}
			WHERE id = 1 AND run_id = ${run.run_id}
		`
		const preparing = currentRun(agent)
		if (preparing) await refreshCard(agent, botToken, preparing, "running")
		const starters = await waveStarters(agent, ws.orgId, ws.orgName)
		const current = currentRun(agent)
		if (current?.run_id !== run.run_id || current.status !== "preparing") return
		agent.sql`
			UPDATE brain_team_invite_run
			SET status = 'running',
				starters_json = ${starters ? JSON.stringify(starters) : null},
				updated_at = ${Date.now()}
			WHERE id = 1 AND run_id = ${run.run_id}
		`
		const running = currentRun(agent)
		if (running) await refreshCard(agent, botToken, running, "running")
		await scheduleTeamInviteCallback(
			agent,
			run.run_id,
			"runTeamInviteStep",
			STEP_DELAY_SECONDS,
		)
		return
	}

	const currentProfile = await lookupSlackUserInfo(
		botToken,
		target.slack_user_id,
	)
	if (!currentProfile.ok) {
		if (currentProfile.reason === "slack_api_error") {
			if (currentProfile.retryAfterSeconds) {
				await scheduleTeamInviteCallback(
					agent,
					run.run_id,
					"runTeamInviteProvisionStep",
					currentProfile.retryAfterSeconds,
				)
				return
			}
			const attempts = target.attempts + 1
			const giveUp = attempts >= MAX_TARGET_ATTEMPTS
			agent.sql`
				UPDATE brain_team_invite_target
				SET attempts = ${attempts},
					status = ${giveUp ? "skipped" : "discovered"},
					last_error = ${currentProfile.error ?? currentProfile.reason}
				WHERE run_id = ${run.run_id}
					AND slack_user_id = ${target.slack_user_id}
			`
			if (giveUp) {
				agent.sql`
					UPDATE brain_team_invite_run
					SET skipped = skipped + 1, updated_at = ${Date.now()}
					WHERE id = 1 AND run_id = ${run.run_id}
				`
			}
		} else {
			skipActiveTeamInviteTarget(
				agent,
				run.team_id,
				target.slack_user_id,
				currentProfile.reason,
			)
		}
		await scheduleTeamInviteCallback(
			agent,
			run.run_id,
			"runTeamInviteProvisionStep",
			STEP_DELAY_SECONDS,
		)
		return
	}
	const eligible = isEligibleFullMember(
		{ id: target.slack_user_id, ...currentProfile.user },
		ws.botUserId,
		run.team_id,
	)
	if (!eligible || !currentProfile.user.email) {
		skipActiveTeamInviteTarget(
			agent,
			run.team_id,
			target.slack_user_id,
			eligible ? "missing_slack_email" : "slack_member_ineligible",
		)
		await scheduleTeamInviteCallback(
			agent,
			run.run_id,
			"runTeamInviteProvisionStep",
			STEP_DELAY_SECONDS,
		)
		return
	}

	try {
		const provisioned = await provisionSlackWorkspaceMember(
			brainAgent(agent).env,
			{
				teamId: run.team_id,
				slackUserId: target.slack_user_id,
				orgId: agent.name,
				email: currentProfile.user.email,
				name:
					currentProfile.user.displayName ??
					currentProfile.user.name ??
					undefined,
			},
		)
		agent.sql`
			UPDATE brain_team_invite_target
			SET status = 'provisioned',
				supermemory_user_id = ${provisioned.userId},
				last_error = NULL
			WHERE run_id = ${run.run_id}
				AND slack_user_id = ${target.slack_user_id}
		`
	} catch (error) {
		const attempts = target.attempts + 1
		const giveUp = attempts >= MAX_TARGET_ATTEMPTS
		agent.sql`
			UPDATE brain_team_invite_target
			SET attempts = ${attempts},
				status = ${giveUp ? "skipped" : "discovered"},
				last_error = ${
					error instanceof Error ? error.message.slice(0, 500) : String(error)
				}
			WHERE run_id = ${run.run_id}
				AND slack_user_id = ${target.slack_user_id}
		`
		if (giveUp) {
			agent.sql`
				UPDATE brain_team_invite_run
				SET skipped = skipped + 1, updated_at = ${Date.now()}
				WHERE id = 1 AND run_id = ${run.run_id}
			`
		}
	}

	await scheduleTeamInviteCallback(
		agent,
		run.run_id,
		"runTeamInviteProvisionStep",
		STEP_DELAY_SECONDS,
	)
}

export async function startTeamInviteWave(
	agent: CompanyBrainAgent,
	payload: TeamInviteStart,
): Promise<void> {
	ensureTeamInviteTables(agent)
	// Synchronous claim before the first await: concurrent/replayed clicks would
	// otherwise each pass the busy check, generate paid starters, and clobber
	// each other's run row.
	const prior = currentRun(agent)
	const priorBusy = [
		"enumerating",
		"provisioning",
		"preparing",
		"running",
	].includes(prior?.status ?? "")
	const now = Date.now()
	const runId = generateId()
	if (!priorBusy) {
		agent.sql`
			INSERT INTO brain_team_invite_run (
				id, run_id, team_id, mode, status, sent, skipped, total,
				card_channel, card_ts, starters_json, failure_count, directory_cursor,
				requested_by_slack_user_id, schedule_id, created_at, updated_at
			) VALUES (
				1, ${runId}, ${payload.teamId}, ${payload.mode}, 'preparing', 0, 0, 0,
				${payload.cardChannel}, ${payload.cardTs ?? null}, NULL, 0, NULL,
				${payload.requestedBySlackUserId}, NULL, ${now}, ${now}
			)
			ON CONFLICT(id) DO UPDATE SET
				run_id = excluded.run_id, team_id = excluded.team_id,
				mode = excluded.mode, status = excluded.status,
				sent = 0, skipped = 0, deduped = 0, total = 0,
				card_channel = excluded.card_channel, card_ts = excluded.card_ts,
				starters_json = NULL, failure_count = 0, directory_cursor = NULL,
				requested_by_slack_user_id = excluded.requested_by_slack_user_id,
				schedule_id = NULL,
				created_at = excluded.created_at, updated_at = excluded.updated_at
		`
	}
	const abortClaim = () => {
		agent.sql`
			UPDATE brain_team_invite_run
			SET status = 'aborted', schedule_id = NULL, updated_at = ${Date.now()}
			WHERE id = 1 AND run_id = ${runId}
		`
	}

	const env = brainAgent(agent).env
	const ws = await getWorkspaceByTeamId(env, payload.teamId)
	if (!ws || ws.orgId !== agent.name) {
		if (!priorBusy) abortClaim()
		return
	}
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)

	const ephemeral = (text: string) =>
		postSlackEphemeral(
			botToken,
			payload.cardChannel,
			payload.requestedBySlackUserId,
			text,
		)

	if (priorBusy) {
		await ephemeral(
			"I'm already working through the invites. I'll keep the card updated.",
		)
		return
	}
	const abort = async (message?: string) => {
		abortClaim()
		if (message) await ephemeral(message)
	}

	const inviteEntitlement = await getCompanyBrainEntitlement(
		env,
		ws.orgId,
		(promise) => agent.waitUntil(promise),
	)
	if (!inviteEntitlement.allowed) {
		await abort(
			`I can't invite the team right now. ${companyBrainDenialMessage(
				inviteEntitlement.reason,
				env,
				companyBrainActivateUrl(env),
			)}`,
		)
		return
	}

	const profile = await lookupSlackUserInfo(
		botToken,
		payload.requestedBySlackUserId,
	)
	const actor = profile.ok
		? (
				await getOrgActorBySlackIdentity(env, {
					orgId: ws.orgId,
					teamId: payload.teamId,
					slackUserId: payload.requestedBySlackUserId,
					email: profile.user.email,
				})
			).actor
		: null
	if (!profile.ok || !actor?.isAdmin) {
		await abort("Only a Company Brain organization admin can invite the team.")
		return
	}

	let candidates: string[]
	let truncated = false
	if (payload.mode === "selected") {
		// Picker payloads are attacker-shapeable: cap server-side; per-user
		// eligibility (guest/bot/stranger/foreign-team) re-checks at send time.
		candidates = [...new Set(payload.userIds ?? [])].slice(0, MAX_WAVE_MEMBERS)
	} else {
		const directory = await getSlackTeamDirectory(botToken, MAX_WAVE_MEMBERS)
		truncated = directory.length >= MAX_WAVE_MEMBERS
		if (truncated) {
			console.warn(
				`[slack] team invite directory truncated at ${MAX_WAVE_MEMBERS} team=${payload.teamId}`,
			)
		}
		candidates = []
		for (const m of directory) {
			if (isEligibleFullMember(m, ws.botUserId, payload.teamId))
				candidates.push(m.id)
		}
	}
	candidates = candidates.filter(
		(id) =>
			id !== payload.requestedBySlackUserId &&
			!memberNotificationComplete(agent, id),
	)
	if (!candidates.length) {
		await abort(
			payload.mode === "all"
				? "Everyone eligible has already been notified. 🎉"
				: "Those teammates have already been notified. 🎉",
		)
		return
	}

	const starters = await waveStarters(agent, ws.orgId, ws.orgName)
	// Another claim may have superseded this one while awaiting; never clobber it.
	const claimed = currentRun(agent)
	if (claimed?.run_id !== runId) return
	agent.sql`DELETE FROM brain_team_invite_target`
	agent.sql`
		UPDATE brain_team_invite_run
		SET status = 'running', total = ${candidates.length},
			starters_json = ${starters ? JSON.stringify(starters) : null},
			updated_at = ${Date.now()}
		WHERE id = 1 AND run_id = ${runId}
	`
	for (const id of candidates) {
		// Slack requires client_msg_id to be a UUID; persist it so retries after
		// ambiguous failures reuse the same key (same pattern as the rollout).
		agent.sql`
			INSERT INTO brain_team_invite_target (run_id, slack_user_id, status, attempts, client_msg_id)
			VALUES (${runId}, ${id}, 'pending', 0, ${crypto.randomUUID()})
			ON CONFLICT(run_id, slack_user_id) DO NOTHING
		`
	}
	await ephemeral(
		`On it — DMing ${candidates.length} teammate${candidates.length === 1 ? "" : "s"} a personal intro. Guests are skipped and nobody gets messaged twice.${truncated ? ` Note: I could only load the first ${MAX_WAVE_MEMBERS} workspace members, so some teammates beyond that aren't covered — use the picker for anyone missed.` : ""}`,
	)
	const run = currentRun(agent)
	if (run) await refreshCard(agent, botToken, run, "running")
	await agent.schedule(STEP_DELAY_SECONDS, "runTeamInviteStep", { runId })
}

async function sendMemberIntro(
	agent: CompanyBrainAgent,
	args: {
		botToken: string
		teamId: string
		orgName: string | null
		slackUserId: string
		supermemoryUserId?: string | null
		starters: string[] | null
		clientMessageId?: string | null
	},
): Promise<{ ok: true } | { ok: false; retryAfterSeconds?: number }> {
	const info = await lookupSlackUserInfo(args.botToken, args.slackUserId)
	if (!info.ok) {
		return { ok: false, retryAfterSeconds: info.retryAfterSeconds }
	}
	if (info.user.isBot || info.user.isRestricted) return { ok: false }
	// Picker payloads can name Slack Connect / external users; never DM anyone
	// whose home workspace isn't the installing one.
	if (
		info.user.isStranger ||
		(info.user.teamId && info.user.teamId !== args.teamId)
	) {
		return { ok: false }
	}
	const channel = await openSlackConversation(args.botToken, args.slackUserId)
	if (!channel) return { ok: false }
	const connectActions = args.supermemoryUserId
		? MEMBER_CONNECT_SLUGS.map((slug) => ({
				slug,
				label: mcpAppDisplayName(slug),
			}))
		: []
	const home = getHomeChannel(agent)
	const parts = {
		firstName: firstNameOf(info.user.displayName || info.user.name),
		companyName: args.orgName,
		homeChannelId: home?.channelId,
		starters: args.starters,
		teamId: args.teamId,
		hasConnectActions: connectActions.length > 0,
	}
	if (!args.clientMessageId) {
		const ts = await postSlackMessage(
			args.botToken,
			channel,
			memberIntroText(parts),
			undefined,
			memberIntroBlocks(parts, connectActions),
		)
		return ts ? { ok: true } : { ok: false }
	}
	const res = await postSlackMessageIdempotent(
		args.botToken,
		channel,
		memberIntroText(parts),
		args.clientMessageId,
		memberIntroBlocks(parts, connectActions),
	)
	if (res.ok) return { ok: true }
	return { ok: false, retryAfterSeconds: res.retryAfterSeconds }
}

// One DM per alarm tick; 429s reschedule with Slack's Retry-After instead of sleeping.
export async function runTeamInviteStep(
	agent: CompanyBrainAgent,
	payload: TeamInvitePayload,
	schedule?: Schedule<TeamInvitePayload>,
): Promise<void> {
	ensureTeamInviteTables(agent)
	const run = currentRun(agent)
	if (
		!run ||
		run.run_id !== payload.runId ||
		run.status !== "running" ||
		!ownsTeamInviteSchedule(run, schedule)
	) {
		return
	}
	const env = brainAgent(agent).env
	const ws = await getWorkspaceByTeamId(env, run.team_id)
	if (!ws || ws.orgId !== agent.name) {
		failOwnedTeamInviteCallback(
			agent,
			payload,
			schedule,
			"workspace_missing_or_rebound",
		)
		return
	}
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)

	if (
		!(await orgCanRunCompanyBrain(env, ws.orgId, (promise) =>
			agent.waitUntil(promise),
		))
	) {
		console.log(
			`[slack] team invite wave blocked: entitlement org=${agent.name} run=${run.run_id}`,
		)
		agent.sql`
			UPDATE brain_team_invite_run
			SET status = 'failed', schedule_id = NULL,
				updated_at = ${Date.now()} WHERE id = 1
				AND run_id = ${run.run_id}
		`
		const blocked = currentRun(agent)
		if (blocked?.run_id === run.run_id) {
			await refreshCard(agent, botToken, blocked, "failed")
		}
		return
	}

	const targetStatus = run.mode === "automatic" ? "provisioned" : "pending"
	const target = agent.sql<{
		slack_user_id: string
		attempts: number
		client_msg_id: string | null
		supermemory_user_id: string | null
	}>`
		SELECT slack_user_id, attempts, client_msg_id, supermemory_user_id
		FROM brain_team_invite_target
		WHERE run_id = ${run.run_id}
			AND status = ${targetStatus}
		LIMIT 1
	`[0]
	if (!target) {
		agent.sql`
			UPDATE brain_team_invite_run
			SET status = 'done', schedule_id = NULL,
				updated_at = ${Date.now()} WHERE id = 1
				AND run_id = ${run.run_id}
		`
		const finished = currentRun(agent)
		if (finished?.run_id === run.run_id) {
			await refreshCard(agent, botToken, finished, "done")
		}
		return
	}

	if (run.mode === "automatic") {
		const home = getHomeChannel(agent)
		if (!home?.channelId) {
			const skipped = agent.sql<{ slack_user_id: string }>`
				UPDATE brain_team_invite_target
				SET status = 'skipped', last_error = 'missing_home_channel'
				WHERE run_id = ${run.run_id}
					AND slack_user_id = ${target.slack_user_id}
					AND status = ${targetStatus}
				RETURNING slack_user_id
			`
			if (skipped[0]) {
				agent.sql`
					UPDATE brain_team_invite_run
					SET skipped = skipped + 1, updated_at = ${Date.now()}
					WHERE id = 1 AND run_id = ${run.run_id}
				`
			}
			await scheduleTeamInviteCallback(
				agent,
				run.run_id,
				"runTeamInviteStep",
				STEP_DELAY_SECONDS,
			)
			return
		}
		const invited = await inviteSlackUserToChannel(
			botToken,
			home.channelId,
			target.slack_user_id,
		)
		if (!invited.ok) {
			if (invited.retryAfterSeconds) {
				await scheduleTeamInviteCallback(
					agent,
					run.run_id,
					"runTeamInviteStep",
					invited.retryAfterSeconds,
				)
				return
			}
			const attempts = target.attempts + 1
			const giveUp = attempts >= MAX_TARGET_ATTEMPTS
			const transitioned = agent.sql<{ slack_user_id: string }>`
				UPDATE brain_team_invite_target
				SET attempts = ${attempts},
					status = ${giveUp ? "skipped" : "provisioned"},
					last_error = ${invited.error.slice(0, 500)}
				WHERE run_id = ${run.run_id}
					AND slack_user_id = ${target.slack_user_id}
					AND status = ${targetStatus}
				RETURNING slack_user_id
			`
			if (giveUp && transitioned[0]) {
				agent.sql`
					UPDATE brain_team_invite_run
					SET skipped = skipped + 1, updated_at = ${Date.now()}
					WHERE id = 1 AND run_id = ${run.run_id}
				`
			}
			await scheduleTeamInviteCallback(
				agent,
				run.run_id,
				"runTeamInviteStep",
				STEP_DELAY_SECONDS,
			)
			return
		}
	}

	const notificationClaim = claimMemberNotification(
		agent,
		target.slack_user_id,
		target.client_msg_id ?? crypto.randomUUID(),
	)
	if (notificationClaim.status === "complete") {
		const deduped = agent.sql<{ slack_user_id: string }>`
			UPDATE brain_team_invite_target
			SET status = 'deduped', last_error = NULL
			WHERE run_id = ${run.run_id}
				AND slack_user_id = ${target.slack_user_id}
				AND status = ${targetStatus}
			RETURNING slack_user_id
		`
		if (deduped[0]) {
			agent.sql`
				UPDATE brain_team_invite_run
				SET deduped = deduped + 1, updated_at = ${Date.now()}
				WHERE id = 1 AND run_id = ${run.run_id}
			`
		}
		await scheduleTeamInviteCallback(
			agent,
			run.run_id,
			"runTeamInviteStep",
			STEP_DELAY_SECONDS,
		)
		return
	}
	const claimedTarget = agent.sql<{ slack_user_id: string }>`
		UPDATE brain_team_invite_target
		SET client_msg_id = ${notificationClaim.clientMessageId}
		WHERE run_id = ${run.run_id}
			AND slack_user_id = ${target.slack_user_id}
			AND status = ${targetStatus}
		RETURNING slack_user_id
	`
	if (!claimedTarget[0]) {
		await scheduleTeamInviteCallback(
			agent,
			run.run_id,
			"runTeamInviteStep",
			STEP_DELAY_SECONDS,
		)
		return
	}

	const result = await sendMemberIntro(agent, {
		botToken,
		teamId: run.team_id,
		orgName: ws.orgName,
		slackUserId: target.slack_user_id,
		supermemoryUserId: target.supermemory_user_id,
		starters: parseStarters(run.starters_json),
		clientMessageId: notificationClaim.clientMessageId,
	}).catch(() => ({ ok: false as const }))

	if (result.ok) {
		completeMemberNotification(
			agent,
			target.slack_user_id,
			notificationClaim.clientMessageId,
			`invite_${run.mode}`,
		)
		const sent = agent.sql<{ slack_user_id: string }>`
			UPDATE brain_team_invite_target SET status = 'sent'
			WHERE run_id = ${run.run_id}
				AND slack_user_id = ${target.slack_user_id}
				AND status = ${targetStatus}
			RETURNING slack_user_id
		`
		if (sent[0]) {
			agent.sql`
				UPDATE brain_team_invite_run
				SET sent = sent + 1, updated_at = ${Date.now()}
				WHERE id = 1 AND run_id = ${run.run_id}
			`
		}
	} else if ("retryAfterSeconds" in result && result.retryAfterSeconds) {
		await scheduleTeamInviteCallback(
			agent,
			run.run_id,
			"runTeamInviteStep",
			result.retryAfterSeconds,
		)
		return
	} else {
		const attempts = target.attempts + 1
		const giveUp = attempts >= MAX_TARGET_ATTEMPTS
		const transitioned = agent.sql<{ slack_user_id: string }>`
			UPDATE brain_team_invite_target
			SET attempts = ${attempts},
				status = ${giveUp ? "skipped" : targetStatus}
			WHERE run_id = ${run.run_id}
				AND slack_user_id = ${target.slack_user_id}
				AND status = ${targetStatus}
			RETURNING slack_user_id
		`
		if (giveUp && transitioned[0]) {
			agent.sql`
				UPDATE brain_team_invite_run
				SET skipped = skipped + 1, updated_at = ${Date.now()}
				WHERE id = 1 AND run_id = ${run.run_id}
			`
		}
	}

	const updated = currentRun(agent)
	if (
		updated?.run_id === run.run_id &&
		(updated.mode !== "automatic" ||
			(updated.sent + updated.skipped + updated.deduped) % 25 === 0)
	) {
		await refreshCard(agent, botToken, updated, "running")
	}
	await scheduleTeamInviteCallback(
		agent,
		run.run_id,
		"runTeamInviteStep",
		STEP_DELAY_SECONDS,
	)
}

// Soft-hello for later joiners. Silent until the org has run any team invite,
// so workspaces that never opted into outreach stay quiet.
// Returns true on a terminal outcome (delivered or permanently ineligible) so
// the event route only dedups then; transient failures leave Slack free to retry.
async function processSlackTeamJoin(
	agent: CompanyBrainAgent,
	payload: SlackTeamJoinPayload,
): Promise<SlackLifecycleOutcome> {
	try {
		ensureTeamInviteTables(agent)
		const user = payload.user
		if (
			user.deleted ||
			user.is_bot ||
			user.is_restricted ||
			user.is_ultra_restricted ||
			user.is_stranger ||
			(user.team_id && user.team_id !== payload.teamId)
		) {
			return TERMINAL_LIFECYCLE_OUTCOME
		}
		// Lifecycle onboarding starts only after this workspace has claimed an
		// automatic rollout (or a legacy admin-triggered wave).
		const run = currentRun(agent)
		const legacyLifecycleEnabled =
			run?.team_id === payload.teamId &&
			run.mode !== "automatic" &&
			(run.status === "running" || run.status === "done")
		if (
			!automaticLifecycleEnabled(agent, payload.teamId) &&
			!legacyLifecycleEnabled
		) {
			return TERMINAL_LIFECYCLE_OUTCOME
		}
		const env = brainAgent(agent).env
		const ws = await getWorkspaceByTeamId(env, payload.teamId)
		if (!ws || ws.orgId !== agent.name || user.id === ws.botUserId) {
			return TERMINAL_LIFECYCLE_OUTCOME
		}
		if (
			!(await orgCanRunCompanyBrain(env, ws.orgId, (promise) =>
				agent.waitUntil(promise),
			))
		) {
			return TERMINAL_LIFECYCLE_OUTCOME
		}
		const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
		const profile = await lookupSlackUserInfo(botToken, user.id)
		if (!profile.ok) {
			return retryLifecycleOutcome(profile.retryAfterSeconds)
		}
		if (
			profile.user.isBot ||
			profile.user.isRestricted ||
			profile.user.isUltraRestricted ||
			profile.user.isStranger ||
			(profile.user.teamId && profile.user.teamId !== payload.teamId)
		) {
			return TERMINAL_LIFECYCLE_OUTCOME
		}
		if (!profile.user.email) return retryLifecycleOutcome()
		const provisioned = await provisionSlackWorkspaceMember(env, {
			teamId: payload.teamId,
			slackUserId: user.id,
			orgId: ws.orgId,
			email: profile.user.email,
			name: profile.user.displayName ?? profile.user.name,
		})
		const home = getHomeChannel(agent)
		if (!home?.channelId) return retryLifecycleOutcome()
		const invited = await inviteSlackUserToChannel(
			botToken,
			home.channelId,
			user.id,
		)
		if (!invited.ok) {
			return retryLifecycleOutcome(invited.retryAfterSeconds)
		}

		// Restore account/org/channel access before deduplicating the welcome DM.
		// This lets user_change re-onboard promoted or reactivated members without
		// sending a second introduction to someone already in the notification
		// ledger. The claim is intentionally after the entitlement check so an
		// inactive org cannot leave a stale pending notification behind.
		const notificationClaim = claimMemberNotification(
			agent,
			user.id,
			crypto.randomUUID(),
		)
		if (notificationClaim.status === "complete") {
			return TERMINAL_LIFECYCLE_OUTCOME
		}
		const result = await sendMemberIntro(agent, {
			botToken,
			teamId: payload.teamId,
			orgName: ws.orgName,
			slackUserId: user.id,
			supermemoryUserId: provisioned.userId,
			starters: parseStarters(
				run?.team_id === payload.teamId ? run.starters_json : null,
			),
			clientMessageId: notificationClaim.clientMessageId,
		})
		if (result.ok) {
			completeMemberNotification(
				agent,
				user.id,
				notificationClaim.clientMessageId,
				"team_join",
			)
			return TERMINAL_LIFECYCLE_OUTCOME
		}
		// Keep the pending claim (and its UUID) so Slack's redelivery retries
		// idempotently instead of double-sending.
		return retryLifecycleOutcome(result.retryAfterSeconds)
	} catch (err) {
		console.warn("[slack] team join hello failed:", err)
		return retryLifecycleOutcome()
	}
}

export async function onSlackTeamJoin(
	agent: CompanyBrainAgent,
	payload: SlackTeamJoinPayload,
): Promise<boolean> {
	const outcome = await processSlackTeamJoin(agent, payload)
	if (!outcome.terminal) {
		await agent.schedule(
			outcome.retryAfterSeconds ?? STEP_DELAY_SECONDS * 5,
			"runSlackTeamJoinRetry",
			{
				...payload,
				attempt: 1,
			},
		)
	}
	// Once a durable retry is scheduled, the HTTP event can be deduplicated.
	return true
}

export async function runSlackTeamJoinRetry(
	agent: CompanyBrainAgent,
	payload: SlackTeamJoinRetryPayload,
): Promise<void> {
	const outcome = await processSlackTeamJoin(agent, payload)
	if (outcome.terminal) return
	if (outcome.retryAfterSeconds || payload.attempt < MAX_TARGET_ATTEMPTS) {
		await agent.schedule(
			outcome.retryAfterSeconds ?? STEP_DELAY_SECONDS * 5 * payload.attempt,
			"runSlackTeamJoinRetry",
			{
				...payload,
				attempt: outcome.retryAfterSeconds
					? payload.attempt
					: payload.attempt + 1,
			},
		)
	}
}

async function processSlackUserChange(
	agent: CompanyBrainAgent,
	payload: SlackUserChangePayload,
): Promise<SlackLifecycleOutcome> {
	ensureTeamInviteTables(agent)
	const user = payload.user
	const env = brainAgent(agent).env
	const ws = await getWorkspaceByTeamId(env, payload.teamId)
	if (!ws || ws.orgId !== agent.name) return TERMINAL_LIFECYCLE_OUTCOME
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	const currentProfile = await lookupSlackUserInfo(botToken, user.id)
	if (
		!currentProfile.ok &&
		(currentProfile.reason === "slack_api_error" ||
			currentProfile.reason === "missing_user_id")
	) {
		return retryLifecycleOutcome(currentProfile.retryAfterSeconds)
	}
	if (
		currentProfile.ok &&
		isEligibleFullMember(
			{ id: user.id, ...currentProfile.user },
			ws.botUserId,
			payload.teamId,
		)
	) {
		return processSlackTeamJoin(agent, {
			teamId: payload.teamId,
			user: {
				id: user.id,
				is_bot: currentProfile.user.isBot,
				is_restricted: currentProfile.user.isRestricted,
				is_ultra_restricted: currentProfile.user.isUltraRestricted,
				is_stranger: currentProfile.user.isStranger,
				team_id: currentProfile.user.teamId,
			},
		})
	}
	skipActiveTeamInviteTarget(
		agent,
		payload.teamId,
		user.id,
		"slack_member_revoked",
	)
	await revokeSlackWorkspaceMember(env, {
		teamId: payload.teamId,
		slackUserId: user.id,
		orgId: ws.orgId,
	})
	return TERMINAL_LIFECYCLE_OUTCOME
}

export async function onSlackUserChange(
	agent: CompanyBrainAgent,
	payload: SlackUserChangePayload,
): Promise<void> {
	try {
		const outcome = await processSlackUserChange(agent, payload)
		if (!outcome.terminal) {
			await agent.schedule(
				outcome.retryAfterSeconds ?? STEP_DELAY_SECONDS * 5,
				"runSlackUserChangeRetry",
				{
					...payload,
					attempt: 1,
				},
			)
		}
	} catch {
		await agent.schedule(STEP_DELAY_SECONDS * 5, "runSlackUserChangeRetry", {
			...payload,
			attempt: 1,
		})
	}
}

export async function runSlackUserChangeRetry(
	agent: CompanyBrainAgent,
	payload: SlackUserChangeRetryPayload,
): Promise<void> {
	try {
		const outcome = await processSlackUserChange(agent, payload)
		if (outcome.terminal) return
		if (!outcome.retryAfterSeconds && payload.attempt >= MAX_TARGET_ATTEMPTS) {
			return
		}
		await agent.schedule(
			outcome.retryAfterSeconds ?? STEP_DELAY_SECONDS * 5 * payload.attempt,
			"runSlackUserChangeRetry",
			{
				...payload,
				attempt: outcome.retryAfterSeconds
					? payload.attempt
					: payload.attempt + 1,
			},
		)
	} catch (error) {
		if (payload.attempt >= MAX_TARGET_ATTEMPTS) {
			console.error(
				`[slack] user_change lifecycle sync failed team=${payload.teamId} user=${payload.user.id}:`,
				error,
			)
			return
		}
		await agent.schedule(
			STEP_DELAY_SECONDS * 5 * payload.attempt,
			"runSlackUserChangeRetry",
			{ ...payload, attempt: payload.attempt + 1 },
		)
	}
}
