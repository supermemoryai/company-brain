import type { CompanyBrainAgent } from "../turn/agent"
import type { StoredTriagePriority } from "./event-store"

const HOUR_MS = 60 * 60 * 1_000

export const CHIME_ABSOLUTE_MAX_PER_HOUR = 12
export const CHIME_SUMMONS_MAX_PER_HOUR = 4
export const CHIME_GENERAL_MAX_PER_HOUR = 6
export const CHIME_LOW_MAX_PER_HOUR = 2
export const CHIME_NORMAL_MIN_INTERVAL_MS = 3 * 60 * 1_000
export const CHIME_LOW_QUIET_INTERVAL_MS = 15 * 60 * 1_000
export const PASSIVE_INVESTIGATION_MAX_CONCURRENT = 2
export const PASSIVE_INVESTIGATION_MAX_PER_HOUR = 6
export const PASSIVE_INVESTIGATION_LEASE_MS = 10 * 60 * 1_000
const PASSIVE_INVESTIGATION_RETENTION_MS = 7 * 24 * HOUR_MS

export type ChimeBudgetSuppression =
	| "budget_min_interval"
	| "budget_priority_allowance"
	| "budget_ceiling"

export type ChimeBudgetState = {
	bucket: number
	total: number
	summons: number
	general: number
	low: number
	lastReplyAt: number
	lastNormalReplyAt: number
}

export type ChimeBudgetDecision =
	| { allowed: true; next: ChimeBudgetState }
	| { allowed: false; suppression: ChimeBudgetSuppression }

export function canUseAnswerFallback(
	suppression: ChimeBudgetSuppression,
	hasExplicitFallback: boolean,
	priority: StoredTriagePriority,
): boolean {
	return (
		priority === "normal" &&
		suppression === "budget_min_interval" &&
		hasExplicitFallback
	)
}

export function emptyChimeBudgetState(nowMs: number): ChimeBudgetState {
	return {
		bucket: Math.floor(nowMs / HOUR_MS),
		total: 0,
		summons: 0,
		general: 0,
		low: 0,
		lastReplyAt: 0,
		lastNormalReplyAt: 0,
	}
}

/** Pure priority matrix, exported so the policy can be exhaustively unit-tested. */
export function evaluateChimeBudget(args: {
	state: ChimeBudgetState
	priority: StoredTriagePriority
	nowMs: number
	/** Most recent human channel activity before the triggering message. */
	lastChannelActivityAt?: number
	/** Urgent findings pay only the absolute speech ceiling after silent work. */
	urgentInvestigationFinding?: boolean
}): ChimeBudgetDecision {
	const currentBucket = Math.floor(args.nowMs / HOUR_MS)
	const state =
		args.state.bucket === currentBucket
			? args.state
			: {
					...emptyChimeBudgetState(args.nowMs),
					lastReplyAt: args.state.lastReplyAt,
					lastNormalReplyAt: args.state.lastNormalReplyAt,
				}

	if (state.total >= CHIME_ABSOLUTE_MAX_PER_HOUR) {
		return { allowed: false, suppression: "budget_ceiling" }
	}

	if (args.priority === "summons") {
		if (state.summons >= CHIME_SUMMONS_MAX_PER_HOUR) {
			return { allowed: false, suppression: "budget_priority_allowance" }
		}
		return {
			allowed: true,
			next: {
				...state,
				total: state.total + 1,
				summons: state.summons + 1,
				lastReplyAt: args.nowMs,
			},
		}
	}

	if (args.priority === "urgent" && args.urgentInvestigationFinding === true) {
		return {
			allowed: true,
			next: {
				...state,
				total: state.total + 1,
				lastReplyAt: args.nowMs,
			},
		}
	}

	if (args.priority === "urgent") {
		if (state.general >= CHIME_GENERAL_MAX_PER_HOUR) {
			return { allowed: false, suppression: "budget_priority_allowance" }
		}
		return {
			allowed: true,
			next: {
				...state,
				total: state.total + 1,
				general: state.general + 1,
				lastReplyAt: args.nowMs,
			},
		}
	}

	if (args.priority === "normal") {
		if (
			state.lastNormalReplyAt > 0 &&
			args.nowMs - state.lastNormalReplyAt < CHIME_NORMAL_MIN_INTERVAL_MS
		) {
			return { allowed: false, suppression: "budget_min_interval" }
		}
		if (state.general >= CHIME_GENERAL_MAX_PER_HOUR) {
			return { allowed: false, suppression: "budget_priority_allowance" }
		}
		return {
			allowed: true,
			next: {
				...state,
				total: state.total + 1,
				general: state.general + 1,
				lastReplyAt: args.nowMs,
				lastNormalReplyAt: args.nowMs,
			},
		}
	}

	if (
		args.lastChannelActivityAt !== undefined &&
		args.nowMs - args.lastChannelActivityAt < CHIME_LOW_QUIET_INTERVAL_MS
	) {
		return { allowed: false, suppression: "budget_min_interval" }
	}
	if (state.low >= CHIME_LOW_MAX_PER_HOUR) {
		return { allowed: false, suppression: "budget_priority_allowance" }
	}
	return {
		allowed: true,
		next: {
			...state,
			total: state.total + 1,
			low: state.low + 1,
			lastReplyAt: args.nowMs,
		},
	}
}

type ChimeBudgetRow = {
	hour_bucket: number
	total_count: number
	summons_count: number
	general_count: number
	low_count: number
	last_reply_at: number
	last_normal_reply_at: number
}

export function ensureChimeBudgetTables(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_chime_budget (
			channel_id TEXT PRIMARY KEY,
			hour_bucket INTEGER NOT NULL,
			total_count INTEGER NOT NULL DEFAULT 0,
			summons_count INTEGER NOT NULL DEFAULT 0,
			general_count INTEGER NOT NULL DEFAULT 0,
			low_count INTEGER NOT NULL DEFAULT 0,
			last_reply_at INTEGER NOT NULL DEFAULT 0,
			last_normal_reply_at INTEGER NOT NULL DEFAULT 0
		)
	`
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_passive_investigation (
			trace_id TEXT PRIMARY KEY,
			channel_id TEXT NOT NULL,
			priority TEXT NOT NULL,
			status TEXT NOT NULL,
			started_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			hour_bucket INTEGER NOT NULL
		)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_passive_investigation_status
		ON brain_passive_investigation (status, expires_at)
	`
}

function readBudgetState(
	agent: CompanyBrainAgent,
	channelId: string,
	nowMs: number,
): ChimeBudgetState {
	const row = agent.sql<ChimeBudgetRow>`
		SELECT hour_bucket, total_count, summons_count, general_count, low_count,
			last_reply_at, last_normal_reply_at
		FROM brain_chime_budget
		WHERE channel_id = ${channelId}
	`[0]
	if (!row) return emptyChimeBudgetState(nowMs)
	return {
		bucket: row.hour_bucket,
		total: row.total_count,
		summons: row.summons_count,
		general: row.general_count,
		low: row.low_count,
		lastReplyAt: row.last_reply_at,
		lastNormalReplyAt: row.last_normal_reply_at,
	}
}

/** Reserve an unsolicited Slack reply slot after triage has already judged it. */
export function reserveChimeAnswer(
	agent: CompanyBrainAgent,
	args: {
		channelId: string
		priority: StoredTriagePriority
		nowMs?: number
		lastChannelActivityAt?: number
		urgentInvestigationFinding?: boolean
	},
): ChimeBudgetDecision {
	ensureChimeBudgetTables(agent)
	const nowMs = args.nowMs ?? Date.now()
	const result = evaluateChimeBudget({
		state: readBudgetState(agent, args.channelId, nowMs),
		priority: args.priority,
		nowMs,
		lastChannelActivityAt: args.lastChannelActivityAt,
		urgentInvestigationFinding: args.urgentInvestigationFinding,
	})
	if (!result.allowed) return result
	const next = result.next
	agent.sql`
		INSERT INTO brain_chime_budget (
			channel_id, hour_bucket, total_count, summons_count, general_count,
			low_count, last_reply_at, last_normal_reply_at
		) VALUES (
			${args.channelId}, ${next.bucket}, ${next.total}, ${next.summons},
			${next.general}, ${next.low}, ${next.lastReplyAt},
			${next.lastNormalReplyAt}
		)
		ON CONFLICT(channel_id) DO UPDATE SET
			hour_bucket = excluded.hour_bucket,
			total_count = excluded.total_count,
			summons_count = excluded.summons_count,
			general_count = excluded.general_count,
			low_count = excluded.low_count,
			last_reply_at = excluded.last_reply_at,
			last_normal_reply_at = excluded.last_normal_reply_at
	`
	return result
}

export type PassiveInvestigationClaim = {
	traceId: string
	startedAt: number
}

export type PassiveInvestigationDecision =
	| { allowed: true; claim: PassiveInvestigationClaim }
	| { allowed: false; suppression: "concurrency" | "investigation_hourly" }

/** Reserve silent work after triage; overflow is dropped rather than queued stale. */
export function reservePassiveInvestigation(
	agent: CompanyBrainAgent,
	args: {
		traceId: string
		channelId: string
		priority: StoredTriagePriority
		nowMs?: number
	},
): PassiveInvestigationDecision {
	ensureChimeBudgetTables(agent)
	const nowMs = args.nowMs ?? Date.now()
	const bucket = Math.floor(nowMs / HOUR_MS)
	agent.sql`
		DELETE FROM brain_passive_investigation
		WHERE status != ${"running"}
			AND started_at < ${nowMs - PASSIVE_INVESTIGATION_RETENTION_MS}
	`
	agent.sql`
		UPDATE brain_passive_investigation SET status = ${"expired"}
		WHERE status = ${"running"} AND expires_at <= ${nowMs}
	`
	const concurrent =
		agent.sql<{ count: number }>`
		SELECT COUNT(*) AS count FROM brain_passive_investigation
		WHERE status = ${"running"}
	`[0]?.count ?? 0
	if (concurrent >= PASSIVE_INVESTIGATION_MAX_CONCURRENT) {
		return { allowed: false, suppression: "concurrency" }
	}
	const hourly =
		agent.sql<{ count: number }>`
		SELECT COUNT(*) AS count FROM brain_passive_investigation
		WHERE hour_bucket = ${bucket}
	`[0]?.count ?? 0
	if (hourly >= PASSIVE_INVESTIGATION_MAX_PER_HOUR) {
		return { allowed: false, suppression: "investigation_hourly" }
	}
	agent.sql`
		INSERT INTO brain_passive_investigation (
			trace_id, channel_id, priority, status, started_at, expires_at,
			hour_bucket
		) VALUES (
			${args.traceId}, ${args.channelId}, ${args.priority}, ${"running"},
			${nowMs}, ${nowMs + PASSIVE_INVESTIGATION_LEASE_MS}, ${bucket}
		)
		ON CONFLICT(trace_id) DO NOTHING
	`
	return { allowed: true, claim: { traceId: args.traceId, startedAt: nowMs } }
}

export function releasePassiveInvestigation(
	agent: CompanyBrainAgent,
	claim: PassiveInvestigationClaim,
	outcome: "completed" | "silent" | "failed" | "suppressed",
): void {
	agent.sql`
		UPDATE brain_passive_investigation SET
			status = ${outcome}, expires_at = ${Date.now()}
		WHERE trace_id = ${claim.traceId}
			AND started_at = ${claim.startedAt}
			AND status = ${"running"}
	`
}
