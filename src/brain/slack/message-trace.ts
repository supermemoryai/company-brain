import { formatThread, isOurSlackBotMessage } from "../prompt/build"
import type { CompanyBrainAgent } from "../turn/agent"
import type { SlackThreadMessage } from "./client"

/** Matches generateId() output (22-char base58-ish nanoid). */
export const BRAIN_TRACE_ID_RE =
	/[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{22}/g

// formatThread keeps at most 30 rendered messages. A wider raw-message window
// leaves room for blank/system messages without querying every entry in a long
// Slack thread merely to attach optional trace metadata.
const TRACE_LOOKUP_MESSAGE_LIMIT = 60

export type BrainMessageTrace = {
	traceId: string
	/** Slack requires replies and ephemerals to target the parent message rather
	 * than an arbitrary reply timestamp. Undefined only for legacy records. */
	threadTs?: string
}

export function ensureMessageTraceTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_slack_message_trace (
			channel TEXT NOT NULL,
			message_ts TEXT NOT NULL,
			trace_id TEXT NOT NULL,
			thread_ts TEXT,
			PRIMARY KEY (channel, message_ts)
		)
	`
	const columns = agent.sql<{ name: string }>`
		PRAGMA table_info(brain_slack_message_trace)
	`
	if (!columns.some((column) => column.name === "thread_ts")) {
		agent.sql`
			ALTER TABLE brain_slack_message_trace ADD COLUMN thread_ts TEXT
		`
	}
}

export function recordMessageTrace(
	agent: CompanyBrainAgent,
	channel: string,
	messageTs: string,
	traceId: string,
	threadTs?: string,
): void {
	if (!channel || !messageTs || !traceId) return
	ensureMessageTraceTable(agent)
	agent.sql`
		INSERT INTO brain_slack_message_trace (
			channel, message_ts, trace_id, thread_ts
		)
		VALUES (${channel}, ${messageTs}, ${traceId}, ${threadTs ?? null})
		ON CONFLICT(channel, message_ts) DO UPDATE SET
			trace_id = excluded.trace_id,
			thread_ts = COALESCE(excluded.thread_ts, brain_slack_message_trace.thread_ts)
	`
}

export function lookupMessageTraceRecords(
	agent: CompanyBrainAgent,
	channel: string,
	messageTs: string[],
): Map<string, BrainMessageTrace> {
	const tss = [...new Set(messageTs.filter(Boolean))]
	if (!tss.length) return new Map()
	ensureMessageTraceTable(agent)
	const out = new Map<string, BrainMessageTrace>()
	for (const ts of tss) {
		const rows = agent.sql<{ trace_id: string; thread_ts: string | null }>`
			SELECT trace_id, thread_ts FROM brain_slack_message_trace
			WHERE channel = ${channel} AND message_ts = ${ts}
		`
		const row = rows[0]
		if (!row?.trace_id) continue
		out.set(ts, {
			traceId: row.trace_id,
			threadTs: row.thread_ts || undefined,
		})
	}
	return out
}

export function lookupMessageTraces(
	agent: CompanyBrainAgent,
	channel: string,
	messageTs: string[],
): Map<string, string> {
	return new Map(
		[...lookupMessageTraceRecords(agent, channel, messageTs)].map(
			([ts, record]) => [ts, record.traceId],
		),
	)
}

export function buildThreadContext(
	agent: CompanyBrainAgent,
	channel: string,
	thread: ReadonlyArray<SlackThreadMessage>,
	botUserId: string | null,
	slackBotId: string | null | undefined,
	excludeTs: string | undefined,
	userNames?: Map<string, string>,
	tzOffsetSeconds?: number,
	groupHandles?: Map<string, string>,
	botUserIds?: ReadonlySet<string>,
): string {
	const botTs = thread
		.slice(-TRACE_LOOKUP_MESSAGE_LIMIT)
		.filter(
			(m) => m.ts && isOurSlackBotMessage(m, botUserId, slackBotId ?? null),
		)
		.map((m) => m.ts as string)
	const traceByTs = lookupMessageTraces(agent, channel, botTs)
	return formatThread(
		thread,
		botUserId,
		excludeTs,
		traceByTs,
		userNames,
		tzOffsetSeconds,
		groupHandles,
		slackBotId,
		botUserIds,
	)
}
