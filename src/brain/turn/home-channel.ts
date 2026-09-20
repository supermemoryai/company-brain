import type { CompanyBrainAgent } from "./agent"

export type HomeChannel = {
	channelId: string
	teamId: string
}

function ensureHomeChannelTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS slack_home_channel (
			id INTEGER PRIMARY KEY,
			channel_id TEXT NOT NULL,
			team_id TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)
	`
}

export function setHomeChannel(
	agent: CompanyBrainAgent,
	home: HomeChannel,
): void {
	ensureHomeChannelTable(agent)
	const now = Date.now()
	agent.sql`
		INSERT INTO slack_home_channel (id, channel_id, team_id, created_at)
		VALUES (1, ${home.channelId}, ${home.teamId}, ${now})
		ON CONFLICT (id) DO UPDATE SET
			channel_id = ${home.channelId},
			team_id = ${home.teamId}
	`
}

export function getHomeChannel(agent: CompanyBrainAgent): HomeChannel | null {
	ensureHomeChannelTable(agent)
	const row = agent.sql<{ channel_id: string; team_id: string }>`
		SELECT channel_id, team_id FROM slack_home_channel WHERE id = 1
	`[0]
	return row ? { channelId: row.channel_id, teamId: row.team_id } : null
}
