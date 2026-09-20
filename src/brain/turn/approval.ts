import type { ModelMessage } from "ai"
import type { MemoryWriteback, SlackMemoryScope } from "../memory"
import type { SlackBotIdentity } from "../slack/client"
import type { TurnControlSnapshot } from "../slack/turn-control"
import type { ConnectedAppPauseRef } from "../tools/mcp/pause"
import type { TurnActor } from "./actor"
import type { CompanyBrainAgent } from "./agent"
import type { TurnState } from "./state"
import type { TurnTerminalProposal } from "./terminal"
import type { TurnToolAssemblySnapshot } from "./tools"

export const APPROVAL_EXPIRY_MS = 15 * 60 * 1000

export type ApprovalStatus =
	| "pending"
	| "approved"
	| "denied"
	| "expired"
	| "executed"
	| "cancelled"
	| "error"

export type ApprovalResumeState = {
	userId: string
	actor: TurnActor
	/** Legacy deployments persisted a flattened system prompt. */
	system?: string
	/** Asker's original question, for post-resume memory writeback. */
	question?: string
	messages: ModelMessage[]
	approvalIds: string[]
	connectedAppPause?: ConnectedAppPauseRef
	/** Legacy compatibility; the shared assembler always restores the full tool set. */
	includeMemoryAndWeb?: boolean
	turnState?: TurnState
	assembly?: TurnToolAssemblySnapshot
	botIdentity?: SlackBotIdentity
	detailedAppPolicy?: boolean
	memoryScope?: SlackMemoryScope
	memoryTagSlackUserIds?: string[]
	memory?: MemoryWriteback
	turnControl?: TurnControlSnapshot
	skipPostTurnReflect?: boolean
	/** Last model-proposed terminal reply before an approval suspension. */
	terminalProposal?: TurnTerminalProposal
}

export type PendingApproval = {
	approvalId: string
	turnId: string
	orgId: string
	teamId: string
	channel: string
	threadTs: string
	cardTs?: string
	askerUser: string
	toolName: string
	slug?: string
	toolInput: unknown
	summary: string
	state: ApprovalResumeState
	status: ApprovalStatus
	createdAt: number
	expiresAt: number
	decidedAt?: number
	decidedBy?: string
}

type PendingApprovalRow = {
	approval_id: string
	turn_id: string
	org_id: string
	team_id: string
	channel: string
	thread_ts: string
	card_ts: string | null
	asker_user: string
	tool_name: string
	slug: string | null
	tool_input_json: string
	summary: string
	state_json: string
	status: ApprovalStatus
	created_at: number
	expires_at: number
	decided_at: number | null
	decided_by: string | null
}

export function ensureApprovalTables(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_pending_approval (
			approval_id TEXT PRIMARY KEY,
			turn_id TEXT NOT NULL,
			org_id TEXT NOT NULL,
			team_id TEXT NOT NULL,
			channel TEXT NOT NULL,
			thread_ts TEXT NOT NULL,
			card_ts TEXT,
			asker_user TEXT NOT NULL,
			tool_name TEXT NOT NULL,
			slug TEXT,
			tool_input_json TEXT NOT NULL,
			summary TEXT NOT NULL,
			state_json TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			decided_at INTEGER,
			decided_by TEXT
		)
	`
}

export function approvalIsExpired(
	approval: Pick<PendingApproval, "expiresAt" | "status">,
	now = Date.now(),
): boolean {
	return approval.status === "pending" && approval.expiresAt <= now
}

function rowToApproval(row: PendingApprovalRow): PendingApproval | null {
	try {
		const toolInput = JSON.parse(row.tool_input_json)
		const state = JSON.parse(row.state_json) as ApprovalResumeState
		return {
			approvalId: row.approval_id,
			turnId: row.turn_id,
			orgId: row.org_id,
			teamId: row.team_id,
			channel: row.channel,
			threadTs: row.thread_ts,
			cardTs: row.card_ts ?? undefined,
			askerUser: row.asker_user,
			toolName: row.tool_name,
			slug: row.slug ?? undefined,
			toolInput,
			summary: row.summary,
			state,
			status: row.status,
			createdAt: row.created_at,
			expiresAt: row.expires_at,
			decidedAt: row.decided_at ?? undefined,
			decidedBy: row.decided_by ?? undefined,
		}
	} catch (err) {
		console.error(
			`[company-brain] approval ${row.approval_id} has unparseable persisted state; dropping:`,
			err,
		)
		return null
	}
}

export function insertPendingApproval(
	agent: CompanyBrainAgent,
	approval: PendingApproval,
): void {
	agent.sql`
		INSERT INTO brain_pending_approval (
			approval_id, turn_id, org_id, team_id, channel, thread_ts, card_ts,
			asker_user, tool_name, slug, tool_input_json, summary, state_json,
			status, created_at, expires_at, decided_at, decided_by
		) VALUES (
			${approval.approvalId},
			${approval.turnId},
			${approval.orgId},
			${approval.teamId},
			${approval.channel},
			${approval.threadTs},
			${approval.cardTs ?? null},
			${approval.askerUser},
			${approval.toolName},
			${approval.slug ?? null},
			${JSON.stringify(approval.toolInput)},
			${approval.summary},
			${JSON.stringify(approval.state)},
			${approval.status},
			${approval.createdAt},
			${approval.expiresAt},
			${approval.decidedAt ?? null},
			${approval.decidedBy ?? null}
		)
	`
}

export function loadApproval(
	agent: CompanyBrainAgent,
	approvalId: string,
): PendingApproval | null {
	const rows = agent.sql<PendingApprovalRow>`
		SELECT * FROM brain_pending_approval WHERE approval_id = ${approvalId}
	`
	return rows[0] ? rowToApproval(rows[0]) : null
}

export function setApprovalCardTs(
	agent: CompanyBrainAgent,
	approvalId: string,
	cardTs: string | undefined,
): void {
	if (!cardTs) return
	agent.sql`
		UPDATE brain_pending_approval
		SET card_ts = ${cardTs}
		WHERE approval_id = ${approvalId}
	`
}

export function checkpointApprovalResumeState(
	agent: CompanyBrainAgent,
	approvalId: string,
	state: ApprovalResumeState,
): void {
	agent.sql`
		UPDATE brain_pending_approval
		SET state_json = ${JSON.stringify(state)}
		WHERE approval_id = ${approvalId}
	`
}

export function markApprovalDecided(
	agent: CompanyBrainAgent,
	approvalId: string,
	status: "approved" | "denied",
	userId: string,
	now = Date.now(),
): boolean {
	const rows = agent.sql<{ approval_id: string }>`
		UPDATE brain_pending_approval
		SET status = ${status}, decided_at = ${now}, decided_by = ${userId}
		WHERE approval_id = ${approvalId} AND status = 'pending'
		RETURNING approval_id
	`
	return rows.length > 0
}

export function markApprovalTerminal(
	agent: CompanyBrainAgent,
	approvalId: string,
	status: "expired" | "executed" | "cancelled" | "error",
): void {
	agent.sql`
		UPDATE brain_pending_approval
		SET status = ${status}
		WHERE approval_id = ${approvalId}
	`
}
