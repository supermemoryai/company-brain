import type { ModelMessage } from "ai"
import type { ActiveLease } from "../../lease/types"
import type { CompanyBrainAgent } from "../../turn/agent"
import type { TurnApprovalRequest } from "../../turn/types"

export const CONNECTED_APP_RUNTIME_NAME = "connected_apps"
export const CODE_PAUSE_TTL_MS = 15 * 60 * 1000

export type ConnectedAppServerRef = {
	serverSlug: string
	connectorName: string
	connectionId: string
	accessScope: "personal" | "organization" | "temporary"
	readOnly: boolean
	leaseId?: string
	leaseMode?: ActiveLease["mode"]
}

export type ConnectedAppPauseRef = {
	executionId: string
	outerToolCallId: string
}

export type CodePauseJournal = {
	version: 1
	runtimeName: typeof CONNECTED_APP_RUNTIME_NAME
	executionId: string
	orgId: string
	threadKey: string
	seq: number
	outerToolCallId: string
	nativeCallStart: number
	sources: ConnectedAppServerRef[]
	pending: {
		app: string
		appLabel?: string
		method: string
		args: unknown
	}
	createdAt: number
}

type CodePauseRow = {
	execution_id: string
	org_id: string
	thread_key: string
	journal: string
	created_at: number
}

function validServerRef(value: unknown): value is ConnectedAppServerRef {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const ref = value as Partial<ConnectedAppServerRef>
	return (
		typeof ref.serverSlug === "string" &&
		typeof ref.connectorName === "string" &&
		typeof ref.connectionId === "string" &&
		["personal", "organization", "temporary"].includes(ref.accessScope ?? "") &&
		typeof ref.readOnly === "boolean"
	)
}

function validJournal(value: unknown): value is CodePauseJournal {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const journal = value as Partial<CodePauseJournal>
	return (
		journal.version === 1 &&
		journal.runtimeName === CONNECTED_APP_RUNTIME_NAME &&
		typeof journal.executionId === "string" &&
		typeof journal.orgId === "string" &&
		typeof journal.threadKey === "string" &&
		Number.isInteger(journal.seq) &&
		typeof journal.outerToolCallId === "string" &&
		Number.isInteger(journal.nativeCallStart) &&
		Array.isArray(journal.sources) &&
		journal.sources.every(validServerRef) &&
		Boolean(journal.pending) &&
		typeof journal.pending?.app === "string" &&
		(journal.pending?.appLabel === undefined ||
			typeof journal.pending.appLabel === "string") &&
		typeof journal.pending?.method === "string" &&
		typeof journal.createdAt === "number"
	)
}

export function ensureCodePauseTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_code_pause (
			execution_id TEXT PRIMARY KEY,
			org_id TEXT NOT NULL,
			thread_key TEXT NOT NULL,
			journal BLOB NOT NULL,
			created_at INTEGER NOT NULL
		)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_code_pause_created_at_idx
		ON brain_code_pause (created_at)
	`
}

export function saveCodePause(
	agent: CompanyBrainAgent,
	journal: CodePauseJournal,
): void {
	ensureCodePauseTable(agent)
	agent.sql`
		INSERT INTO brain_code_pause (
			execution_id, org_id, thread_key, journal, created_at
		) VALUES (
			${journal.executionId},
			${journal.orgId},
			${journal.threadKey},
			${JSON.stringify(journal)},
			${journal.createdAt}
		)
		ON CONFLICT (execution_id) DO UPDATE SET
			org_id = excluded.org_id,
			thread_key = excluded.thread_key,
			journal = excluded.journal,
			created_at = excluded.created_at
	`
}

export function loadCodePause(
	agent: CompanyBrainAgent,
	ref: ConnectedAppPauseRef,
	now = Date.now(),
): CodePauseJournal | undefined {
	ensureCodePauseTable(agent)
	const [row] = agent.sql<CodePauseRow>`
		SELECT * FROM brain_code_pause
		WHERE execution_id = ${ref.executionId}
			AND created_at > ${now - CODE_PAUSE_TTL_MS}
		LIMIT 1
	`
	if (!row) return undefined
	try {
		const parsed: unknown = JSON.parse(row.journal)
		if (
			validJournal(parsed) &&
			parsed.executionId === row.execution_id &&
			parsed.orgId === row.org_id &&
			parsed.threadKey === row.thread_key &&
			parsed.outerToolCallId === ref.outerToolCallId
		) {
			return parsed
		}
	} catch {}
	deleteCodePause(agent, ref.executionId)
	return undefined
}

export function deleteCodePause(
	agent: CompanyBrainAgent,
	executionId: string,
): void {
	ensureCodePauseTable(agent)
	agent.sql`
		DELETE FROM brain_code_pause WHERE execution_id = ${executionId}
	`
}

export function sweepExpiredCodePauses(
	agent: CompanyBrainAgent,
	now = Date.now(),
): number {
	ensureCodePauseTable(agent)
	return agent.sql<{ execution_id: string }>`
		DELETE FROM brain_code_pause
		WHERE created_at <= ${now - CODE_PAUSE_TTL_MS}
		RETURNING execution_id
	`.length
}

const SENSITIVE_ARGUMENT_RE =
	/token|secret|password|authorization|api[_-]?key|cookie/i

function humanizeIdentifier(value: string): string {
	const words = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[_\-\s.]+/)
	const label = words.filter(Boolean).join(" ")
	return label
		? `${label.charAt(0).toUpperCase()}${label.slice(1).toLowerCase()}`
		: "Action"
}

function conciseApprovalValue(value: unknown, key?: string): string {
	if (key && SENSITIVE_ARGUMENT_RE.test(key)) return "[redacted]"
	if (value === null) return "None"
	if (value === undefined) return "Not set"
	if (typeof value === "string") return value
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value)
	}
	if (Array.isArray(value)) {
		return value.map((item) => conciseApprovalValue(item)).join(", ")
	}
	if (typeof value === "object") {
		return Object.entries(value as Record<string, unknown>)
			.map(
				([nestedKey, item]) =>
					`${humanizeIdentifier(nestedKey)}: ${conciseApprovalValue(item, nestedKey)}`,
			)
			.join("; ")
	}
	return String(value)
}

function approvalArgumentSummary(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return `• *Details:* ${conciseApprovalValue(value)}`
	}
	const entries = Object.entries(value as Record<string, unknown>)
	if (entries.length === 0) return ""
	return entries
		.map(([key, item]) => {
			const formatted = conciseApprovalValue(item, key)
			const label = humanizeIdentifier(key)
			return formatted.includes("\n") || formatted.length > 160
				? `• *${label}:*\n${formatted}`
				: `• *${label}:* ${formatted}`
		})
		.join("\n")
}

export function approvalForCodePause(
	journal: CodePauseJournal,
): TurnApprovalRequest {
	const identity = `${journal.pending.app}.${journal.pending.method}`
	const appLabel = journal.pending.appLabel?.trim() || journal.pending.app
	const operation = humanizeIdentifier(journal.pending.method)
	const argumentsSummary = approvalArgumentSummary(journal.pending.args)
	return {
		approvalId: `connected_app:${journal.executionId}:${journal.seq}`,
		toolCallId: journal.outerToolCallId,
		toolName: "run_app_code",
		slug: identity,
		input: {
			tool: identity,
			slug: identity,
			arguments: journal.pending.args,
		},
		summary: `${operation} in ${appLabel}${argumentsSummary ? `\n\n${argumentsSummary}` : ""}`,
	}
}

export function replaceConnectedAppToolResult(
	messages: ModelMessage[],
	toolCallId: string,
	output: unknown,
): ModelMessage[] {
	let replaced = false
	const updated = messages.map((message) => {
		if (message.role !== "tool" || !Array.isArray(message.content)) {
			return message
		}
		let changed = false
		const content = message.content.map((part) => {
			if (part.type !== "tool-result" || part.toolCallId !== toolCallId) {
				return part
			}
			changed = true
			replaced = true
			return {
				...part,
				output: { type: "json" as const, value: output as never },
			}
		})
		return changed ? ({ ...message, content } as ModelMessage) : message
	})
	if (!replaced) {
		throw new Error(
			`Could not find paused run_app_code result '${toolCallId}' while resuming approval.`,
		)
	}
	return updated
}
