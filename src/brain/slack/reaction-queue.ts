import type { Schedule } from "agents"
import { decryptToken } from "@/lib/crypto"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { addSlackReactionDetailed, type SlackReactionAddResult } from "./client"
import {
	recordStoredActionOutcome,
	recordStoredSuppression,
	type SlackEventIdentity,
} from "./event-store"
import { type AckBreakerDecision, evaluateAckBreaker } from "./reaction-policy"
import {
	scheduleTriageOutcome,
	type TriageAckEmoji,
	type TriageObservabilityContext,
} from "./triage"
import { getWorkspaceByTeamId } from "./workspace"

export const REACTION_EXPIRY_MS = 10 * 60 * 1_000
// Agent schedules resolve at whole-second timestamps; 2-3s keeps the real
// spacing safely above one second even after timestamp flooring.
export const REACTION_MIN_DELAY_SECONDS = 2
export const REACTION_MAX_DELAY_SECONDS = 3
const REACTION_MAX_ATTEMPTS = 3
const REACTION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

export type ReactionQueuePayload = { queue: "passive_reaction" }
export type ReactionQueueKind = "ack" | "answer_fallback"

type ReactionQueueRow = {
	id: number
	team_id: string
	channel_id: string
	message_ts: string
	thread_ts: string | null
	emoji: TriageAckEmoji
	kind: ReactionQueueKind
	reason: string
	trace_id: string
	distinct_id: string
	session_id: string | null
	available_at: number
	expires_at: number
	attempts: number
}

type ReactionScheduleRow = { schedule_id: string }

export type EnqueueReactionResult =
	| { enqueued: true }
	| { enqueued: false; suppression: "breaker" | "dedup" }

export function ensureReactionQueueTables(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_reaction_outbox (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			team_id TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			message_ts TEXT NOT NULL,
			thread_ts TEXT,
			emoji TEXT NOT NULL,
			kind TEXT NOT NULL,
			reason TEXT NOT NULL,
			trace_id TEXT NOT NULL,
			distinct_id TEXT NOT NULL,
			session_id TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			created_at INTEGER NOT NULL,
			available_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			UNIQUE (team_id, channel_id, message_ts, emoji)
		)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_reaction_outbox_pending
		ON brain_reaction_outbox (status, available_at, id)
	`
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_reaction_breaker (
			channel_id TEXT PRIMARY KEY,
			hour_bucket INTEGER NOT NULL,
			ack_count INTEGER NOT NULL DEFAULT 0,
			open_until INTEGER NOT NULL DEFAULT 0
		)
	`
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_reaction_queue_schedule (
			queue_key TEXT PRIMARY KEY,
			schedule_id TEXT NOT NULL
		)
	`
}

function reserveAckReaction(
	agent: CompanyBrainAgent,
	channelId: string,
	nowMs: number,
): AckBreakerDecision {
	const row = agent.sql<{
		hour_bucket: number
		ack_count: number
		open_until: number
	}>`
		SELECT hour_bucket, ack_count, open_until
		FROM brain_reaction_breaker WHERE channel_id = ${channelId}
	`[0]
	const decision = evaluateAckBreaker(
		row
			? {
					bucket: row.hour_bucket,
					count: row.ack_count,
					openUntil: row.open_until,
				}
			: undefined,
		nowMs,
	)
	const next = decision.next
	agent.sql`
		INSERT INTO brain_reaction_breaker (
			channel_id, hour_bucket, ack_count, open_until
		) VALUES (
			${channelId}, ${next.bucket}, ${next.count}, ${next.openUntil}
		)
		ON CONFLICT(channel_id) DO UPDATE SET
			hour_bucket = excluded.hour_bucket,
			ack_count = excluded.ack_count,
			open_until = excluded.open_until
	`
	return decision
}

function randomQueueDelaySeconds(): number {
	return (
		REACTION_MIN_DELAY_SECONDS +
		Math.random() * (REACTION_MAX_DELAY_SECONDS - REACTION_MIN_DELAY_SECONDS)
	)
}

async function armReactionQueue(
	agent: CompanyBrainAgent,
	delaySeconds = randomQueueDelaySeconds(),
): Promise<void> {
	ensureReactionQueueTables(agent)
	const existing = agent.sql<ReactionScheduleRow>`
		SELECT schedule_id FROM brain_reaction_queue_schedule
		WHERE queue_key = ${"passive_reaction"}
	`[0]
	if (existing) return
	const scheduled = await agent.schedule(
		delaySeconds,
		"runPassiveReactionQueue",
		{
			queue: "passive_reaction",
		} satisfies ReactionQueuePayload,
		{ idempotent: true },
	)
	agent.sql`
		INSERT INTO brain_reaction_queue_schedule (queue_key, schedule_id)
		VALUES (${"passive_reaction"}, ${scheduled.id})
		ON CONFLICT(queue_key) DO NOTHING
	`
}

/** Re-arm durable pending work after a DO restart or a prior schedule failure. */
export async function recoverPassiveReactionQueue(
	agent: CompanyBrainAgent,
): Promise<void> {
	ensureReactionQueueTables(agent)
	const scheduleRow = agent.sql<ReactionScheduleRow>`
		SELECT schedule_id FROM brain_reaction_queue_schedule
		WHERE queue_key = ${"passive_reaction"}
	`[0]
	if (scheduleRow) {
		const durableSchedule = await agent.getScheduleById(scheduleRow.schedule_id)
		if (!durableSchedule) {
			agent.sql`
				DELETE FROM brain_reaction_queue_schedule
				WHERE queue_key = ${"passive_reaction"}
					AND schedule_id = ${scheduleRow.schedule_id}
			`
		}
	}
	const pending = agent.sql<{ id: number }>`
		SELECT id FROM brain_reaction_outbox
		WHERE status = ${"pending"}
		ORDER BY available_at ASC, id ASC
		LIMIT 1
	`[0]
	if (pending) await armReactionQueue(agent)
}

export async function enqueuePassiveReaction(
	agent: CompanyBrainAgent,
	args: {
		identity: SlackEventIdentity
		emoji: TriageAckEmoji
		kind: ReactionQueueKind
		reason: string
		obs: TriageObservabilityContext
		nowMs?: number
	},
): Promise<EnqueueReactionResult> {
	ensureReactionQueueTables(agent)
	const nowMs = args.nowMs ?? Date.now()
	agent.sql`
		DELETE FROM brain_reaction_outbox
		WHERE status != ${"pending"}
			AND created_at < ${nowMs - REACTION_RETENTION_MS}
	`
	const existing = agent.sql<{ id: number }>`
		SELECT id FROM brain_reaction_outbox
		WHERE team_id = ${args.identity.teamId}
			AND channel_id = ${args.identity.channel}
			AND message_ts = ${args.identity.messageTs}
			AND emoji = ${args.emoji}
	`[0]
	if (existing) {
		recordStoredSuppression(agent, args.identity, {
			suppression: "dedup",
			outcome: "reaction_deduplicated",
		})
		agent.waitUntil(
			captureReactionSuppression(args.obs, "dedup").catch(() => {}),
		)
		return { enqueued: false, suppression: "dedup" }
	}
	// The emergency threshold is specifically for model-selected ACK volume.
	// Answer fallbacks are already bounded by the speaking budget they replace.
	const breaker =
		args.kind === "ack"
			? reserveAckReaction(agent, args.identity.channel, nowMs)
			: undefined
	if (breaker && !breaker.allowed) {
		recordStoredSuppression(agent, args.identity, {
			suppression: "breaker",
			outcome: "reaction_breaker_open",
		})
		const telemetryReason = breaker.opened ? "breaker_tripped" : "breaker"
		if (breaker.opened) {
			console.error(
				`[company-brain] passive reaction breaker tripped channel=${args.identity.channel} trace=${args.obs.traceId}`,
			)
		} else {
			console.warn(
				`[company-brain] passive reaction breaker open channel=${args.identity.channel} trace=${args.obs.traceId}`,
			)
		}
		agent.waitUntil(
			captureReactionSuppression(args.obs, telemetryReason).catch(() => {}),
		)
		return { enqueued: false, suppression: "breaker" }
	}
	agent.sql`
		INSERT INTO brain_reaction_outbox (
			team_id, channel_id, message_ts, thread_ts, emoji, kind, reason,
			trace_id, distinct_id, session_id, status, created_at, available_at,
			expires_at, attempts
		) VALUES (
			${args.identity.teamId}, ${args.identity.channel},
			${args.identity.messageTs}, ${args.identity.threadTs ?? null},
			${args.emoji}, ${args.kind}, ${args.reason}, ${args.obs.traceId},
			${args.obs.distinctId}, ${args.obs.sessionId ?? null}, ${"pending"},
			${nowMs}, ${nowMs}, ${nowMs + REACTION_EXPIRY_MS}, 0
		)
	`
	recordStoredActionOutcome(agent, args.identity, "reaction_queued")
	console.log(
		`[company-brain] passive reaction queued kind=${args.kind} emoji=${args.emoji} trace=${args.obs.traceId} channel=${args.identity.channel} message=${args.identity.messageTs}`,
	)
	await armReactionQueue(agent)
	return { enqueued: true }
}

function rowIdentity(row: ReactionQueueRow): SlackEventIdentity {
	return {
		teamId: row.team_id,
		channel: row.channel_id,
		messageTs: row.message_ts,
		...(row.thread_ts ? { threadTs: row.thread_ts } : {}),
	}
}

function rowObs(
	row: ReactionQueueRow,
	orgId: string,
): TriageObservabilityContext {
	return {
		orgId,
		distinctId: row.distinct_id,
		traceId: row.trace_id,
		...(row.session_id ? { sessionId: row.session_id } : {}),
		channel: row.channel_id,
		messageTs: row.message_ts,
		...(row.thread_ts ? { threadTs: row.thread_ts } : {}),
		chimeContext: row.thread_ts ? "thread" : "channel",
	}
}

function retryDelaySeconds(
	result: SlackReactionAddResult,
	attempts: number,
): number {
	if (!result.ok && result.retryAfterSeconds) return result.retryAfterSeconds
	return Math.min(30, 2 ** Math.max(1, attempts))
}

async function captureReactionSuppression(
	obs: TriageObservabilityContext,
	reason: string,
): Promise<void> {
	const { captureBrainProactivitySuppression } = await import(
		"../observability"
	)
	await captureBrainProactivitySuppression({ ...obs, reason })
}

export async function runPassiveReactionQueue(
	agent: CompanyBrainAgent,
	_payload: ReactionQueuePayload,
	schedule: Schedule<ReactionQueuePayload>,
): Promise<void> {
	ensureReactionQueueTables(agent)
	const scheduled = agent.sql<ReactionScheduleRow>`
		SELECT schedule_id FROM brain_reaction_queue_schedule
		WHERE queue_key = ${"passive_reaction"}
	`[0]
	if (!scheduled || scheduled.schedule_id !== schedule.id) return
	agent.sql`
		DELETE FROM brain_reaction_queue_schedule
		WHERE queue_key = ${"passive_reaction"} AND schedule_id = ${schedule.id}
	`

	const nowMs = Date.now()
	const row = agent.sql<ReactionQueueRow>`
		SELECT id, team_id, channel_id, message_ts, thread_ts, emoji, kind,
			reason, trace_id, distinct_id, session_id, available_at, expires_at,
			attempts
		FROM brain_reaction_outbox
		WHERE status = ${"pending"}
		ORDER BY available_at ASC, id ASC
		LIMIT 1
	`[0]
	if (!row) return
	if (row.expires_at <= nowMs) {
		agent.sql`
			UPDATE brain_reaction_outbox SET status = ${"expired"},
				last_error = ${"stale"}
			WHERE id = ${row.id}
		`
		recordStoredActionOutcome(agent, rowIdentity(row), "reaction_expired")
		console.log(
			`[company-brain] passive reaction expired kind=${row.kind} emoji=${row.emoji} trace=${row.trace_id} channel=${row.channel_id} message=${row.message_ts}`,
		)
		await armReactionQueue(agent)
		return
	}
	if (row.available_at > nowMs) {
		await armReactionQueue(
			agent,
			Math.max(1, Math.ceil((row.available_at - nowMs) / 1_000)),
		)
		return
	}

	let result: SlackReactionAddResult = {
		ok: false,
		error: "request_failed",
	}
	const ws = await getWorkspaceByTeamId(
		brainAgent(agent).env,
		row.team_id,
	).catch(() => null)
	if (ws && ws.orgId !== agent.name) {
		const attempts = row.attempts + 1
		agent.sql`
			UPDATE brain_reaction_outbox SET status = ${"failed"},
				attempts = ${attempts}, last_error = ${"workspace_org_mismatch"}
			WHERE id = ${row.id}
		`
		recordStoredSuppression(agent, rowIdentity(row), {
			suppression: "workspace_org_mismatch",
			outcome: "reaction_dropped_workspace_rebound",
		})
		console.error(
			`[company-brain] passive reaction dropped: workspace rebound team=${row.team_id} queuedOrg=${agent.name} currentOrg=${ws.orgId} trace=${row.trace_id}`,
		)
		agent.waitUntil(
			captureReactionSuppression(
				rowObs(row, agent.name),
				"workspace_org_mismatch",
			).catch(() => {}),
		)
		await armReactionQueue(agent)
		return
	}
	if (ws) {
		try {
			const botToken = await decryptToken(
				ws.botTokenEnc,
				brainAgent(agent).env.ENCRYPTION_SECRET,
			)
			result = await addSlackReactionDetailed(
				botToken,
				row.channel_id,
				row.message_ts,
				row.emoji,
			)
		} catch {
			result = { ok: false, error: "request_failed" }
		}
	}
	const attempts = row.attempts + 1
	if (result.ok) {
		agent.sql`
			UPDATE brain_reaction_outbox SET status = ${"delivered"},
				attempts = ${attempts}, last_error = NULL
			WHERE id = ${row.id}
		`
		recordStoredActionOutcome(agent, rowIdentity(row), result.outcome)
		console.log(
			`[company-brain] passive reaction delivered kind=${row.kind} emoji=${row.emoji} outcome=${result.outcome} trace=${row.trace_id} channel=${row.channel_id} message=${row.message_ts}`,
		)
		if (row.kind === "ack" && ws) {
			scheduleTriageOutcome(agent, rowObs(row, ws.orgId), {
				decision: "ack",
				emoji: row.emoji,
				reason: row.reason,
				outcome: result.outcome,
			})
		}
	} else if (
		attempts < REACTION_MAX_ATTEMPTS &&
		(result.error === "ratelimited" || result.error === "request_failed")
	) {
		const availableAt = nowMs + retryDelaySeconds(result, attempts) * 1_000
		agent.sql`
			UPDATE brain_reaction_outbox SET attempts = ${attempts},
				available_at = ${availableAt}, last_error = ${result.error}
			WHERE id = ${row.id}
		`
	} else {
		agent.sql`
			UPDATE brain_reaction_outbox SET status = ${"failed"},
				attempts = ${attempts}, last_error = ${result.error}
			WHERE id = ${row.id}
		`
		recordStoredActionOutcome(agent, rowIdentity(row), "reaction_failed")
		console.warn(
			`[company-brain] passive reaction failed kind=${row.kind} emoji=${row.emoji} error=${result.error} trace=${row.trace_id} channel=${row.channel_id} message=${row.message_ts}`,
		)
		if (row.kind === "ack" && ws) {
			scheduleTriageOutcome(agent, rowObs(row, ws.orgId), {
				decision: "ack",
				emoji: row.emoji,
				reason: row.reason,
				outcome: "failed",
				error: result.error,
			})
		}
	}
	await armReactionQueue(agent)
}
