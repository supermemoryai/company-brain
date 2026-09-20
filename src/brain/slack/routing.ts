import { openSlackConversation } from "./client"
import type { SlackEventInner } from "./events"

export type SlackReplyTarget = {
	channel: string
	threadTs: string
}

function isSlackChannelId(id: string): boolean {
	return /^[CGD]/.test(id)
}

export function resolveScheduledSlackThreadTs(
	directDelivery: boolean,
	originThreadTs: string | undefined,
): string | undefined {
	// In agent_view, a scheduled DM is a new root in the unified Messages
	// timeline. Channel-origin schedules continue in their original thread.
	return directDelivery ? undefined : originThreadTs
}

export async function resolveSlackReplyTarget(
	botToken: string,
	ev: SlackEventInner,
): Promise<SlackReplyTarget | null> {
	let channel = ev.assistant_thread?.channel_id ?? ev.channel ?? ""
	const threadTs = ev.thread_ts ?? ev.assistant_thread?.thread_ts ?? ev.ts ?? ""

	if (!isSlackChannelId(channel) && ev.user) {
		const opened = await openSlackConversation(botToken, ev.user)
		if (opened) channel = opened
	}

	if (!isSlackChannelId(channel) || !threadTs) {
		console.warn(
			`[slack] unable to resolve reply target channel=${ev.channel ?? "?"} assistant=${ev.assistant_thread?.channel_id ?? "?"} thread=${ev.thread_ts ?? ev.ts ?? "?"} user=${ev.user ?? "?"}`,
		)
		return null
	}

	console.log(
		`[slack] reply target channel=${channel} thread=${threadTs} user=${ev.user ?? "?"}`,
	)

	return { channel, threadTs }
}
