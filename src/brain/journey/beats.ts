import { decryptToken } from "@/lib/crypto"
import {
	lookupSlackConversationInfo,
	postSlackMessageIdempotent,
} from "../slack/client"
import type { ChannelTheme } from "../slack/connected-tool-crosscheck"
import { escapeSlackText, getWorkspaceByTeamId } from "../slack/workspace"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { getHomeChannel } from "../turn/home-channel"
import type { JourneyRung, RungState } from "./rungs"

export type JourneyBeat = {
	rung: JourneyRung
	/** Returns false when there was nothing worth saying; that is not a failure. */
	send: (
		agent: CompanyBrainAgent,
		ctx: { state: RungState },
	) => Promise<boolean>
}

// Resolve by the home channel's team so token and channel always match.
async function homeSurface(
	agent: CompanyBrainAgent,
): Promise<{ botToken: string; channelId: string; teamId: string } | null> {
	const home = getHomeChannel(agent)
	if (!home) return null
	const env = brainAgent(agent).env
	const ws = await getWorkspaceByTeamId(env, home.teamId)
	if (!ws || ws.orgId !== agent.name) return null
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	return { botToken, channelId: home.channelId, teamId: home.teamId }
}

async function beatClientId(
	agent: CompanyBrainAgent,
	rung: JourneyRung,
): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`journey-beat:${agent.name}:${rung}`),
	)
	const bytes = Array.from(new Uint8Array(digest).slice(0, 16))
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
	const hex = bytes.map((x) => x.toString(16).padStart(2, "0")).join("")
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function postHome(
	agent: CompanyBrainAgent,
	rung: JourneyRung,
	text: string,
): Promise<boolean> {
	const surface = await homeSurface(agent)
	if (!surface) return false
	const posted = await postSlackMessageIdempotent(
		surface.botToken,
		surface.channelId,
		text,
		await beatClientId(agent, rung),
	)
	return posted.ok
}

type ThemedChannel = { channelId: string; theme: ChannelTheme }

// Ledger rows are historic, so membership is rechecked before posting.
// Durable table: a new rollout truncates the run table.
function themedChannelCandidates(
	agent: CompanyBrainAgent,
	teamId: string,
): ThemedChannel[] {
	try {
		const rows = agent.sql<{ channel_id: string; theme_json: string }>`
			SELECT channel_id, theme_json
			FROM brain_public_channel_introduction
			WHERE team_id = ${teamId}
				AND theme_json IS NOT NULL AND theme_json != '[]'
			ORDER BY introduced_at DESC
			LIMIT 5
		`
		return rows.flatMap((row) => {
			const theme = (JSON.parse(row.theme_json) as ChannelTheme[])[0]
			return theme ? [{ channelId: row.channel_id, theme }] : []
		})
	} catch {
		return []
	}
}

const domainBeat: JourneyBeat = {
	rung: "domain",
	send: (agent) =>
		postHome(
			agent,
			"domain",
			"I still don't know which company this workspace belongs to, so my research has nothing to go on. Reply here with your company's website (like `acme.com`) and mention me, and I'll read up on you and post what I find.",
		),
}

const secondAskerBeat: JourneyBeat = {
	rung: "second_asker",
	send: async (agent) => {
		const surface = await homeSurface(agent)
		if (!surface) return false
		let picked: ThemedChannel | undefined
		for (const candidate of themedChannelCandidates(agent, surface.teamId)) {
			const info = await lookupSlackConversationInfo(
				surface.botToken,
				candidate.channelId,
			)
			if (info.ok && info.info.isMember) {
				picked = candidate
				break
			}
		}
		if (!picked) return false
		const topic = escapeSlackText(picked.theme.title)
		const posted = await postSlackMessageIdempotent(
			surface.botToken,
			picked.channelId,
			`If you're wondering what I'm for: I keep up with this channel. Ask me something like "what's the latest on ${topic}?" and I'll pull the context, decisions included.`,
			await beatClientId(agent, "second_asker"),
		)
		return posted.ok
	},
}

const toolWorkspaceBeat: JourneyBeat = {
	rung: "tool_workspace",
	send: (agent) =>
		postHome(
			agent,
			"tool_workspace",
			"This one needs an admin: connect a workspace tool (GitHub, Linear, Google Drive) at <https://app.supermemory.ai/configure/tools|app.supermemory.ai/configure/tools> and share it with the org. Once one is in, my answers and digests can cite what's actually happening in it, not just Slack.",
		),
}

const digestBeat: JourneyBeat = {
	rung: "digest",
	send: (agent) =>
		postHome(
			agent,
			"digest",
			"Want a standing digest? Mention me with something like \"set up a Monday morning digest of what moved last week\" and I'll schedule it. It reads channels I'm in and org-shared tools, nothing personal.",
		),
}

export const JOURNEY_BEATS: Partial<Record<JourneyRung, JourneyBeat>> = {
	domain: domainBeat,
	second_asker: secondAskerBeat,
	tool_workspace: toolWorkspaceBeat,
	digest: digestBeat,
}
