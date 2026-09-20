import { isDirectMessage, type SlackTurnMessage } from "../slack/events"
import { postConnectCard } from "../slack/onboarding-card"
import { brainAgent, type CompanyBrainAgent } from "./agent"

// Fallback delay: if the installer hasn't replied by now, nudge them anyway.
const NUDGE_SAFETY_NET_SECONDS = 15 * 60

export type InstallNudgeArm = {
	installerUserId: string
	slackUserId: string
	teamId: string
	channel: string
}

type NudgeRow = {
	installer_user_id: string
	slack_user_id: string
	team_id: string
	channel: string
}

function ensureInstallNudgeTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS install_nudge (
			id INTEGER PRIMARY KEY,
			installer_user_id TEXT NOT NULL,
			slack_user_id TEXT NOT NULL,
			team_id TEXT NOT NULL,
			channel TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)
	`
}

function pendingNudge(agent: CompanyBrainAgent): NudgeRow | undefined {
	return agent.sql<NudgeRow>`
		SELECT installer_user_id, slack_user_id, team_id, channel
		FROM install_nudge WHERE id = 1 AND status = 'pending'
	`[0]
}

// Claim the pending row (so the alarm and the reply path can't both post), deliver
// the card, and revert to pending on failure so the safety-net alarm can retry.
async function deliverInstallNudge(agent: CompanyBrainAgent): Promise<void> {
	ensureInstallNudgeTable(agent)
	const row = pendingNudge(agent)
	if (!row) return
	agent.sql`UPDATE install_nudge SET status = 'done' WHERE id = 1`
	const ok = await postConnectCard(brainAgent(agent).env, {
		orgId: agent.name,
		installerUserId: row.installer_user_id,
		teamId: row.team_id,
		channel: row.channel,
		slackUserId: row.slack_user_id,
	})
	if (!ok) agent.sql`UPDATE install_nudge SET status = 'pending' WHERE id = 1`
}

// Called at install time: record the pending nudge and schedule the safety net.
export async function armInstallNudge(
	agent: CompanyBrainAgent,
	payload: InstallNudgeArm,
): Promise<void> {
	ensureInstallNudgeTable(agent)
	const now = Date.now()
	agent.sql`
		INSERT INTO install_nudge (id, installer_user_id, slack_user_id, team_id, channel, status, created_at)
		VALUES (1, ${payload.installerUserId}, ${payload.slackUserId}, ${payload.teamId}, ${payload.channel}, 'pending', ${now})
		ON CONFLICT(id) DO UPDATE SET
			installer_user_id = ${payload.installerUserId},
			slack_user_id = ${payload.slackUserId},
			team_id = ${payload.teamId},
			channel = ${payload.channel},
			status = 'pending',
			created_at = ${now}
	`
	await agent.schedule(NUDGE_SAFETY_NET_SECONDS, "runInstallNudge", {})
}

// Safety-net alarm callback.
export async function runInstallNudge(agent: CompanyBrainAgent): Promise<void> {
	try {
		await deliverInstallNudge(agent)
	} catch (err) {
		console.warn("[slack] install nudge alarm failed:", err)
	}
}

// After the installer's first DM reply, nudge them to connect tools once.
export async function maybeNudgeInstallTools(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
): Promise<void> {
	try {
		ensureInstallNudgeTable(agent)
		const row = pendingNudge(agent)
		if (!row) return
		const ev = msg.event
		if (ev.bot_id || !ev.user || ev.user !== row.slack_user_id) return
		if (!isDirectMessage(ev)) return
		await deliverInstallNudge(agent)
	} catch (err) {
		console.warn("[slack] install nudge on reply failed:", err)
	}
}
