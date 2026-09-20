import type { TurnDeps } from "./deps"

export const FINISH_TURN_TOOL_NAME = "finish_turn"

export const TURN_TERMINAL_OUTCOMES = [
	"answered",
	"blocked",
	"nothing_found",
] as const

export type TurnTerminalOutcome = (typeof TURN_TERMINAL_OUTCOMES)[number]

export type TurnTerminalProposal = {
	outcome: TurnTerminalOutcome
	reply: string
}

type TerminalToolCall = {
	toolCallId: string
	toolName: string
	input?: unknown
}

export type TurnTerminalCapture = {
	record(toolCall: TerminalToolCall): TurnTerminalProposal | undefined
	requested(): boolean
	selected(): TurnTerminalProposal | undefined
	count(): number
}

function parseTerminalProposal(
	input: unknown,
): TurnTerminalProposal | undefined {
	if (!input || typeof input !== "object") return undefined
	const value = input as { outcome?: unknown; reply?: unknown }
	if (
		typeof value.outcome !== "string" ||
		!TURN_TERMINAL_OUTCOMES.includes(value.outcome as TurnTerminalOutcome) ||
		typeof value.reply !== "string" ||
		!value.reply.trim()
	) {
		return undefined
	}
	return {
		outcome: value.outcome as TurnTerminalOutcome,
		reply: value.reply.trim(),
	}
}

/**
 * Captures terminal calls when execution starts, preserving the model-emitted
 * order instead of the completion order of concurrently executed tools.
 */
export function createTurnTerminalCapture(args?: {
	onProposal?: (proposal: TurnTerminalProposal) => void
}): TurnTerminalCapture {
	let selectedProposal: TurnTerminalProposal | undefined
	let proposalCount = 0
	return {
		record(toolCall) {
			if (toolCall.toolName !== FINISH_TURN_TOOL_NAME) return undefined
			const proposal = parseTerminalProposal(toolCall.input)
			if (!proposal) return undefined
			proposalCount += 1
			selectedProposal = proposal
			args?.onProposal?.(proposal)
			return proposal
		},
		requested: () => selectedProposal !== undefined,
		selected: () => selectedProposal,
		count: () => proposalCount,
	}
}

export function createFinishTurnTool(deps: TurnDeps) {
	return deps.tool({
		description:
			"Submit the complete final reply for this turn. Call this exactly once when the user's active requests have been answered, are concretely blocked, or the requested information was not found. The reply is what the user will receive, so make it standalone and complete. Do not continue working or write another answer after calling this tool.",
		inputSchema: deps.z.object({
			outcome: deps.z
				.enum(TURN_TERMINAL_OUTCOMES)
				.describe(
					"answered when the request is fulfilled; blocked when a concrete dependency prevents completion; nothing_found when the requested search completed without finding the information.",
				),
			reply: deps.z
				.string()
				.min(1)
				.describe(
					"The complete user-facing final reply in normal Slack Markdown.",
				),
		}),
		execute: async ({ outcome }) => ({ accepted: true, outcome }),
	})
}
