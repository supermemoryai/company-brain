import type { SlackBotIdentity } from "../slack/client"

/** The parts of the system prompt that are specific to the chat surface. */
export type PromptDialect = {
	/** Name of the surface as it appears inline in prose ("a teammate in Slack"). */
	surfaceName: string
	/** Memory tag key pattern used for teammates. */
	personTagKey: string
	/** Full prompt block describing how replies, mentions and channels work here. */
	behaviorBlock: string
	/** Prompt block naming the bot in this workspace; empty when it has no id. */
	formatBotIdentityBlock: (bot: SlackBotIdentity) => string
}

export function promptField(value: string | undefined): string {
	const withoutControls = [...(value ?? "").normalize("NFKC")]
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0
			return codePoint <= 0x1f || codePoint === 0x7f ? " " : character
		})
		.join("")
	return withoutControls
		.replace(/\s+/g, " ")
		.trim()
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
}
