import { decryptToken } from "@/lib/crypto"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { getHomeChannel } from "../turn/home-channel"
import { getWorkspaceByTeamId, getWorkspaceTeamIdByOrgId } from "./workspace"

// The org's Slack surface, for internal work that runs without an incoming event:
// a bot token to read with, and the home channel when one is set.
export type OrgSlackContext = {
	botToken: string
	teamId: string
	/** Empty when the org has a workspace but no home channel yet. */
	channelId: string
	installedByUserId: string | null
}

export async function loadOrgSlackContext(
	agent: CompanyBrainAgent,
): Promise<OrgSlackContext | null> {
	const env = brainAgent(agent).env
	const home = getHomeChannel(agent)
	const teamId =
		home?.teamId ?? (await getWorkspaceTeamIdByOrgId(env, agent.name))
	if (!teamId) return null
	const ws = await getWorkspaceByTeamId(env, teamId)
	// Fail closed on a rebound workspace: never read one org's Slack as another.
	if (!ws || ws.orgId !== agent.name) return null
	return {
		botToken: await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET),
		teamId,
		channelId: home?.channelId ?? "",
		installedByUserId: ws.installedByUserId ?? null,
	}
}
