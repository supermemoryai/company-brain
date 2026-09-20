import type { CompanyBrainAgent } from "../turn/agent"
import type { WatchTargetKind } from "./watchlist"

// Drafts produced by a manual auto-research run. Nothing is delivered from here:
// an admin reviews each draft in the observatory and sends it explicitly.

export type DraftKind = "channel" | "dm"
export type DraftStatus = "draft" | "sending" | "sent" | "dismissed"

// Review-only, never sent. cited = what the draft says backs it; web/internal = the
// full trail, with excerpts only for org-shared reads.
export type DraftSources = {
	cited: string[]
	web: string[]
	internal: Array<{ tool: string; label: string; excerpt?: string }>
}

export type AutoResearchDraft = {
	id: string
	kind: DraftKind
	targetKind: string | null
	targetLabel: string | null
	recipientUserId: string | null
	recipientSlackUserId: string | null
	recipientLabel: string | null
	channelId: string | null
	teamId: string | null
	/** Where this goes if sent, in Slack terms: a channel name or "DM to <person>". */
	destination: string | null
	body: string
	sources: DraftSources
	traceId: string | null
	status: DraftStatus
	createdAt: number
	decidedAt: number | null
	slackTs: string | null
	/** Set when a reviewer rewrote the body, so the cited sources can be re-read. */
	editedAt: number | null
	/** Quality problems worth a reviewer's attention, kept rather than dropped. */
	flags: string[]
}

export function ensureAutoResearchDraftTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_auto_research_draft (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			target_kind TEXT,
			target_label TEXT,
			recipient_user_id TEXT,
			recipient_slack_user_id TEXT,
			recipient_label TEXT,
			channel_id TEXT,
			team_id TEXT,
			body TEXT NOT NULL,
			sources TEXT NOT NULL,
			trace_id TEXT,
			status TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			decided_at INTEGER,
			slack_ts TEXT,
			destination TEXT,
			edited_at INTEGER
		)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_auto_research_draft_status
		ON brain_auto_research_draft (status, created_at DESC)
	`
	// Added after the first drafts existed; those rows fall back to the channel id.
	const cols = agent.sql<{
		name: string
	}>`PRAGMA table_info(brain_auto_research_draft)`
	if (!cols.some((c) => c.name === "destination"))
		agent.sql`ALTER TABLE brain_auto_research_draft ADD COLUMN destination TEXT`
	if (!cols.some((c) => c.name === "edited_at"))
		agent.sql`ALTER TABLE brain_auto_research_draft ADD COLUMN edited_at INTEGER`
	if (!cols.some((c) => c.name === "flags"))
		agent.sql`ALTER TABLE brain_auto_research_draft ADD COLUMN flags TEXT`
}

type DraftRow = {
	id: string
	kind: string
	target_kind: string | null
	target_label: string | null
	recipient_user_id: string | null
	recipient_slack_user_id: string | null
	recipient_label: string | null
	channel_id: string | null
	team_id: string | null
	destination: string | null
	body: string
	sources: string
	trace_id: string | null
	status: string
	created_at: number
	decided_at: number | null
	slack_ts: string | null
	edited_at: number | null
	flags: string | null
}

function parseSources(raw: string): DraftSources {
	try {
		const parsed = JSON.parse(raw) as Partial<DraftSources>
		return {
			cited: Array.isArray(parsed.cited) ? parsed.cited : [],
			web: Array.isArray(parsed.web) ? parsed.web : [],
			internal: Array.isArray(parsed.internal) ? parsed.internal : [],
		}
	} catch {
		return { cited: [], web: [], internal: [] }
	}
}

function parseFlags(raw: string | null): string[] {
	if (!raw) return []
	try {
		const parsed = JSON.parse(raw) as unknown
		return Array.isArray(parsed)
			? parsed.filter((f) => typeof f === "string")
			: []
	} catch {
		return []
	}
}

function rowToDraft(row: DraftRow): AutoResearchDraft {
	return {
		id: row.id,
		kind: row.kind as DraftKind,
		targetKind: row.target_kind,
		targetLabel: row.target_label,
		recipientUserId: row.recipient_user_id,
		recipientSlackUserId: row.recipient_slack_user_id,
		recipientLabel: row.recipient_label,
		channelId: row.channel_id,
		teamId: row.team_id,
		destination: row.destination ?? row.channel_id,
		body: row.body,
		sources: parseSources(row.sources),
		traceId: row.trace_id,
		status: row.status as DraftStatus,
		createdAt: row.created_at,
		decidedAt: row.decided_at,
		slackTs: row.slack_ts,
		editedAt: row.edited_at,
		flags: parseFlags(row.flags),
	}
}

export type NewAutoResearchDraft = {
	kind: DraftKind
	targetKind?: WatchTargetKind | string
	targetLabel?: string
	recipientUserId?: string
	recipientSlackUserId?: string
	recipientLabel?: string
	channelId?: string
	teamId?: string
	destination?: string
	body: string
	sources: DraftSources
	traceId?: string
	flags?: string[]
}

export function insertAutoResearchDraft(
	agent: CompanyBrainAgent,
	draft: NewAutoResearchDraft,
): string {
	ensureAutoResearchDraftTable(agent)
	const id = crypto.randomUUID()
	agent.sql`
		INSERT INTO brain_auto_research_draft (
			id, kind, target_kind, target_label, recipient_user_id,
			recipient_slack_user_id, recipient_label, channel_id, team_id,
			destination, body, sources, trace_id, status, created_at, flags
		) VALUES (
			${id}, ${draft.kind}, ${draft.targetKind ?? null}, ${draft.targetLabel ?? null},
			${draft.recipientUserId ?? null}, ${draft.recipientSlackUserId ?? null},
			${draft.recipientLabel ?? null}, ${draft.channelId ?? null}, ${draft.teamId ?? null},
			${draft.destination ?? null}, ${draft.body}, ${JSON.stringify(draft.sources)},
			${draft.traceId ?? null}, ${"draft"}, ${Date.now()},
			${draft.flags?.length ? JSON.stringify(draft.flags) : null}
		)
	`
	return id
}

export function listAutoResearchDrafts(
	agent: CompanyBrainAgent,
	opts: { status?: DraftStatus; limit?: number } = {},
): AutoResearchDraft[] {
	ensureAutoResearchDraftTable(agent)
	const limit = opts.limit ?? 50
	const rows = opts.status
		? agent.sql<DraftRow>`
				SELECT * FROM brain_auto_research_draft
				WHERE status = ${opts.status} ORDER BY created_at DESC LIMIT ${limit}
			`
		: agent.sql<DraftRow>`
				SELECT * FROM brain_auto_research_draft
				ORDER BY created_at DESC LIMIT ${limit}
			`
	return rows.map(rowToDraft)
}

export function getAutoResearchDraft(
	agent: CompanyBrainAgent,
	id: string,
): AutoResearchDraft | null {
	ensureAutoResearchDraftTable(agent)
	const row = agent.sql<DraftRow>`
		SELECT * FROM brain_auto_research_draft WHERE id = ${id}
	`[0]
	return row ? rowToDraft(row) : null
}

// Everything we've actually delivered. This is the whole memory of the loop:
// dismissed drafts leave no trace, so a later run may surface them again.
export function sentDraftBodies(
	agent: CompanyBrainAgent,
	limit = 20,
): string[] {
	ensureAutoResearchDraftTable(agent)
	return agent.sql<{ body: string }>`
		SELECT body FROM brain_auto_research_draft
		WHERE status = 'sent' ORDER BY created_at DESC LIMIT ${limit}
	`.map((r) => r.body)
}

// Drafts still awaiting review. Nothing is sent until a human sends it, so the
// sent list alone can't stop a round from re-deriving what's already in the queue.
export function pendingDraftBodies(
	agent: CompanyBrainAgent,
	limit = 20,
): string[] {
	ensureAutoResearchDraftTable(agent)
	return agent.sql<{ body: string }>`
		SELECT body FROM brain_auto_research_draft
		WHERE status = 'draft' ORDER BY created_at DESC LIMIT ${limit}
	`.map((r) => r.body)
}

// A crash between claiming and delivering must not strand a draft as sent, so the
// claim parks it in `sending` and a stale claim can be retaken. Retries are safe:
// the draft id is the Slack idempotency key, so a duplicate post is deduped.
const SENDING_STALE_MS = 2 * 60_000

export function claimAutoResearchDraftForSend(
	agent: CompanyBrainAgent,
	id: string,
): AutoResearchDraft | null {
	const draft = getAutoResearchDraft(agent, id)
	if (!draft) return null
	const stale =
		draft.status === "sending" &&
		Date.now() - (draft.decidedAt ?? 0) > SENDING_STALE_MS
	if (draft.status !== "draft" && !stale) return null
	agent.sql`
		UPDATE brain_auto_research_draft SET status = 'sending', decided_at = ${Date.now()}
		WHERE id = ${id} AND status IN ('draft', 'sending')
	`
	return draft
}

export function releaseAutoResearchDraft(
	agent: CompanyBrainAgent,
	id: string,
): void {
	agent.sql`
		UPDATE brain_auto_research_draft SET status = 'draft', decided_at = NULL
		WHERE id = ${id} AND status = 'sending'
	`
}

// Records the channel actually delivered to: the home channel can move between
// drafting and sending, and reading engagement later needs the real one.
export function finalizeAutoResearchDraft(
	agent: CompanyBrainAgent,
	id: string,
	slackTs: string,
	channelId: string,
): void {
	agent.sql`
		UPDATE brain_auto_research_draft
		SET status = 'sent', slack_ts = ${slackTs}, channel_id = ${channelId}
		WHERE id = ${id}
	`
}

export function dismissAutoResearchDraft(
	agent: CompanyBrainAgent,
	id: string,
): boolean {
	const draft = getAutoResearchDraft(agent, id)
	if (!draft || draft.status !== "draft") return false
	agent.sql`
		UPDATE brain_auto_research_draft SET status = 'dismissed', decided_at = ${Date.now()}
		WHERE id = ${id}
	`
	return true
}

// Only a pending draft is editable; the stamp warns that sources predate the edit.
export function editAutoResearchDraftBody(
	agent: CompanyBrainAgent,
	id: string,
	body: string,
): boolean {
	const draft = getAutoResearchDraft(agent, id)
	if (!draft || draft.status !== "draft") return false
	const trimmed = body.trim()
	if (!trimmed) return false
	agent.sql`
		UPDATE brain_auto_research_draft SET body = ${trimmed}, edited_at = ${Date.now()}
		WHERE id = ${id} AND status = 'draft'
	`
	return true
}

// Sent drafts for a scope, filtered in the query so the limit applies to the rows
// the caller can actually see rather than truncating them away first.
export function listSentDraftsForScope(
	agent: CompanyBrainAgent,
	scope: { channel: boolean; recipientUserIds: string[] },
	limit = 5,
): AutoResearchDraft[] {
	ensureAutoResearchDraftTable(agent)
	const rows: DraftRow[] = []
	if (scope.channel) {
		rows.push(
			...agent.sql<DraftRow>`
				SELECT * FROM brain_auto_research_draft
				WHERE status = 'sent' AND kind = 'channel'
				ORDER BY created_at DESC LIMIT ${limit}
			`,
		)
	}
	for (const userId of new Set(scope.recipientUserIds)) {
		rows.push(
			...agent.sql<DraftRow>`
				SELECT * FROM brain_auto_research_draft
				WHERE status = 'sent' AND kind = 'dm' AND recipient_user_id = ${userId}
				ORDER BY created_at DESC LIMIT ${limit}
			`,
		)
	}
	return rows
		.sort((a, b) => b.created_at - a.created_at)
		.slice(0, limit)
		.map(rowToDraft)
}
