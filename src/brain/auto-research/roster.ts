import { and, db, eq, isNotNull } from "@repo/db"
import { mcpConnection } from "@repo/db/schema/brain/mcp"
import { slackWorkspaceMember } from "@repo/db/schema/slack"
import { getCachedSlackUserProfiles } from "../slack/profile-cache"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"

// Teammates a draft can be addressed to. Only linked, active members qualify: a
// person-scoped draft runs as that person, so it needs a real supermemory user id.

export type DraftRecipient = {
	userId: string
	slackUserId: string
	name: string
	/** Apps they've connected personally — signals how much private context is reachable. */
	personalApps: string[]
}

const MAX_ROSTER = 40

export async function loadRecipientRoster(
	agent: CompanyBrainAgent,
	args: { teamId: string; botToken: string },
): Promise<DraftRecipient[]> {
	const env = brainAgent(agent).env
	const orgId = agent.name
	const [members, connections] = await Promise.all([
		db(env)
			.select({
				userId: slackWorkspaceMember.userId,
				slackUserId: slackWorkspaceMember.slackUserId,
				email: slackWorkspaceMember.email,
			})
			.from(slackWorkspaceMember)
			.where(
				and(
					eq(slackWorkspaceMember.orgId, orgId),
					eq(slackWorkspaceMember.teamId, args.teamId),
					eq(slackWorkspaceMember.status, "active"),
				),
			)
			.limit(MAX_ROSTER),
		db(env)
			.select({
				userId: mcpConnection.userId,
				serverSlug: mcpConnection.serverSlug,
			})
			.from(mcpConnection)
			.where(
				and(
					eq(mcpConnection.orgId, orgId),
					eq(mcpConnection.status, "active"),
					isNotNull(mcpConnection.userId),
				),
			)
			.catch(() => []),
	])
	if (!members.length) return []

	const appsByUser = new Map<string, string[]>()
	for (const row of connections) {
		if (!row.userId) continue
		appsByUser.set(row.userId, [
			...(appsByUser.get(row.userId) ?? []),
			row.serverSlug,
		])
	}

	const profiles = await getCachedSlackUserProfiles(agent, {
		teamId: args.teamId,
		botToken: args.botToken,
		userIds: members.map((m) => m.slackUserId),
	})

	const roster: DraftRecipient[] = []
	for (const member of members) {
		const profile = profiles.get(member.slackUserId)
		// Guests can't be given org context, and bots aren't people.
		if (profile?.isBot || profile?.isRestricted || profile?.isStranger) continue
		const name =
			profile?.displayName?.trim() ||
			profile?.name?.trim() ||
			member.email ||
			member.slackUserId
		roster.push({
			userId: member.userId,
			slackUserId: member.slackUserId,
			name,
			personalApps: [...new Set(appsByUser.get(member.userId) ?? [])],
		})
	}
	return roster
}
