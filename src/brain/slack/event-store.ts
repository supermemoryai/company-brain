import type { CompanyBrainAgent } from "../turn/agent"
import type { SlackThreadMessage } from "./client"
import type { SlackEventInner, SlackTurnMessage } from "./events"

export const EVENT_TEXT_MAX_CHARS = 2_000
export const SLACK_EVENT_RING_MAX_PER_CHANNEL = 50
export const TRIAGE_CLAIM_LEASE_MS = 2 * 60 * 1_000
const CONTEXT_COMPLETENESS_VERSION = 1
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000
const CONTEXT_BACKFILL_RETRY_MS = 60 * 60 * 1_000
export const CONTEXT_GAP_BACKFILL_MS = 6 * 60 * 60 * 1_000

export type StoredTriageDecision =
	| "filtered"
	| "explicit"
	| "pass"
	| "ack"
	| "answer"
	| "investigate"

export type StoredTriagePriority = "summons" | "urgent" | "normal" | "low"

export type SlackEventIdentity = {
	teamId: string
	channel: string
	messageTs: string
	threadTs?: string
}

export type StoredTriageClaim = {
	id: string
	claimedAt: number
}

type EventPayload = {
	user?: string
	text?: string
	ts?: string
	thread_ts?: string
	bot_id?: string
	app_id?: string
	subtype?: string
}

type StoredSlackEventRow = {
	user_id: string | null
	text: string | null
	event_ts: string
	thread_ts: string | null
	bot_id: string | null
	app_id: string | null
	subtype: string | null
	is_bot: number
}

export type StoredSlackEventAudit = {
	decision?: string
	priority?: string
	reason?: string
	emoji?: string
	fallbackEmoji?: string
	suppression?: string
	fallbackUsed: boolean
	actionOutcome?: string
	traceId?: string
}

export type LocalThreadContextSnapshot = {
	messages: SlackThreadMessage[]
	truncated: boolean
	retainedComplete: boolean
}

const initializedEventStores = new WeakSet<CompanyBrainAgent>()

export function ensureSlackEventStoreTables(agent: CompanyBrainAgent): void {
	if (initializedEventStores.has(agent)) return
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_slack_event (
			team_id TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			event_ts TEXT NOT NULL,
			thread_ts TEXT,
			user_id TEXT,
			bot_id TEXT,
			app_id TEXT,
			is_bot INTEGER NOT NULL DEFAULT 0,
			text TEXT,
			subtype TEXT,
			is_deleted INTEGER NOT NULL DEFAULT 0,
			received_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			triage_decision TEXT,
			triage_source TEXT,
			triage_priority TEXT,
			triage_reason TEXT,
			triage_emoji TEXT,
			triage_fallback_emoji TEXT,
			suppression TEXT,
			fallback_used INTEGER NOT NULL DEFAULT 0,
			action_outcome TEXT,
			trace_id TEXT,
			triage_claim_id TEXT,
			triage_claimed_at INTEGER,
			PRIMARY KEY (team_id, channel_id, event_ts)
		)
	`
	const columns = new Set(
		agent.sql<{ name: string }>`PRAGMA table_info(brain_slack_event)`.map(
			(row) => row.name,
		),
	)
	if (!columns.has("triage_claim_id")) {
		agent.sql`ALTER TABLE brain_slack_event ADD COLUMN triage_claim_id TEXT`
	}
	if (!columns.has("triage_claimed_at")) {
		agent.sql`ALTER TABLE brain_slack_event ADD COLUMN triage_claimed_at INTEGER`
	}
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_slack_event_channel_context
		ON brain_slack_event (team_id, channel_id, thread_ts, event_ts)
	`
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_slack_context_state (
			team_id TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			scope_key TEXT NOT NULL,
			warm INTEGER NOT NULL DEFAULT 0,
			history_complete INTEGER NOT NULL DEFAULT 0,
			history_complete_version INTEGER NOT NULL DEFAULT 1,
			last_backfill_at INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (team_id, channel_id, scope_key)
		)
	`
	const contextColumns = new Set(
		agent.sql<{
			name: string
		}>`PRAGMA table_info(brain_slack_context_state)`.map((row) => row.name),
	)
	if (!contextColumns.has("history_complete_version")) {
		// Existing rows used the old meaning: Slack pagination completed, even if
		// the bounded local prompt had already lost messages. Version zero makes
		// those optimistic values unreadable until the scope is warmed again.
		agent.sql`
			ALTER TABLE brain_slack_context_state
			ADD COLUMN history_complete_version INTEGER NOT NULL DEFAULT 0
		`
	}
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_slack_event_maintenance (
			key TEXT PRIMARY KEY,
			last_run_at INTEGER NOT NULL
		)
	`
	initializedEventStores.add(agent)
}

function boundedText(value: string | undefined): string | undefined {
	const text = value?.trim()
	if (!text) return undefined
	return Array.from(text).slice(0, EVENT_TEXT_MAX_CHARS).join("")
}

function nestedPayload(ev: SlackEventInner): EventPayload {
	if (ev.subtype === "message_changed" && ev.message) return ev.message
	if (ev.subtype === "message_deleted" && ev.previous_message) {
		return ev.previous_message
	}
	return ev
}

/**
 * Slack may represent a thread parent with thread_ts equal to its own ts.
 * Store that as channel-level context while retaining a real parent timestamp
 * only for replies.
 */
function normalizedThreadTs(
	messageTs: string,
	threadTs: string | undefined,
): string | undefined {
	return threadTs && threadTs !== messageTs ? threadTs : undefined
}

export function slackEventIdentity(
	msg: SlackTurnMessage,
): SlackEventIdentity | undefined {
	const payload = nestedPayload(msg.event)
	const channel = msg.event.channel
	const messageTs =
		msg.event.deleted_ts ?? payload.ts ?? msg.event.ts ?? undefined
	if (!channel || !messageTs) return undefined
	const threadTs = normalizedThreadTs(messageTs, payload.thread_ts)
	return {
		teamId: msg.teamId,
		channel,
		messageTs,
		...(threadTs ? { threadTs } : {}),
	}
}

function maybePruneEventStore(
	agent: CompanyBrainAgent,
	scope: { teamId: string; channel: string },
	nowMs: number,
): void {
	// Keep the context store physically bounded, rather than merely bounding
	// SELECT limits. This runs for every live insert and after history warmup so
	// bot-authored/context-only traffic cannot grow the DO's SQLite indefinitely.
	agent.sql`
		UPDATE brain_slack_context_state
		SET history_complete = 0,
			history_complete_version = ${CONTEXT_COMPLETENESS_VERSION}
		WHERE team_id = ${scope.teamId}
			AND channel_id = ${scope.channel}
			AND scope_key IN (
				SELECT DISTINCT
					${"thread:"} || COALESCE(pruned.thread_ts, pruned.event_ts)
				FROM brain_slack_event AS pruned
				WHERE pruned.team_id = ${scope.teamId}
					AND pruned.channel_id = ${scope.channel}
					AND pruned.event_ts NOT IN (
						SELECT kept.event_ts FROM brain_slack_event AS kept
						WHERE kept.team_id = ${scope.teamId}
							AND kept.channel_id = ${scope.channel}
						ORDER BY kept.event_ts DESC
						LIMIT ${SLACK_EVENT_RING_MAX_PER_CHANNEL}
					)
					AND (
						pruned.thread_ts IS NOT NULL
						OR EXISTS (
							SELECT 1 FROM brain_slack_event AS reply
							WHERE reply.team_id = pruned.team_id
								AND reply.channel_id = pruned.channel_id
								AND reply.thread_ts = pruned.event_ts
						)
					)
			)
	`
	agent.sql`
		DELETE FROM brain_slack_event
		WHERE team_id = ${scope.teamId}
			AND channel_id = ${scope.channel}
			AND event_ts NOT IN (
				SELECT event_ts FROM brain_slack_event
				WHERE team_id = ${scope.teamId}
					AND channel_id = ${scope.channel}
				ORDER BY event_ts DESC
				LIMIT ${SLACK_EVENT_RING_MAX_PER_CHANNEL}
			)
	`

	const row = agent.sql<{ last_run_at: number }>`
		SELECT last_run_at FROM brain_slack_event_maintenance
		WHERE key = ${"retention"}
	`[0]
	if (row && nowMs - row.last_run_at < CLEANUP_INTERVAL_MS) return
	const retentionCutoff = nowMs - EVENT_RETENTION_MS
	agent.sql`
		UPDATE brain_slack_context_state
		SET history_complete = 0,
			history_complete_version = ${CONTEXT_COMPLETENESS_VERSION}
		WHERE EXISTS (
			SELECT 1 FROM brain_slack_event AS stale
			WHERE stale.team_id = brain_slack_context_state.team_id
				AND stale.channel_id = brain_slack_context_state.channel_id
				AND stale.received_at < ${retentionCutoff}
				AND (
					(
						stale.thread_ts IS NOT NULL
						AND brain_slack_context_state.scope_key =
							${"thread:"} || stale.thread_ts
					)
					OR (
						stale.thread_ts IS NULL
						AND brain_slack_context_state.scope_key =
							${"thread:"} || stale.event_ts
						AND EXISTS (
							SELECT 1 FROM brain_slack_event AS reply
							WHERE reply.team_id = stale.team_id
								AND reply.channel_id = stale.channel_id
								AND reply.thread_ts = stale.event_ts
						)
					)
				)
		)
	`
	agent.sql`
		DELETE FROM brain_slack_event
		WHERE received_at < ${retentionCutoff}
	`
	agent.sql`
		INSERT INTO brain_slack_event_maintenance (key, last_run_at)
		VALUES (${"retention"}, ${nowMs})
		ON CONFLICT(key) DO UPDATE SET last_run_at = excluded.last_run_at
	`
}

/** Persist or refresh the local representation of a Slack message event. */
export function recordSlackEvent(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
	nowMs = Date.now(),
): SlackEventIdentity | undefined {
	ensureSlackEventStoreTables(agent)
	const identity = slackEventIdentity(msg)
	if (!identity) return undefined
	const ev = msg.event
	const payload = nestedPayload(ev)
	const isDeleted = ev.subtype === "message_deleted"
	const isBot = Boolean(
		payload.bot_id ||
			payload.app_id ||
			ev.bot_id ||
			ev.app_id ||
			payload.subtype === "bot_message",
	)
	const text = isDeleted ? undefined : boundedText(payload.text)
	agent.sql`
		INSERT INTO brain_slack_event (
			team_id, channel_id, event_ts, thread_ts, user_id, bot_id, app_id,
			is_bot, text, subtype, is_deleted, received_at, updated_at
		) VALUES (
			${identity.teamId}, ${identity.channel}, ${identity.messageTs},
			${identity.threadTs ?? null}, ${payload.user ?? ev.user ?? null},
			${payload.bot_id ?? ev.bot_id ?? null},
			${payload.app_id ?? ev.app_id ?? null}, ${isBot ? 1 : 0},
			${text ?? null}, ${ev.subtype ?? payload.subtype ?? null},
			${isDeleted ? 1 : 0}, ${nowMs}, ${nowMs}
		)
		ON CONFLICT(team_id, channel_id, event_ts) DO UPDATE SET
			thread_ts = COALESCE(excluded.thread_ts, brain_slack_event.thread_ts),
			user_id = COALESCE(excluded.user_id, brain_slack_event.user_id),
			bot_id = COALESCE(excluded.bot_id, brain_slack_event.bot_id),
			app_id = COALESCE(excluded.app_id, brain_slack_event.app_id),
			is_bot = MAX(excluded.is_bot, brain_slack_event.is_bot),
			text = CASE
				WHEN excluded.is_deleted = 1 OR brain_slack_event.is_deleted = 1
					THEN NULL
				ELSE COALESCE(excluded.text, brain_slack_event.text)
			END,
			subtype = COALESCE(excluded.subtype, brain_slack_event.subtype),
			is_deleted = MAX(excluded.is_deleted, brain_slack_event.is_deleted),
			triage_decision = CASE
				WHEN brain_slack_event.triage_decision = 'historical' THEN NULL
				ELSE brain_slack_event.triage_decision
			END,
			triage_source = CASE
				WHEN brain_slack_event.triage_decision = 'historical' THEN NULL
				ELSE brain_slack_event.triage_source
			END,
			updated_at = excluded.updated_at
	`
	maybePruneEventStore(agent, identity, nowMs)
	return identity
}

export function markStoredEventFiltered(
	agent: CompanyBrainAgent,
	identity: SlackEventIdentity,
	reason: string,
	claimId?: string,
): boolean {
	return recordStoredTriageDecision(agent, identity, {
		decision: "filtered",
		source: "structural_filter",
		reason,
		...(claimId ? { claimId } : {}),
	})
}

/**
 * Atomically lease an unjudged message before starting its model call.
 * A stale lease may be reclaimed, while the unique id prevents the former
 * owner from publishing a decision after ownership changes.
 */
export function claimStoredEventForTriage(
	agent: CompanyBrainAgent,
	identity: SlackEventIdentity,
	nowMs = Date.now(),
): StoredTriageClaim | undefined {
	const claimId = crypto.randomUUID()
	const claimed = agent.sql<{ event_ts: string }>`
		UPDATE brain_slack_event
		SET triage_decision = ${"judging"},
			triage_source = NULL,
			triage_priority = NULL,
			triage_reason = NULL,
			triage_emoji = NULL,
			triage_fallback_emoji = NULL,
			suppression = NULL,
			fallback_used = 0,
			action_outcome = NULL,
			trace_id = NULL,
			triage_claim_id = ${claimId},
			triage_claimed_at = ${nowMs},
			updated_at = ${nowMs}
		WHERE team_id = ${identity.teamId}
			AND channel_id = ${identity.channel}
			AND event_ts = ${identity.messageTs}
			AND (
				triage_decision IS NULL
				OR (
					triage_decision = ${"judging"}
					AND (
						triage_claimed_at IS NULL
						OR triage_claimed_at <= ${nowMs - TRIAGE_CLAIM_LEASE_MS}
					)
				)
			)
		RETURNING event_ts
	`[0]
	return claimed ? { id: claimId, claimedAt: nowMs } : undefined
}

export function recordStoredTriageDecision(
	agent: CompanyBrainAgent,
	identity: SlackEventIdentity,
	args: {
		decision: StoredTriageDecision | "judging" | "historical"
		claimId?: string
		source?: string
		priority?: StoredTriagePriority
		reason?: string
		emoji?: string
		fallbackEmoji?: string
		traceId?: string
	},
): boolean {
	const claimId = args.claimId ?? null
	const updated = agent.sql<{ event_ts: string }>`
		UPDATE brain_slack_event SET
			triage_decision = ${args.decision},
			triage_source = ${args.source ?? null},
			triage_priority = ${args.priority ?? null},
			triage_reason = ${args.reason ?? null},
			triage_emoji = ${args.emoji ?? null},
			triage_fallback_emoji = ${args.fallbackEmoji ?? null},
			trace_id = COALESCE(${args.traceId ?? null}, trace_id),
			triage_claim_id = NULL,
			triage_claimed_at = NULL,
			updated_at = ${Date.now()}
		WHERE team_id = ${identity.teamId}
			AND channel_id = ${identity.channel}
			AND event_ts = ${identity.messageTs}
			AND (
				${claimId} IS NULL
				OR (
					triage_decision = ${"judging"}
					AND triage_claim_id = ${claimId}
				)
			)
		RETURNING event_ts
	`[0]
	return Boolean(updated)
}

export function recordStoredSuppression(
	agent: CompanyBrainAgent,
	identity: SlackEventIdentity,
	args: { suppression: string; fallbackUsed?: boolean; outcome?: string },
): void {
	agent.sql`
		UPDATE brain_slack_event SET
			suppression = ${args.suppression},
			fallback_used = ${args.fallbackUsed ? 1 : 0},
			action_outcome = ${args.outcome ?? "suppressed"},
			updated_at = ${Date.now()}
		WHERE team_id = ${identity.teamId}
			AND channel_id = ${identity.channel}
			AND event_ts = ${identity.messageTs}
	`
	console.log(
		`[company-brain] proactivity suppressed reason=${args.suppression} team=${identity.teamId} channel=${identity.channel} message=${identity.messageTs} fallback=${args.fallbackUsed === true}`,
	)
}

export function recordStoredActionOutcome(
	agent: CompanyBrainAgent,
	identity: SlackEventIdentity,
	outcome: string,
): void {
	agent.sql`
		UPDATE brain_slack_event SET
			action_outcome = ${outcome}, updated_at = ${Date.now()}
		WHERE team_id = ${identity.teamId}
			AND channel_id = ${identity.channel}
			AND event_ts = ${identity.messageTs}
	`
}

function rowsToSlackMessages(
	rows: StoredSlackEventRow[],
): SlackThreadMessage[] {
	return rows.map((row) => ({
		...(row.user_id ? { user: row.user_id } : {}),
		...(row.text ? { text: row.text } : {}),
		ts: row.event_ts,
		...(row.thread_ts ? { thread_ts: row.thread_ts } : {}),
		...(row.bot_id ? { bot_id: row.bot_id } : {}),
		...(row.app_id ? { app_id: row.app_id } : {}),
		...(row.subtype ? { subtype: row.subtype } : {}),
		...(!row.bot_id && !row.app_id && row.is_bot
			? { bot_id: "local-context-bot" }
			: {}),
	}))
}

export function loadLocalChannelContext(
	agent: CompanyBrainAgent,
	args: {
		teamId: string
		channel: string
		beforeTs: string
		limit?: number
	},
): SlackThreadMessage[] {
	ensureSlackEventStoreTables(agent)
	const rows = agent.sql<StoredSlackEventRow>`
		SELECT user_id, text, event_ts, thread_ts, bot_id, app_id, subtype, is_bot
		FROM brain_slack_event
		WHERE team_id = ${args.teamId}
			AND channel_id = ${args.channel}
			AND (thread_ts IS NULL OR thread_ts = event_ts)
			AND is_deleted = 0
			AND event_ts < ${args.beforeTs}
		ORDER BY event_ts DESC
		LIMIT ${args.limit ?? 20}
	`
	return rowsToSlackMessages(rows.reverse())
}

export function loadLocalThreadContext(
	agent: CompanyBrainAgent,
	args: {
		teamId: string
		channel: string
		threadTs: string
		beforeTs: string
		limit?: number
	},
): SlackThreadMessage[] {
	ensureSlackEventStoreTables(agent)
	const rows = agent.sql<StoredSlackEventRow>`
		SELECT user_id, text, event_ts, thread_ts, bot_id, app_id, subtype, is_bot
		FROM brain_slack_event
		WHERE team_id = ${args.teamId}
			AND channel_id = ${args.channel}
			AND is_deleted = 0
			AND event_ts < ${args.beforeTs}
			AND (event_ts = ${args.threadTs} OR thread_ts = ${args.threadTs})
		ORDER BY event_ts DESC
		LIMIT ${args.limit ?? 50}
	`
	return rowsToSlackMessages(rows.reverse())
}

/** Most recent prior human activity in the channel, excluding this event. */
export function getPreviousHumanChannelActivityAt(
	agent: CompanyBrainAgent,
	identity: SlackEventIdentity,
): number | undefined {
	ensureSlackEventStoreTables(agent)
	const row = agent.sql<{ received_at: number }>`
		SELECT received_at FROM brain_slack_event
		WHERE team_id = ${identity.teamId}
			AND channel_id = ${identity.channel}
			AND event_ts < ${identity.messageTs}
			AND is_bot = 0
			AND is_deleted = 0
		ORDER BY event_ts DESC
		LIMIT 1
	`[0]
	return row?.received_at
}

function contextScopeKey(threadTs?: string): string {
	return threadTs ? `thread:${threadTs}` : "channel"
}

function slackTimestampMs(value: string | undefined): number | undefined {
	if (!value) return undefined
	const milliseconds = Number.parseFloat(value) * 1_000
	return Number.isFinite(milliseconds) ? milliseconds : undefined
}

/** A visible six-hour discontinuity is the signal that event delivery may have had a gap. */
export function hasLocalContextGap(
	currentMessageTs: string | undefined,
	previousMessageTs: string | undefined,
): boolean {
	const currentMs = slackTimestampMs(currentMessageTs)
	const previousMs = slackTimestampMs(previousMessageTs)
	return Boolean(
		currentMs !== undefined &&
			previousMs !== undefined &&
			currentMs - previousMs > CONTEXT_GAP_BACKFILL_MS,
	)
}

function latestContextEventBefore(
	agent: CompanyBrainAgent,
	args: {
		teamId: string
		channel: string
		threadTs?: string
		currentMessageTs: string
	},
): string | undefined {
	const row = args.threadTs
		? agent.sql<{ event_ts: string }>`
				SELECT event_ts FROM brain_slack_event
				WHERE team_id = ${args.teamId}
					AND channel_id = ${args.channel}
					AND is_deleted = 0
					AND event_ts < ${args.currentMessageTs}
					AND (event_ts = ${args.threadTs} OR thread_ts = ${args.threadTs})
				ORDER BY event_ts DESC
				LIMIT 1
			`[0]
		: agent.sql<{ event_ts: string }>`
				SELECT event_ts FROM brain_slack_event
				WHERE team_id = ${args.teamId}
					AND channel_id = ${args.channel}
					AND (thread_ts IS NULL OR thread_ts = event_ts)
					AND is_deleted = 0
					AND event_ts < ${args.currentMessageTs}
				ORDER BY event_ts DESC
				LIMIT 1
			`[0]
	return row?.event_ts
}

export function isLocalContextHistoryComplete(
	agent: CompanyBrainAgent,
	args: { teamId: string; channel: string; threadTs?: string },
): boolean {
	ensureSlackEventStoreTables(agent)
	const scopeKey = contextScopeKey(args.threadTs)
	const row = agent.sql<{
		history_complete: number
		history_complete_version: number
	}>`
		SELECT history_complete, history_complete_version
		FROM brain_slack_context_state
		WHERE team_id = ${args.teamId}
			AND channel_id = ${args.channel}
			AND scope_key = ${scopeKey}
	`[0]
	return (
		row?.history_complete === 1 &&
		row.history_complete_version === CONTEXT_COMPLETENESS_VERSION
	)
}

/** Claim an initial or visible-gap Slack history warmup for a local context scope. */
export function claimLocalContextWarmup(
	agent: CompanyBrainAgent,
	args: {
		teamId: string
		channel: string
		threadTs?: string
		currentMessageTs?: string
	},
	nowMs = Date.now(),
): boolean {
	ensureSlackEventStoreTables(agent)
	const scopeKey = contextScopeKey(args.threadTs)
	const row = agent.sql<{
		warm: number
		last_backfill_at: number
	}>`
		SELECT warm, last_backfill_at FROM brain_slack_context_state
		WHERE team_id = ${args.teamId}
			AND channel_id = ${args.channel}
			AND scope_key = ${scopeKey}
	`[0]
	const previousMessageTs = args.currentMessageTs
		? latestContextEventBefore(agent, {
				teamId: args.teamId,
				channel: args.channel,
				threadTs: args.threadTs,
				currentMessageTs: args.currentMessageTs,
			})
		: undefined
	const needsGapBackfill =
		row?.warm === 1 &&
		hasLocalContextGap(args.currentMessageTs, previousMessageTs)
	// A thread can remain marked warm after the channel-wide event ring evicts
	// every one of its older rows. A current reply with no prior local thread
	// event is therefore a cache miss, not evidence that the thread is empty.
	const needsMissingThreadBackfill = Boolean(
		row?.warm === 1 &&
			args.threadTs &&
			args.currentMessageTs &&
			!previousMessageTs,
	)
	if (row?.warm && !needsGapBackfill && !needsMissingThreadBackfill) {
		return false
	}
	if (
		row &&
		!needsMissingThreadBackfill &&
		nowMs - row.last_backfill_at < CONTEXT_BACKFILL_RETRY_MS
	) {
		return false
	}
	agent.sql`
		INSERT INTO brain_slack_context_state (
			team_id, channel_id, scope_key, warm, history_complete,
			history_complete_version,
			last_backfill_at
		) VALUES (
			${args.teamId}, ${args.channel}, ${scopeKey}, 0, 0,
			${CONTEXT_COMPLETENESS_VERSION}, ${nowMs}
		)
		ON CONFLICT(team_id, channel_id, scope_key) DO UPDATE SET
			warm = 0,
			history_complete = 0,
			history_complete_version = excluded.history_complete_version,
			last_backfill_at = excluded.last_backfill_at
	`
	return true
}

export function markLocalContextWarm(
	agent: CompanyBrainAgent,
	args: {
		teamId: string
		channel: string
		threadTs?: string
		historyComplete?: boolean
	},
): void {
	const scopeKey = contextScopeKey(args.threadTs)
	agent.sql`
		INSERT INTO brain_slack_context_state (
			team_id, channel_id, scope_key, warm, history_complete,
			history_complete_version,
			last_backfill_at
		) VALUES (
			${args.teamId}, ${args.channel}, ${scopeKey}, 1,
			${args.historyComplete === false ? 0 : 1},
			${CONTEXT_COMPLETENESS_VERSION}, ${Date.now()}
		)
		ON CONFLICT(team_id, channel_id, scope_key) DO UPDATE SET
			warm = 1,
			history_complete = excluded.history_complete,
			history_complete_version = excluded.history_complete_version,
			last_backfill_at = excluded.last_backfill_at
	`
}

function mergeSlackHistoryRowsIntoLocalContext(
	agent: CompanyBrainAgent,
	args: {
		teamId: string
		channel: string
		messages: ReadonlyArray<SlackThreadMessage>
	},
): void {
	ensureSlackEventStoreTables(agent)
	for (const message of args.messages) {
		if (!message.ts) continue
		const receivedAt = Number.parseFloat(message.ts) * 1_000
		const threadTs = normalizedThreadTs(message.ts, message.thread_ts)
		agent.sql`
			INSERT INTO brain_slack_event (
				team_id, channel_id, event_ts, thread_ts, user_id, bot_id, app_id,
				is_bot, text, subtype, is_deleted, received_at, updated_at,
				triage_decision, triage_source
			) VALUES (
				${args.teamId}, ${args.channel}, ${message.ts},
				${threadTs ?? null}, ${message.user ?? null},
				${message.bot_id ?? null}, ${message.app_id ?? null},
				${message.bot_id || message.app_id || message.subtype === "bot_message" ? 1 : 0},
				${boundedText(message.text) ?? null}, ${message.subtype ?? null}, 0,
				${Number.isFinite(receivedAt) ? receivedAt : Date.now()}, ${Date.now()},
				${"historical"}, ${"slack_backfill"}
			)
			ON CONFLICT(team_id, channel_id, event_ts) DO UPDATE SET
				thread_ts = COALESCE(brain_slack_event.thread_ts, excluded.thread_ts),
				user_id = COALESCE(brain_slack_event.user_id, excluded.user_id),
				bot_id = COALESCE(brain_slack_event.bot_id, excluded.bot_id),
				app_id = COALESCE(brain_slack_event.app_id, excluded.app_id),
				is_bot = MAX(brain_slack_event.is_bot, excluded.is_bot),
				text = COALESCE(brain_slack_event.text, excluded.text),
				subtype = COALESCE(brain_slack_event.subtype, excluded.subtype)
			WHERE brain_slack_event.is_deleted = 0
			`
	}
}

export function mergeSlackHistoryIntoLocalContext(
	agent: CompanyBrainAgent,
	args: {
		teamId: string
		channel: string
		messages: ReadonlyArray<SlackThreadMessage>
	},
): void {
	mergeSlackHistoryRowsIntoLocalContext(agent, args)
	maybePruneEventStore(
		agent,
		{ teamId: args.teamId, channel: args.channel },
		Date.now(),
	)
}

/**
 * Merge a Slack thread read and capture the bounded, deletion-filtered prompt
 * window before the channel-wide ring prunes it. The returned retained flag is
 * separate: it describes whether that same complete window survived pruning
 * and is therefore safe to reuse on a later event without another Slack read.
 */
export function mergeSlackThreadHistoryIntoLocalContext(
	agent: CompanyBrainAgent,
	args: {
		teamId: string
		channel: string
		threadTs: string
		beforeTs: string
		messages: ReadonlyArray<SlackThreadMessage>
		limit: number
	},
): LocalThreadContextSnapshot {
	mergeSlackHistoryRowsIntoLocalContext(agent, args)
	const limit = Math.max(1, Math.floor(args.limit))
	const beforePrune = loadLocalThreadContext(agent, {
		teamId: args.teamId,
		channel: args.channel,
		threadTs: args.threadTs,
		beforeTs: args.beforeTs,
		limit: limit + 1,
	})
	const truncated = beforePrune.length > limit
	const messages = truncated ? beforePrune.slice(-limit) : beforePrune

	maybePruneEventStore(
		agent,
		{ teamId: args.teamId, channel: args.channel },
		Date.now(),
	)
	const retained = loadLocalThreadContext(agent, {
		teamId: args.teamId,
		channel: args.channel,
		threadTs: args.threadTs,
		beforeTs: args.beforeTs,
		limit: limit + 1,
	})
	const retainedComplete =
		!truncated &&
		retained.length === messages.length &&
		messages.every((message, index) => message.ts === retained[index]?.ts)

	return { messages, truncated, retainedComplete }
}

export function getStoredSlackEventAudit(
	agent: CompanyBrainAgent,
	identity: SlackEventIdentity,
): StoredSlackEventAudit | undefined {
	const row = agent.sql<{
		triage_decision: string | null
		triage_priority: string | null
		triage_reason: string | null
		triage_emoji: string | null
		triage_fallback_emoji: string | null
		suppression: string | null
		fallback_used: number
		action_outcome: string | null
		trace_id: string | null
	}>`
		SELECT triage_decision, triage_priority, triage_reason, triage_emoji,
			triage_fallback_emoji, suppression, fallback_used, action_outcome, trace_id
		FROM brain_slack_event
		WHERE team_id = ${identity.teamId}
			AND channel_id = ${identity.channel}
			AND event_ts = ${identity.messageTs}
	`[0]
	if (!row) return undefined
	return {
		...(row.triage_decision ? { decision: row.triage_decision } : {}),
		...(row.triage_priority ? { priority: row.triage_priority } : {}),
		...(row.triage_reason ? { reason: row.triage_reason } : {}),
		...(row.triage_emoji ? { emoji: row.triage_emoji } : {}),
		...(row.triage_fallback_emoji
			? { fallbackEmoji: row.triage_fallback_emoji }
			: {}),
		...(row.suppression ? { suppression: row.suppression } : {}),
		fallbackUsed: row.fallback_used === 1,
		...(row.action_outcome ? { actionOutcome: row.action_outcome } : {}),
		...(row.trace_id ? { traceId: row.trace_id } : {}),
	}
}
