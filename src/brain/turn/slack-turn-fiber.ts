import type { SlackTurnMessage } from "../slack/events"
import type { TurnControlSnapshot } from "../slack/turn-control"
import type { TurnTerminalProposal } from "./terminal"

export const SLACK_TURN_FIBER_NAME = "company-brain-slack-turn"
export const MAX_SLACK_TURN_RECOVERY_ATTEMPTS = 1

export type SlackTurnFiberPhase =
	| "accepted"
	| "running"
	| "progress"
	| "waiting_approval"
	| "answered"
	| "completed"

export type SlackTurnFiberSnapshot = {
	version: 1
	message: SlackTurnMessage
	attempt: number
	phase: SlackTurnFiberPhase
	threadKey?: string
	turnId?: string
	turnRevision?: number
	progressMessageTs?: string
	replyMessageTs?: string
	approvalMessageTs?: string
	terminalProposal?: TurnTerminalProposal
}

export type SlackTurnFiberCheckpoint = Partial<
	Pick<
		SlackTurnFiberSnapshot,
		| "phase"
		| "threadKey"
		| "turnId"
		| "turnRevision"
		| "replyMessageTs"
		| "approvalMessageTs"
	>
> & {
	progressMessageTs?: string | null
	terminalProposal?: TurnTerminalProposal | null
}

export type SlackTurnFiberControl = {
	attempt: number
	progressMessageTs?: string
	recoveredTurn?: TurnControlSnapshot
	signal: AbortSignal
	checkpoint(update: SlackTurnFiberCheckpoint): void
}

export function recoverableSlackTurnMessage(
	message: SlackTurnMessage,
): SlackTurnMessage {
	const { workspace: _workspace, ...recoverable } = message
	return recoverable
}

export function slackTurnFiberIdempotencyKey(
	message: SlackTurnMessage,
): string {
	if (message.eventId) return `slack:${message.teamId}:${message.eventId}`
	const event = message.event
	return [
		"slack",
		message.teamId,
		event.channel ?? "unknown",
		event.ts ?? event.event_ts ?? "unknown",
		event.type,
	].join(":")
}

export function parseSlackTurnFiberSnapshot(
	value: unknown,
): SlackTurnFiberSnapshot | null {
	if (!value || typeof value !== "object") return null
	const snapshot = value as Partial<SlackTurnFiberSnapshot>
	if (
		snapshot.version !== 1 ||
		!snapshot.message ||
		typeof snapshot.message !== "object" ||
		typeof snapshot.message.teamId !== "string" ||
		!snapshot.message.event ||
		typeof snapshot.message.event !== "object" ||
		typeof snapshot.attempt !== "number" ||
		typeof snapshot.phase !== "string" ||
		(snapshot.turnId !== undefined && typeof snapshot.turnId !== "string") ||
		(snapshot.turnRevision !== undefined &&
			typeof snapshot.turnRevision !== "number") ||
		(snapshot.terminalProposal !== undefined &&
			(typeof snapshot.terminalProposal !== "object" ||
				typeof snapshot.terminalProposal.reply !== "string" ||
				!snapshot.terminalProposal.reply.trim() ||
				!["answered", "blocked", "nothing_found"].includes(
					snapshot.terminalProposal.outcome ?? "",
				)))
	) {
		return null
	}
	return snapshot as SlackTurnFiberSnapshot
}
