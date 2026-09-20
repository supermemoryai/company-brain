import type { ModelMessage } from "ai"
import {
	isPublishableSlackReply,
	sanitizeSlackReply,
} from "../../observability/reply-quality"
import type { TurnTerminalProposal } from "../terminal"

export type TurnReplySource = "terminal" | "text" | "response" | "empty"

type TurnReplyResult = {
	readonly text: PromiseLike<string>
	readonly response: PromiseLike<{ messages: ModelMessage[] }>
}

function assistantDrafts(messages: ModelMessage[]): string[] {
	const drafts: string[] = []
	for (const message of messages) {
		if (message.role !== "assistant") continue
		if (typeof message.content === "string") {
			drafts.push(message.content)
			continue
		}
		for (const part of message.content) {
			if (part.type === "text") drafts.push(part.text)
		}
	}
	return drafts
}

function publishable(text: string): string {
	const reply = sanitizeSlackReply(text)
	return isPublishableSlackReply(reply) ? reply : ""
}

/** Selects reply content without invoking another model or judging semantics. */
export async function selectTurnReply(args: {
	result: TurnReplyResult
	terminalProposal?: TurnTerminalProposal
}): Promise<{ reply: string; source: TurnReplySource }> {
	if (args.terminalProposal) {
		const reply = publishable(args.terminalProposal.reply)
		if (reply) return { reply, source: "terminal" }
	}

	try {
		const reply = publishable(await args.result.text)
		if (reply) return { reply, source: "text" }
	} catch {
		// The response transcript below is the deterministic recovery source.
	}

	try {
		const { messages } = await args.result.response
		const reply = assistantDrafts(messages)
			.map(publishable)
			.filter(Boolean)
			.sort((left, right) => right.length - left.length)[0]
		if (reply) return { reply, source: "response" }
	} catch {
		// The caller owns the final empty-reply fallback.
	}

	return { reply: "", source: "empty" }
}
