import type { ModelMessage } from "ai"
import { compactMessagesAtBoundary } from "../context"

const LIVE_UPDATE_REBASE_INSTRUCTION = [
	"<live_update_rebase>",
	"New thread updates arrived after a complete reply draft was ready but before it could be published.",
	"Preserve every still-correct part of the draft, incorporate all attributed updates, and produce one complete replacement answer rather than a patch or addendum.",
	"Use tools only when an update requires evidence that has not already been gathered. When the revised answer is complete, submit it through finish_turn.",
	"</live_update_rebase>",
].join("\n")

/** Re-prompts from the completed draft without discarding gathered evidence. */
export function rebaseFinalReply(args: {
	messages: ModelMessage[]
	draft: string
	activeDiscoveryApps: string[]
}): ModelMessage[] {
	const draft = args.draft.trim()
	const instruction = draft
		? [
				LIVE_UPDATE_REBASE_INSTRUCTION,
				"<reply_draft>",
				draft,
				"</reply_draft>",
			].join("\n")
		: LIVE_UPDATE_REBASE_INSTRUCTION
	return [
		...compactMessagesAtBoundary(args.messages, {
			activeDiscoveryApps: args.activeDiscoveryApps,
			preserveLoadedSkills: true,
		}),
		{ role: "user", content: instruction },
	]
}
