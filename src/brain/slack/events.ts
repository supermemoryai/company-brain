import { z } from "zod"
import type { SlackWorkspaceRow } from "./workspace"

export const SlackAssistantContextSchema = z.object({
	channel_id: z.string().optional(),
	team_id: z.string().optional(),
	enterprise_id: z.string().optional(),
})

export const SlackAssistantThreadSchema = z.object({
	user_id: z.string().optional(),
	channel_id: z.string().optional(),
	thread_ts: z.string().optional(),
	context: SlackAssistantContextSchema.optional(),
})

export const SlackAgentContextEntitySchema = z.object({
	type: z.string(),
	value: z.unknown(),
	team_id: z.string().optional(),
})

export const SlackAgentContextSchema = z.object({
	// Slack sends `context: {}` when the app is open without an active entity.
	entities: z.array(SlackAgentContextEntitySchema).default([]),
})

export const SlackUrlVerificationSchema = z.object({
	type: z.literal("url_verification"),
	challenge: z.string(),
})
export const SlackFileSchema = z.object({
	id: z.string(),
	name: z.string().optional(),
	mode: z.string().optional(),
	file_access: z.string().optional(),
	mimetype: z.string().optional(),
	size: z.number().optional(),
	url_private: z.string().optional(),
	url_private_download: z.string().optional(),
})

export const SlackReactionItemSchema = z.object({
	type: z.string().optional(),
	channel: z.string().optional(),
	ts: z.string().optional(),
})

const SlackNestedMessageSchema = z.object({
	type: z.string().optional(),
	user: z.string().optional(),
	text: z.string().optional(),
	ts: z.string().optional(),
	thread_ts: z.string().optional(),
	bot_id: z.string().optional(),
	app_id: z.string().optional(),
	subtype: z.string().optional(),
})

export const SlackEventInnerSchema = z.object({
	type: z.string(),
	user: z.string().optional(),
	text: z.string().optional(),
	ts: z.string().optional(),
	channel: z.string().optional(),
	channel_type: z.string().optional(),
	thread_ts: z.string().optional(),
	bot_id: z.string().optional(),
	subtype: z.string().optional(),
	app_id: z.string().optional(),
	event_ts: z.string().optional(),
	tab: z.string().optional(),
	context: SlackAgentContextSchema.optional(),
	app_context: SlackAgentContextSchema.optional(),
	files: z.array(SlackFileSchema).optional(),
	assistant_thread: SlackAssistantThreadSchema.optional(),
	reaction: z.string().optional(),
	item: SlackReactionItemSchema.optional(),
	deleted_ts: z.string().optional(),
	message: SlackNestedMessageSchema.optional(),
	previous_message: SlackNestedMessageSchema.optional(),
})
export const SlackEventCallbackSchema = z.object({
	type: z.literal("event_callback"),
	team_id: z.string(),
	api_app_id: z.string().optional(),
	event_id: z.string(),
	event_time: z.number().optional(),
	event: SlackEventInnerSchema,
})

export const SlackEnvelopeSchema = z.union([
	SlackUrlVerificationSchema,
	SlackEventCallbackSchema,
])

// team_join carries a nested user OBJECT, which SlackEventInnerSchema's flat
// string `user` rejects — so it gets its own envelope, matched before the
// generic one.
const SlackWorkspaceUserSchema = z.object({
	id: z.string(),
	deleted: z.boolean().optional(),
	is_bot: z.boolean().optional(),
	is_restricted: z.boolean().optional(),
	is_ultra_restricted: z.boolean().optional(),
	is_stranger: z.boolean().optional(),
	team_id: z.string().optional(),
})

export const SlackTeamJoinEnvelopeSchema = z.object({
	type: z.literal("event_callback"),
	team_id: z.string(),
	event_id: z.string(),
	event: z.object({
		type: z.literal("team_join"),
		user: SlackWorkspaceUserSchema,
	}),
})

export const SlackUserChangeEnvelopeSchema = z.object({
	type: z.literal("event_callback"),
	team_id: z.string(),
	event_id: z.string(),
	event: z.object({
		type: z.literal("user_change"),
		user: SlackWorkspaceUserSchema,
	}),
})

export type SlackEventInner = z.infer<typeof SlackEventInnerSchema>
export type SlackTurnMessage = {
	teamId: string
	/** Slack's delivery id, used to durably deduplicate fiber-backed turns. */
	eventId?: string
	event: SlackEventInner
	/** Ephemeral ownership token set inside the DO after passive triage is claimed. */
	triageClaimId?: string
	/** Set by the signed event router when a plain-name wake phrase matched. */
	addressedByName?: boolean
	/** Workspace row already resolved by the event router; avoids a second DB read. */
	workspace?: SlackWorkspaceRow
}

// agent_view user messages normally have no subtype. Preserve main's
// human-authored content subtypes while ignoring bot/app messages, structural
// events, and legacy assistant_view roots.
const ALLOWED_MESSAGE_SUBTYPES = new Set([
	"file_share",
	"me_message",
	"thread_broadcast",
	"reply_broadcast",
])

export function isSlackContentMessageSubtype(
	subtype: string | undefined,
): boolean {
	return !subtype || ALLOWED_MESSAGE_SUBTYPES.has(subtype)
}

export function shouldIgnoreMessage(ev: SlackEventInner): boolean {
	if (ev.bot_id || ev.app_id) return true
	return !isSlackContentMessageSubtype(ev.subtype)
}

/** Slack shortcode/custom markup or Unicode pictographs with no prose. */
export function isEmojiOnlySlackText(text: string | undefined): boolean {
	const value = text?.trim()
	if (!value) return false
	const withoutSlackEmoji = value
		.replace(/<a?:[^:>\s]+:[^>]+>/gu, "")
		.replace(/:[a-z0-9_+-]+:/giu, "")
	const withoutUnicodeEmoji = withoutSlackEmoji.replace(
		/(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji_Modifier}|\u200d|\ufe0f|\s)/gu,
		"",
	)
	return withoutUnicodeEmoji.length === 0
}

/** Slack DM channel ids start with "D". */
export function isDirectSlackChannel(channel: string | undefined): boolean {
	return /^D/.test(channel ?? "")
}

export function isDirectMessage(ev: SlackEventInner): boolean {
	if (ev.type !== "message") return false
	return ev.channel_type === "im" || isDirectSlackChannel(ev.channel)
}

export function isDirectConversationEvent(ev: SlackEventInner): boolean {
	return ev.channel_type === "im" || isDirectSlackChannel(ev.channel)
}

export function isPrivateSlackChannel(
	channel: string | undefined,
	channelType: string | undefined,
): boolean {
	if (channelType === "group" || channelType === "mpim") return true
	if (channelType === "channel" || channelType === "im") return false
	if (/^G/.test(channel ?? "")) return true
	return /^C/.test(channel ?? "")
}

export function isAssistantThreadMessage(ev: SlackEventInner): boolean {
	if (ev.type !== "message") return false
	// Agent Messages follow-ups are ordinary IM messages with thread_ts.
	return isDirectMessage(ev) && Boolean(ev.thread_ts)
}

export function isAgentSurfaceEvent(ev: SlackEventInner): boolean {
	return ev.type === "app_home_opened" || ev.type === "app_context_changed"
}

// Channel membership changes — used to keep the DM cross-channel read scope in sync.
export function isChannelMembershipEvent(ev: SlackEventInner): boolean {
	return (
		ev.type === "member_joined_channel" || ev.type === "member_left_channel"
	)
}

export function isBotMentioned(
	text: string | undefined,
	botUserId: string | null | undefined,
): boolean {
	if (!text || !botUserId) return false
	return slackMentionedUserIds(text).includes(botUserId)
}

function slackMentionedUserIds(text: string | undefined): string[] {
	if (!text) return []
	const ids: string[] = []
	for (const match of text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g)) {
		const id = match[1]
		if (id && !ids.includes(id)) ids.push(id)
	}
	return ids
}

// Slack user ids @mentioned in the text, excluding the bot.
export function mentionedUserIds(
	text: string | undefined,
	botUserId: string | null | undefined,
): string[] {
	return slackMentionedUserIds(text).filter((id) => id !== botUserId)
}

const TRIAGE_PROFILE_LOOKUP_LIMIT = 16

// Current speaker + new-message mentions + history speakers and their mentions.
export function triageProfileUserIds(args: {
	currentUserId: string | undefined
	mentionedIds: ReadonlyArray<string>
	history: ReadonlyArray<{ user?: string; text?: string }>
	botUserId: string | null | undefined
}): string[] {
	const ids = new Set<string>()
	if (args.currentUserId) ids.add(args.currentUserId)
	for (const id of args.mentionedIds) ids.add(id)
	for (const message of [...args.history].reverse()) {
		if (message.user && message.user !== args.botUserId) ids.add(message.user)
		for (const id of mentionedUserIds(message.text, args.botUserId)) ids.add(id)
	}
	return [...ids].slice(0, TRIAGE_PROFILE_LOOKUP_LIMIT)
}

/**
 * A direct Slack user mention belongs to someone else unless Company Brain is
 * also explicitly mentioned. The bot's own mention wins for mixed-address
 * messages; every other direct mention remains context-only.
 */
export function isAddressedToOtherSlackUser(
	text: string | undefined,
	botUserId: string | null | undefined,
): boolean {
	if (!botUserId) return false
	if (isBotMentioned(text, botUserId)) return false
	return mentionedUserIds(text, botUserId).length > 0
}

export function isAnsweredEvent(
	ev: SlackEventInner,
	botUserId?: string | null,
): boolean {
	if (shouldIgnoreMessage(ev)) return false
	if (isDirectConversationEvent(ev)) return ev.type === "message"
	// Slack sends both app_mention and message for @mentions; only answer once.
	if (isBotMentioned(ev.text, botUserId)) {
		return ev.type === "app_mention"
	}
	if (ev.type === "app_mention") return true
	if (ev.type === "message") {
		if (ev.thread_ts) return true
	}
	return false
}

// Emoji whose reaction on a bot message surfaces its debug trace (ephemeral).
export const BRAIN_DEBUG_REACTIONS = new Set(["mag", "bug"])

export function isDebugReactionEvent(ev: SlackEventInner): boolean {
	if (ev.type !== "reaction_added") return false
	if (!ev.reaction || !BRAIN_DEBUG_REACTIONS.has(ev.reaction)) return false
	return ev.item?.type === "message" && Boolean(ev.item.channel && ev.item.ts)
}

export const BRAIN_MUTE_REACTION = "black_square_for_stop"

export function isMuteReactionEvent(ev: SlackEventInner): boolean {
	if (ev.type !== "reaction_added" && ev.type !== "reaction_removed") {
		return false
	}
	if (ev.reaction !== BRAIN_MUTE_REACTION) return false
	return ev.item?.type === "message" && Boolean(ev.item.channel && ev.item.ts)
}

/** Channel/thread message that might address the bot by plain name (not <@id>). */
export function isNameWakeCandidate(
	ev: SlackEventInner,
	botUserId?: string | null,
): boolean {
	if (shouldIgnoreMessage(ev)) return false
	if (ev.type !== "message") return false
	if (isBotMentioned(ev.text, botUserId)) return false
	if (isDirectMessage(ev)) return false
	if (isAssistantThreadMessage(ev)) return false
	return Boolean(ev.text?.trim())
}

/**
 * Message deliveries retained as local context when they are not otherwise
 * routed. Slack sends a plain human `message` twin for an `app_mention`; the
 * explicit twin owns that row, so exclude only that exact duplicate. Bot/app
 * messages and plain-name addresses still remain eligible for retention.
 */
export function isContextRetentionEvent(
	ev: SlackEventInner,
	botUserId?: string | null,
): boolean {
	if (ev.type !== "message" || !ev.channel) return false
	const isHumanAppMentionTwin =
		!shouldIgnoreMessage(ev) && isBotMentioned(ev.text, botUserId)
	return !isHumanAppMentionTwin
}

/** Top-level channel message eligible for proactive chime-in (bot must be in channel). */
export function isChimeInEvent(
	ev: SlackEventInner,
	botUserId?: string | null,
): boolean {
	if (shouldIgnoreMessage(ev)) return false
	if (ev.type !== "message") return false
	if (ev.thread_ts) return false
	if (isDirectMessage(ev)) return false
	if (isAssistantThreadMessage(ev)) return false
	if (isBotMentioned(ev.text, botUserId)) return false
	const text = ev.text?.trim()
	if (!text) return false
	return true
}
