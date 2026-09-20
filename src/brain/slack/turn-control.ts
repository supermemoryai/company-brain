import type { TurnProgress } from "../turn"
import type { CompanyBrainAgent } from "../turn/agent"
import { APPROVAL_EXPIRY_MS } from "../turn/approval"
import { ensureTurnInboxTable } from "./turn-inbox"

export type ThreadTurnStatus =
	| "running"
	| "waiting_approval"
	| "finalizing"
	| "completed"
	| "cancelled"
	| "superseded"

export type ThreadTurnRow = {
	thread_key: string
	turn_id: string
	revision: number
	status: ThreadTurnStatus
	asker_user: string
	original_question: string
	latest_instruction: string | null
	updated_at: number
}

export type TurnControlSnapshot = {
	threadKey: string
	turnId: string
	revision: number
}

export type RunningTurnControl = TurnControlSnapshot & {
	signal: AbortSignal
}

export type ThreadTurnStartExpectation = {
	turnId: string
	revision: number
	status: ThreadTurnStatus
} | null

export type SteeringIntent = "stop" | "revise" | "none"

export type ThreadTurnFinalizationClaim =
	| "claimed"
	| "updates_pending"
	| "inactive"

type ActiveTurn = RunningTurnControl & {
	controller: AbortController
	notifyCancelled?: (status: "cancelled" | "superseded") => Promise<void>
	notified: boolean
}

const activeTurnsByAgent = new WeakMap<
	CompanyBrainAgent,
	Map<string, ActiveTurn>
>()

const STEERABLE_STATUSES = new Set<ThreadTurnStatus>([
	"running",
	"waiting_approval",
])

const MAX_WAITING_APPROVAL_MS = APPROVAL_EXPIRY_MS

function activeTurns(agent: CompanyBrainAgent): Map<string, ActiveTurn> {
	let turns = activeTurnsByAgent.get(agent)
	if (!turns) {
		turns = new Map()
		activeTurnsByAgent.set(agent, turns)
	}
	return turns
}

function setActiveTurn(
	agent: CompanyBrainAgent,
	threadKey: string,
	active: ActiveTurn,
): void {
	const turns = activeTurns(agent)
	const prior = turns.get(threadKey)
	if (prior && prior.controller !== active.controller) {
		// A previous turn on this thread was replaced without being aborted (racy
		// back-to-back follow-ups); abort it so it stops burning work instead of
		// running to completion as a silent zombie.
		prior.controller.abort(new Error("turn superseded"))
	}
	turns.set(threadKey, active)
}

function now(): number {
	return Date.now()
}

function newTurnId(): string {
	return `turn_${Date.now().toString(36)}_${crypto.randomUUID()}`
}

export function ensureTurnControlTables(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_thread_turn (
			thread_key TEXT PRIMARY KEY,
			turn_id TEXT NOT NULL,
			revision INTEGER NOT NULL,
			status TEXT NOT NULL,
			asker_user TEXT NOT NULL,
			original_question TEXT NOT NULL,
			latest_instruction TEXT,
			updated_at INTEGER NOT NULL
		)
	`
}

export function slackThreadTurnKey(
	teamId: string,
	channel: string,
	threadTs: string,
): string {
	return `${teamId}:${channel}:${threadTs}`
}

// Eviction takes the controller with it, so a missing one means orphaned, not fresh.
export function isSteerableThreadTurn(
	agent: CompanyBrainAgent,
	row: ThreadTurnRow | null | undefined,
): row is ThreadTurnRow {
	if (!row || !STEERABLE_STATUSES.has(row.status)) return false
	if (row.status === "waiting_approval") {
		return now() - row.updated_at < MAX_WAITING_APPROVAL_MS
	}
	const active = activeTurns(agent).get(row.thread_key)
	return (
		active?.turnId === row.turn_id &&
		active.revision === row.revision &&
		!active.controller.signal.aborted
	)
}

export function getThreadTurn(
	agent: CompanyBrainAgent,
	threadKey: string,
): ThreadTurnRow | null {
	const rows = agent.sql<ThreadTurnRow>`
		SELECT * FROM brain_thread_turn WHERE thread_key = ${threadKey}
	`
	return rows[0] ?? null
}

export function threadTurnStartExpectation(
	row:
		| Pick<ThreadTurnRow, "turn_id" | "revision" | "status">
		| null
		| undefined,
): ThreadTurnStartExpectation {
	return row
		? {
				turnId: row.turn_id,
				revision: row.revision,
				status: row.status,
			}
		: null
}

function turnMatchesStartExpectation(
	row: ThreadTurnRow | null,
	expected: ThreadTurnStartExpectation,
): boolean {
	// Once a turn has claimed finalization, its generated answer must be allowed
	// to reach Slack before another revision can replace it.
	if (row?.status === "finalizing") return false
	if (!expected) return row === null
	return (
		row?.turn_id === expected.turnId &&
		row.revision === expected.revision &&
		row.status === expected.status
	)
}

export async function waitForThreadTurnFinalization(
	agent: CompanyBrainAgent,
	expected: TurnControlSnapshot,
): Promise<ThreadTurnRow | null> {
	while (true) {
		const row = getThreadTurn(agent, expected.threadKey)
		if (
			row?.turn_id !== expected.turnId ||
			row.revision !== expected.revision ||
			row.status !== "finalizing"
		) {
			return row
		}

		const active = activeTurns(agent).get(expected.threadKey)
		if (
			!active ||
			active.turnId !== expected.turnId ||
			active.revision !== expected.revision
		) {
			// A finalizing row without its in-memory turn can only be an orphan
			// left by Durable Object eviction. Recover it so the thread can move on.
			agent.sql`
				UPDATE brain_thread_turn
				SET status = ${"completed"}, updated_at = ${now()}
				WHERE thread_key = ${expected.threadKey}
					AND turn_id = ${expected.turnId}
					AND revision = ${expected.revision}
					AND status = ${"finalizing"}
			`
			return getThreadTurn(agent, expected.threadKey)
		}

		await new Promise((resolve) => setTimeout(resolve, 25))
	}
}

export function beginThreadTurn(
	agent: CompanyBrainAgent,
	args: {
		threadKey: string
		askerUser: string
		originalQuestion: string
		latestInstruction?: string | null
		expected: ThreadTurnStartExpectation
	},
): RunningTurnControl | null {
	const existing = getThreadTurn(agent, args.threadKey)
	if (!turnMatchesStartExpectation(existing, args.expected)) return null
	const revision = (existing?.revision ?? 0) + 1
	const turnId = newTurnId()
	const updatedAt = now()
	agent.sql`
		INSERT INTO brain_thread_turn (
			thread_key, turn_id, revision, status, asker_user,
			original_question, latest_instruction, updated_at
		) VALUES (
			${args.threadKey},
			${turnId},
			${revision},
			${"running"},
			${args.askerUser},
			${args.originalQuestion},
			${args.latestInstruction ?? null},
			${updatedAt}
		)
		ON CONFLICT(thread_key) DO UPDATE SET
			turn_id = ${turnId},
			revision = ${revision},
			status = ${"running"},
			asker_user = ${args.askerUser},
			original_question = ${args.originalQuestion},
			latest_instruction = ${args.latestInstruction ?? null},
			updated_at = ${updatedAt}
	`

	const controller = new AbortController()
	const control = {
		threadKey: args.threadKey,
		turnId,
		revision,
		signal: controller.signal,
	}
	setActiveTurn(agent, args.threadKey, {
		...control,
		controller,
		notified: false,
	})
	return control
}

export function resumeThreadTurn(
	agent: CompanyBrainAgent,
	snapshot: TurnControlSnapshot | undefined,
): RunningTurnControl | null {
	if (!snapshot || !isThreadTurnCurrent(agent, snapshot)) return null
	const updatedAt = now()
	agent.sql`
		UPDATE brain_thread_turn
		SET status = ${"running"}, updated_at = ${updatedAt}
		WHERE thread_key = ${snapshot.threadKey}
			AND turn_id = ${snapshot.turnId}
			AND revision = ${snapshot.revision}
	`
	const controller = new AbortController()
	const control = { ...snapshot, signal: controller.signal }
	setActiveTurn(agent, snapshot.threadKey, {
		...control,
		controller,
		notified: false,
	})
	return control
}

export function attachTurnCancelNotifier(
	agent: CompanyBrainAgent,
	control: TurnControlSnapshot,
	notifyCancelled: (status: "cancelled" | "superseded") => Promise<void>,
): void {
	const active = activeTurns(agent).get(control.threadKey)
	if (
		!active ||
		active.turnId !== control.turnId ||
		active.revision !== control.revision
	) {
		return
	}
	active.notifyCancelled = notifyCancelled
}

export function isThreadTurnCurrent(
	agent: CompanyBrainAgent,
	control: TurnControlSnapshot | undefined,
): boolean {
	if (!control) return true
	const row = getThreadTurn(agent, control.threadKey)
	return (
		row?.turn_id === control.turnId &&
		row.revision === control.revision &&
		row.status !== "cancelled" &&
		row.status !== "superseded" &&
		row.status !== "completed"
	)
}

export function markThreadTurnWaitingForApproval(
	agent: CompanyBrainAgent,
	control: TurnControlSnapshot,
): boolean {
	if (!isThreadTurnCurrent(agent, control)) return false
	activeTurns(agent).delete(control.threadKey)
	const existing = getThreadTurn(agent, control.threadKey)
	if (existing?.status === "waiting_approval") return true
	agent.sql`
		UPDATE brain_thread_turn
		SET status = ${"waiting_approval"}, updated_at = ${now()}
		WHERE thread_key = ${control.threadKey}
			AND turn_id = ${control.turnId}
			AND revision = ${control.revision}
			AND status IN (${"running"}, ${"finalizing"})
	`
	return true
}

export function claimThreadTurnApprovalIfInboxEmpty(
	agent: CompanyBrainAgent,
	control: TurnControlSnapshot,
): boolean {
	ensureTurnInboxTable(agent)
	const row = getThreadTurn(agent, control.threadKey)
	if (
		row?.turn_id !== control.turnId ||
		row.revision !== control.revision ||
		row.status !== "running"
	) {
		return false
	}
	agent.sql`
		UPDATE brain_thread_turn
		SET status = ${"waiting_approval"}, updated_at = ${now()}
		WHERE thread_key = ${control.threadKey}
			AND turn_id = ${control.turnId}
			AND revision = ${control.revision}
			AND status = ${"running"}
			AND NOT EXISTS (
				SELECT 1 FROM brain_thread_turn_update
				WHERE thread_key = ${control.threadKey}
					AND turn_id = ${control.turnId}
					AND revision = ${control.revision}
					AND status IN (${"classifying"}, ${"pending"})
			)
	`
	return getThreadTurn(agent, control.threadKey)?.status === "waiting_approval"
}

export function markThreadTurnCompleted(
	agent: CompanyBrainAgent,
	control: TurnControlSnapshot | undefined,
): void {
	if (!control || !isThreadTurnCurrent(agent, control)) return
	activeTurns(agent).delete(control.threadKey)
	agent.sql`
		UPDATE brain_thread_turn
		SET status = ${"completed"}, updated_at = ${now()}
		WHERE thread_key = ${control.threadKey}
			AND turn_id = ${control.turnId}
			AND revision = ${control.revision}
	`
}

// A turn can exit by throw or early return, and only this drops the controller it left behind.
export function reapUnfinishedThreadTurn(
	agent: CompanyBrainAgent,
	control: TurnControlSnapshot | undefined,
): void {
	if (!control) return
	const row = getThreadTurn(agent, control.threadKey)
	if (
		row?.turn_id !== control.turnId ||
		row.revision !== control.revision ||
		row.status !== "running"
	) {
		return
	}
	markThreadTurnCompleted(agent, control)
}

function settleInterruptedThreadTurn(
	agent: CompanyBrainAgent,
	control: TurnControlSnapshot | undefined,
	status: "completed" | "superseded",
): boolean {
	if (!control) return false
	const row = getThreadTurn(agent, control.threadKey)
	if (
		row?.turn_id !== control.turnId ||
		row.revision !== control.revision ||
		!["running", "waiting_approval", "finalizing"].includes(row.status)
	) {
		return false
	}
	const active = activeTurns(agent).get(control.threadKey)
	if (
		active?.turnId === control.turnId &&
		active.revision === control.revision
	) {
		activeTurns(agent).delete(control.threadKey)
		active.controller.abort(new Error(`interrupted turn ${status}`))
	}
	agent.sql`
		UPDATE brain_thread_turn
		SET status = ${status}, updated_at = ${now()}
		WHERE thread_key = ${control.threadKey}
			AND turn_id = ${control.turnId}
			AND revision = ${control.revision}
			AND status IN (${"running"}, ${"waiting_approval"}, ${"finalizing"})
	`
	return getThreadTurn(agent, control.threadKey)?.status === status
}

export function completeInterruptedThreadTurn(
	agent: CompanyBrainAgent,
	control: TurnControlSnapshot | undefined,
): boolean {
	return settleInterruptedThreadTurn(agent, control, "completed")
}

export function supersedeInterruptedThreadTurn(
	agent: CompanyBrainAgent,
	control: TurnControlSnapshot | undefined,
): boolean {
	return settleInterruptedThreadTurn(agent, control, "superseded")
}

export function claimThreadTurnFinalizationIfInboxEmpty(
	agent: CompanyBrainAgent,
	control: TurnControlSnapshot,
): ThreadTurnFinalizationClaim {
	ensureTurnInboxTable(agent)
	const row = getThreadTurn(agent, control.threadKey)
	if (row?.turn_id !== control.turnId || row.revision !== control.revision) {
		return "inactive"
	}
	// The claim is idempotent for this exact turn. This matters when a delivery
	// resumes after the SQL update committed but before its caller observed it.
	if (row.status === "finalizing") return "claimed"
	if (row.status !== "running") return "inactive"

	const updatedAt = now()
	agent.sql`
		UPDATE brain_thread_turn
		SET status = ${"finalizing"}, updated_at = ${updatedAt}
		WHERE thread_key = ${control.threadKey}
			AND turn_id = ${control.turnId}
			AND revision = ${control.revision}
			AND status = ${"running"}
			AND NOT EXISTS (
				SELECT 1 FROM brain_thread_turn_update
				WHERE thread_key = ${control.threadKey}
					AND turn_id = ${control.turnId}
					AND revision = ${control.revision}
					AND status IN (${"classifying"}, ${"pending"})
			)
	`
	const claimed = getThreadTurn(agent, control.threadKey)
	if (
		claimed?.turn_id !== control.turnId ||
		claimed.revision !== control.revision
	) {
		return "inactive"
	}
	if (claimed.status === "finalizing") return "claimed"
	return claimed.status === "running" ? "updates_pending" : "inactive"
}

export async function interruptThreadTurn(
	agent: CompanyBrainAgent,
	threadKey: string,
	status: "cancelled" | "superseded",
	latestInstruction?: string,
): Promise<{ row: ThreadTurnRow | null; aborted: boolean; notified: boolean }> {
	const row = getThreadTurn(agent, threadKey)
	if (!isSteerableThreadTurn(agent, row)) {
		return { row, aborted: false, notified: false }
	}
	agent.sql`
		UPDATE brain_thread_turn
		SET status = ${status},
			latest_instruction = ${latestInstruction ?? row.latest_instruction ?? null},
			updated_at = ${now()}
		WHERE thread_key = ${threadKey}
			AND turn_id = ${row.turn_id}
			AND revision = ${row.revision}
			AND status IN (${"running"}, ${"waiting_approval"})
	`

	const active = activeTurns(agent).get(threadKey)
	const shouldNotify =
		Boolean(active) &&
		active?.turnId === row.turn_id &&
		active.revision === row.revision &&
		!active.notified
	if (
		active &&
		active.turnId === row.turn_id &&
		active.revision === row.revision
	) {
		activeTurns(agent).delete(threadKey)
		active.controller.abort(new Error(`turn ${status}`))
		if (shouldNotify && active.notifyCancelled) {
			active.notified = true
			await active.notifyCancelled(status)
		}
	}
	return { row, aborted: Boolean(active), notified: shouldNotify }
}

export function fencedProgress(
	agent: CompanyBrainAgent,
	control: TurnControlSnapshot | undefined,
	progress: TurnProgress,
): TurnProgress {
	if (!control) return progress
	return {
		card: async (...args) => {
			if (!isThreadTurnCurrent(agent, control)) return
			await progress.card(...args)
		},
		narrate: progress.narrate
			? async (text) => {
					if (!isThreadTurnCurrent(agent, control)) return false
					return (await progress.narrate?.(text)) ?? false
				}
			: undefined,
	}
}

export function classifyTurnSteering(text: string): SteeringIntent {
	const normalized = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s']/gu, " ")
		.replace(/\s+/g, " ")
		.trim()

	if (!normalized) return "none"

	const lowSignal = new Set([
		"k",
		"ok",
		"okay",
		"kk",
		"cool",
		"nice",
		"thanks",
		"thank you",
		"ty",
		"got it",
		"sounds good",
	])
	if (lowSignal.has(normalized)) return "none"

	// An explicit "don't stop / don't cancel" means keep the active turn running,
	// so treat it as non-steering rather than a stop or a restart.
	const negatesStop =
		/\b(don't|dont|do not|never)\s+(stop|cancel|abort|halt|pause)\b/.test(
			normalized,
		)
	if (negatesStop) return "none"

	const saysStop = /\b(stop|cancel|abort|halt|pause)\b/.test(normalized)
	const stopPhrase =
		/\b(never\s?mind|nvm|no need|forget it|scratch that)\b/.test(normalized)
	const stopVerb =
		/\b(don't|dont) (do|run|send|post|create|execute|continue)\b/.test(
			normalized,
		)
	if (saysStop || stopPhrase || stopVerb) {
		return "stop"
	}

	if (
		/^(no|nah|wait|actually|instead|rather|also|but|use)\b/.test(normalized) ||
		/\b(no actually|do this|do that|change it|make it|include|exclude|without|with)\b/.test(
			normalized,
		)
	) {
		return "revise"
	}

	// While a turn is active, a substantive requester follow-up is usually new
	// guidance for the active task rather than a separate Slack conversation.
	return normalized.length >= 8 ? "revise" : "none"
}
