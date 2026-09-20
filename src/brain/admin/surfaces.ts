import {
	privateContainerTagFor,
	SHARED_TEAM_BRAIN_CONTAINER_TAG,
} from "@/lib/spaces/provisioning"
import { loadRecipientRoster } from "../auto-research/roster"
import { privateSlackChannelContainerTag } from "../memory/writeback"
import { ensureChannelMembershipTables } from "../slack/channel-membership"
import { loadOrgSlackContext } from "../slack/org-context"
import { getCachedSlackChannelInfo } from "../slack/profile-cache"
import type { CompanyBrainAgent } from "../turn/agent"

// Every memory surface an operator can look at, so the console can offer them as
// checkboxes rather than making someone guess what exists.

export type BrainSurface = {
	id: string
	kind: "shared" | "private_channel" | "dm"
	label: string
	containerTag: string
	/** DM surfaces carry the member, which is what unlocks their personal tools. */
	userId?: string
	slackUserId?: string
	/** Private channels: how many members the brain has seen in them. */
	memberCount?: number
	personalApps?: string[]
}

export async function listBrainSurfaces(
	agent: CompanyBrainAgent,
): Promise<BrainSurface[]> {
	const surfaces: BrainSurface[] = [
		{
			id: "shared",
			kind: "shared",
			label: "Shared team brain",
			containerTag: SHARED_TEAM_BRAIN_CONTAINER_TAG,
		},
	]
	const slack = await loadOrgSlackContext(agent)

	ensureChannelMembershipTables(agent)
	const channels = agent.sql<{ channel_id: string; members: number }>`
		SELECT channel_id, COUNT(*) AS members FROM brain_channel_membership
		WHERE is_private = 1 GROUP BY channel_id ORDER BY MAX(updated_at) DESC LIMIT 200
	`
	for (const row of channels) {
		const info = slack
			? await getCachedSlackChannelInfo(agent, {
					teamId: slack.teamId,
					botToken: slack.botToken,
					channelId: row.channel_id,
				}).catch(() => undefined)
			: undefined
		surfaces.push({
			id: `channel:${row.channel_id}`,
			kind: "private_channel",
			label: info?.name ? `#${info.name}` : row.channel_id,
			containerTag: privateSlackChannelContainerTag(row.channel_id),
			memberCount: row.members,
		})
	}

	if (slack) {
		const roster = await loadRecipientRoster(agent, {
			teamId: slack.teamId,
			botToken: slack.botToken,
		})
		for (const person of roster) {
			surfaces.push({
				id: `dm:${person.userId}`,
				kind: "dm",
				label: `DM with ${person.name}`,
				containerTag: privateContainerTagFor(person.userId),
				userId: person.userId,
				slackUserId: person.slackUserId,
				personalApps: person.personalApps,
			})
		}
	}
	return surfaces
}
