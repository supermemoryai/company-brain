import type { SlackPublicChannel } from "./client"

export function isEligiblePublicChannel(
	channel: SlackPublicChannel,
	args: { homeChannelId: string },
): boolean {
	return !(
		channel.isArchived ||
		channel.isExternal ||
		channel.isGeneral ||
		channel.name.toLowerCase() === "general" ||
		channel.name.toLowerCase() === "company-brain" ||
		channel.id === args.homeChannelId
	)
}
