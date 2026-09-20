import type { SlackConversation, SlackPostResult } from "./client"
import { HOME_CHANNEL_NAME } from "./proactivity"

const SLACK_FAREWELL_TERMINAL = new Set([
	"account_inactive",
	"cannot_reply_to_broadcast",
	"channel_not_found",
	"invalid_auth",
	"is_archived",
	"is_inactive",
	"msg_too_long",
	"not_in_channel",
	"restricted_action",
	"token_expired",
	"token_revoked",
])

const SLACK_FAREWELL_RETRYABLE = new Set([
	"fatal_error",
	"http_429",
	"internal_error",
	"ratelimited",
	"request_timeout",
	"service_unavailable",
])

export type SlackFarewellDeps = {
	postMessageIdempotent: (
		botToken: string,
		channel: string,
		text: string,
		clientMessageId: string,
	) => Promise<SlackPostResult>
	listBotConversations: (botToken: string) => Promise<SlackConversation[]>
}

export type SlackFarewellOutcome =
	| "posted"
	| "already_posted"
	| "skipped"
	| "hold"

export function shouldHoldForFarewell(
	result: Extract<SlackPostResult, { ok: false }>,
): boolean {
	if (result.retryAfterSeconds) return true
	if (SLACK_FAREWELL_RETRYABLE.has(result.error)) return true
	if (/^http_5\d\d$/.test(result.error)) return true
	if (SLACK_FAREWELL_TERMINAL.has(result.error)) return false
	if (result.error.startsWith("http_")) return false
	return true
}

async function deterministicUuid(seed: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(seed),
	)
	const bytes = Array.from(new Uint8Array(digest).slice(0, 16))
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
	const hex = bytes.map((x) => x.toString(16).padStart(2, "0")).join("")
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function slackFarewellClientMsgId(
	kind: string,
	teamId: string,
	channelId: string,
): Promise<string> {
	return deterministicUuid(`sm-cb-${kind}:${teamId}:${channelId}`)
}

// Falls back to the bot's joined channels so a retry after DO reset still finds home.
export async function postSlackFarewell(args: {
	botToken: string
	teamId: string
	kind: string
	text: string
	knownHomeChannelId?: string | null
	deps: SlackFarewellDeps
}): Promise<SlackFarewellOutcome> {
	let channelId = args.knownHomeChannelId ?? null
	if (!channelId) {
		try {
			const conversations = await args.deps.listBotConversations(args.botToken)
			channelId =
				conversations.find((channel) => channel.name === HOME_CHANNEL_NAME)
					?.id ?? null
		} catch (error) {
			console.warn(
				`[slack] farewell home lookup failed team=${args.teamId}:`,
				error instanceof Error ? error.message : error,
			)
			return error instanceof Error &&
				SLACK_FAREWELL_TERMINAL.has(error.message)
				? "skipped"
				: "hold"
		}
	}
	if (!channelId) return "skipped"

	const posted = await args.deps.postMessageIdempotent(
		args.botToken,
		channelId,
		args.text,
		await slackFarewellClientMsgId(args.kind, args.teamId, channelId),
	)
	if (posted.ok) return posted.deduped ? "already_posted" : "posted"
	if (shouldHoldForFarewell(posted)) {
		console.warn(
			`[slack] farewell retryable team=${args.teamId} channel=${channelId} error=${posted.error}`,
		)
		return "hold"
	}
	console.warn(
		`[slack] farewell skipped team=${args.teamId} channel=${channelId} error=${posted.error}`,
	)
	return "skipped"
}
