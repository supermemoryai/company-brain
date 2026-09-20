import {
	openSlackConversation,
	postSlackEphemeral,
	postSlackMessage,
} from "./client"
import { isDirectSlackChannel } from "./events"

export type SlackDebugTraceDelivery =
	| "dm_channel"
	| "ephemeral"
	| "private_dm"
	| "failed"

export async function deliverSlackDebugTrace(args: {
	botToken: string
	channel: string
	reactorUser: string
	text: string
	threadTs?: string
}): Promise<SlackDebugTraceDelivery> {
	if (isDirectSlackChannel(args.channel)) {
		return (await postSlackMessage(
			args.botToken,
			args.channel,
			args.text,
			args.threadTs,
		))
			? "dm_channel"
			: "failed"
	}

	if (
		await postSlackEphemeral(
			args.botToken,
			args.channel,
			args.reactorUser,
			args.text,
			args.threadTs,
		)
	) {
		return "ephemeral"
	}

	// A trace is internal observability data. If Slack cannot deliver the
	// ephemeral, fail over to the reactor's DM rather than the shared channel.
	const dm = await openSlackConversation(args.botToken, args.reactorUser)
	return dm && (await postSlackMessage(args.botToken, dm, args.text))
		? "private_dm"
		: "failed"
}
