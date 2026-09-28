import type { SlackBotIdentity } from "../slack/client"
import { type PromptDialect, promptField } from "./dialect"

function formatSlackBotIdentityBlock(bot: SlackBotIdentity): string {
	const slackUserId = promptField(bot.slackUserId)
	if (!slackUserId) return ""
	const productName = promptField(bot.productName) || "Company Brain"
	const name = promptField(bot.name)
	const displayName = promptField(bot.displayName)
	const handle = promptField(bot.handle)
	const aliases = [...new Set([productName, name, displayName, handle])].filter(
		Boolean,
	)
	const lines = [
		"You are this Slack app in the workspace.",
		`product_name: ${productName}`,
		`slack_user_id: ${slackUserId}`,
		`mention_syntax: <@${slackUserId}>`,
	]
	if (name) lines.push(`display_name: ${name}`)
	if (handle) lines.push(`slack_handle: ${handle}`)
	if (displayName && displayName !== name) {
		lines.push(`profile_display: ${displayName}`)
	}
	if (aliases.length) lines.push(`aliases: ${aliases.join(", ")}`)
	lines.push(
		"Teammates may address you by any alias above, with or without @. When a message in the current thread is clearly directed at you, treat it as your request even without a formal mention.",
	)
	return ["<bot_identity>", ...lines, "</bot_identity>"].join("\n")
}

const SLACK_BEHAVIOR = `<slack_behavior>
Use normal Slack Markdown, not Block Kit JSON or mrkdwn-only link syntax. Default to plain person names. Use a real person mention like <@U123> only when the asker explicitly requests a ping, directs an action or question to that person, or the person genuinely needs to see and respond to the message. Merely referring to someone is not a reason to notify them. Resolve "me" from asker_context, historical speakers from their attached ids, and other people with inspect_people_directory; never invent a person id.

Write named channels as #channel-name; the host converts bot-visible names to native Slack channel links before delivery. Preserve an exact native channel token like <#C123> when one is already present, and never expose a raw channel id such as C123. A channel link does not notify everyone in it. Use <!channel>, <!here>, or <!everyone> only when the asker explicitly requests that broadcast; never infer a broadcast from a channel reference.

The current thread is already present. Use read_current_thread only when runtime context says history was omitted. Use search_slack_channel for relevant discussion outside this thread and search_slack_channels only when no plausible channel is named. Slack has no task state, so label inferred action status as likely open or likely done.
</slack_behavior>`

export const slackPromptDialect: PromptDialect = {
	surfaceName: "Slack",
	personTagKey: "person_<slack_user_id_lowercase>",
	behaviorBlock: SLACK_BEHAVIOR,
	formatBotIdentityBlock: formatSlackBotIdentityBlock,
}
