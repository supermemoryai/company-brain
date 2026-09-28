import type { SlackAsker } from "../slack/client"

/** The person a turn answers, independent of the surface they wrote from. */
export type SurfaceAsker = {
	/** Surface-native user id (Slack user id). */
	externalUserId?: string
	displayName?: string
	email?: string
	tz?: string
}

export type SurfaceIdentity = SurfaceAsker

export function surfaceAskerFromSlack(asker: SlackAsker): SurfaceAsker {
	return {
		...(asker.slackUserId ? { externalUserId: asker.slackUserId } : {}),
		...((asker.displayName ?? asker.name)
			? { displayName: asker.displayName ?? asker.name }
			: {}),
		...(asker.email ? { email: asker.email } : {}),
		...(asker.timezone ? { tz: asker.timezone } : {}),
	}
}
