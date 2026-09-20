import type { ActiveTurnGateResult } from "./active-turn-gate"
import type { TurnControlSnapshot } from "./turn-control"

type SqlExecutor = {
	sql<T>(strings: TemplateStringsArray, ...values: unknown[]): T[]
}

export type TurnInboxUpdate = {
	thread_key: string
	turn_id: string
	revision: number
	message_ts: string
	author_user: string
	author_name: string | null
	instruction: string
	outcome: ActiveTurnGateResult
	status: "classifying" | "pending" | "applied" | "ignored"
	created_at: number
	applied_at: number | null
}

export type TurnUpdateReservation = "reserved" | "duplicate" | "inactive"

function normalizedInstruction(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim()
}

export function ensureTurnInboxTable(agent: SqlExecutor): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_thread_turn_update (
			thread_key TEXT NOT NULL,
			turn_id TEXT NOT NULL,
			revision INTEGER NOT NULL,
			message_ts TEXT NOT NULL,
			author_user TEXT NOT NULL,
			author_name TEXT,
			instruction TEXT NOT NULL,
			outcome TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			applied_at INTEGER,
			PRIMARY KEY (thread_key, message_ts)
		)
	`
}

export function reserveTurnUpdate(
	agent: SqlExecutor,
	args: {
		threadKey: string
		turnId: string
		revision: number
		messageTs: string
		authorUser: string
		authorName?: string | null
		instruction: string
	},
): TurnUpdateReservation {
	ensureTurnInboxTable(agent)
	const current = agent.sql<{ turn_id: string }>`
		SELECT turn_id FROM brain_thread_turn
		WHERE thread_key = ${args.threadKey}
			AND turn_id = ${args.turnId}
			AND revision = ${args.revision}
			AND status IN (${"running"}, ${"waiting_approval"})
		LIMIT 1
	`
	if (!current.length) return "inactive"

	const existingDelivery = agent.sql<{ message_ts: string }>`
		SELECT message_ts FROM brain_thread_turn_update
		WHERE thread_key = ${args.threadKey}
			AND message_ts = ${args.messageTs}
		LIMIT 1
	`
	if (existingDelivery.length) return "duplicate"

	const recent = agent.sql<{ author_user: string; instruction: string }>`
		SELECT author_user, instruction FROM brain_thread_turn_update
		WHERE thread_key = ${args.threadKey}
			AND turn_id = ${args.turnId}
			AND revision = ${args.revision}
			AND status IN (${"classifying"}, ${"pending"}, ${"applied"})
			AND created_at >= ${Date.now() - 30_000}
	`
	const duplicate = recent.some(
		(row) =>
			row.author_user === args.authorUser &&
			normalizedInstruction(row.instruction) ===
				normalizedInstruction(args.instruction),
	)
	const status = duplicate ? "ignored" : "classifying"
	const outcome: ActiveTurnGateResult = duplicate ? "ignore" : "append"
	const appliedAt = duplicate ? Date.now() : null
	agent.sql`
		INSERT INTO brain_thread_turn_update (
			thread_key, turn_id, revision, message_ts, author_user,
			author_name, instruction, outcome, status, created_at, applied_at
		) SELECT
			${args.threadKey}, ${args.turnId}, ${args.revision}, ${args.messageTs},
			${args.authorUser}, ${args.authorName ?? null}, ${args.instruction},
			${outcome}, ${status}, ${Date.now()}, ${appliedAt}
		WHERE EXISTS (
			SELECT 1 FROM brain_thread_turn
			WHERE thread_key = ${args.threadKey}
				AND turn_id = ${args.turnId}
				AND revision = ${args.revision}
				AND status IN (${"running"}, ${"waiting_approval"})
		)
		ON CONFLICT(thread_key, message_ts) DO NOTHING
	`
	const inserted = agent.sql<{ status: string }>`
		SELECT status FROM brain_thread_turn_update
		WHERE thread_key = ${args.threadKey}
			AND message_ts = ${args.messageTs}
		LIMIT 1
	`
	if (!inserted.length) return "inactive"
	return duplicate ? "duplicate" : "reserved"
}

export function discardTurnUpdateReservation(
	agent: SqlExecutor,
	args: {
		threadKey: string
		turnId: string
		revision: number
		messageTs: string
	},
): void {
	agent.sql`
		DELETE FROM brain_thread_turn_update
		WHERE thread_key = ${args.threadKey}
			AND turn_id = ${args.turnId}
			AND revision = ${args.revision}
			AND message_ts = ${args.messageTs}
			AND status = ${"classifying"}
	`
}

export function resolveTurnUpdate(
	agent: SqlExecutor,
	args: {
		threadKey: string
		messageTs: string
		outcome: ActiveTurnGateResult
		status: "pending" | "ignored"
	},
): boolean {
	ensureTurnInboxTable(agent)
	agent.sql`
		UPDATE brain_thread_turn_update
		SET outcome = ${args.outcome},
			status = ${args.status},
			applied_at = ${args.status === "ignored" ? Date.now() : null}
		WHERE thread_key = ${args.threadKey}
			AND message_ts = ${args.messageTs}
			AND status = ${"classifying"}
	`
	const rows = agent.sql<{ status: string }>`
		SELECT status FROM brain_thread_turn_update
		WHERE thread_key = ${args.threadKey}
			AND message_ts = ${args.messageTs}
		LIMIT 1
	`
	return rows[0]?.status === args.status
}

export function listCurrentTurnUpdates(
	agent: SqlExecutor,
	args: { threadKey: string; turnId: string; revision: number },
): TurnInboxUpdate[] {
	ensureTurnInboxTable(agent)
	return agent.sql<TurnInboxUpdate>`
		SELECT * FROM brain_thread_turn_update
		WHERE thread_key = ${args.threadKey}
			AND turn_id = ${args.turnId}
			AND revision = ${args.revision}
			AND status IN (${"pending"}, ${"applied"})
		ORDER BY CAST(substr(message_ts, 1, instr(message_ts, '.') - 1) AS INTEGER),
			CAST(substr(message_ts, instr(message_ts, '.') + 1) AS INTEGER)
	`
}

export function consumePendingTurnUpdates(
	agent: SqlExecutor,
	control: TurnControlSnapshot,
): TurnInboxUpdate[] {
	ensureTurnInboxTable(agent)
	const updates = agent.sql<TurnInboxUpdate>`
		SELECT * FROM brain_thread_turn_update
		WHERE thread_key = ${control.threadKey}
			AND turn_id = ${control.turnId}
			AND revision = ${control.revision}
			AND status = ${"pending"}
		ORDER BY CAST(substr(message_ts, 1, instr(message_ts, '.') - 1) AS INTEGER),
			CAST(substr(message_ts, instr(message_ts, '.') + 1) AS INTEGER)
	`
	if (!updates.length) return []

	const appliedAt = Date.now()
	for (const update of updates) {
		agent.sql`
			UPDATE brain_thread_turn_update
			SET status = ${"applied"}, applied_at = ${appliedAt}
			WHERE thread_key = ${control.threadKey}
				AND message_ts = ${update.message_ts}
				AND status = ${"pending"}
		`
	}
	return updates
}

export function hasClassifyingTurnUpdates(
	agent: SqlExecutor,
	control: TurnControlSnapshot,
): boolean {
	ensureTurnInboxTable(agent)
	const rows = agent.sql<{ count: number }>`
		SELECT COUNT(*) AS count FROM brain_thread_turn_update
		WHERE thread_key = ${control.threadKey}
			AND turn_id = ${control.turnId}
			AND revision = ${control.revision}
			AND status = ${"classifying"}
	`
	return (rows[0]?.count ?? 0) > 0
}

export async function waitForTurnUpdateClassification(
	agent: SqlExecutor,
	control: TurnControlSnapshot,
	abortSignal?: AbortSignal,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (hasClassifyingTurnUpdates(agent, control) && Date.now() < deadline) {
		if (abortSignal?.aborted) return
		await new Promise((resolve) => setTimeout(resolve, 25))
	}
	if (!hasClassifyingTurnUpdates(agent, control)) return

	// A stuck classifier must not strand the turn. Preserve the fail-open policy
	// by converting unresolved reservations into pending APPEND updates.
	agent.sql`
		UPDATE brain_thread_turn_update
		SET outcome = ${"append"}, status = ${"pending"}
		WHERE thread_key = ${control.threadKey}
			AND turn_id = ${control.turnId}
			AND revision = ${control.revision}
			AND status = ${"classifying"}
	`
}

export function formatTurnUpdates(updates: TurnInboxUpdate[]): string {
	return [
		"<live_thread_updates>",
		...updates.map((update) => {
			const author = update.author_name || update.author_user
			return update.outcome === "replace"
				? `${author} proposed a conflicting follow-up. Do not replace the original request; finish it, then address this separately: ${update.instruction}`
				: `${author}: ${update.instruction}`
		}),
		"</live_thread_updates>",
	].join("\n")
}
