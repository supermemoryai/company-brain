import { captureException } from "@/lib/capture"
import { decryptToken } from "@/lib/crypto"
import { privateSlackChannelContainerTag } from "../memory/writeback"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { getChannelDirectory } from "./channel-directory"
import { getConversationMembers, getSlackConversationInfo } from "./client"
import type { SlackTurnMessage } from "./events"
import { ensureWorkspaceBotUserId, getWorkspaceByTeamId } from "./workspace"

// Tracks which Slack users belong to which private channels, so a personal DM
// can read the brain memory of every private channel the asker has access to.
export function ensureChannelMembershipTables(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_channel_membership (
			channel_id TEXT NOT NULL,
			slack_user_id TEXT NOT NULL,
			is_private INTEGER NOT NULL DEFAULT 1,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (channel_id, slack_user_id)
		)
	`
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_channel_backfill (
			channel_id TEXT PRIMARY KEY,
			backfilled_at INTEGER NOT NULL
		)
	`
}

function recordMembership(
	agent: CompanyBrainAgent,
	channelId: string,
	slackUserId: string,
	now: number,
): void {
	agent.sql`
		INSERT INTO brain_channel_membership (channel_id, slack_user_id, is_private, updated_at)
		VALUES (${channelId}, ${slackUserId}, 1, ${now})
		ON CONFLICT(channel_id, slack_user_id) DO UPDATE SET updated_at = ${now}, is_private = 1
	`
}

function removeMembership(
	agent: CompanyBrainAgent,
	channelId: string,
	slackUserId: string,
): void {
	agent.sql`
		DELETE FROM brain_channel_membership
		WHERE channel_id = ${channelId} AND slack_user_id = ${slackUserId}
	`
}

// Bot left / lost access: drop the whole channel — no memory access, so nothing
// should surface it in a DM anymore.
function purgeChannel(agent: CompanyBrainAgent, channelId: string): void {
	agent.sql`DELETE FROM brain_channel_membership WHERE channel_id = ${channelId}`
	agent.sql`DELETE FROM brain_channel_backfill WHERE channel_id = ${channelId}`
}

// Authoritative snapshot of a private channel's membership via
// conversations.members: upserts everyone currently in the channel AND removes
// anyone the table still lists who is no longer a member. The removal is what
// makes this a safety net — it corrects dropped member_left_channel events, so
// a user who lost Slack access can't keep reading the channel in a DM.
//
// A private channel always has >=1 member (the bot itself), so an empty result
// means the fetch failed; skip the rewrite entirely so a transient Slack error
// can't wipe legitimate access.
async function backfillChannelMembers(
	agent: CompanyBrainAgent,
	botToken: string,
	channelId: string,
	now: number,
): Promise<number> {
	const members = await getConversationMembers(botToken, channelId)
	if (members.length === 0) {
		console.warn(
			`[company-brain][membership] backfill skipped channel=${channelId}: no members returned (treated as fetch failure)`,
		)
		return 0
	}
	const current = new Set(members)
	const existing = agent.sql<{ slack_user_id: string }>`
		SELECT slack_user_id FROM brain_channel_membership WHERE channel_id = ${channelId}
	`
	for (const row of existing) {
		if (!current.has(row.slack_user_id)) {
			removeMembership(agent, channelId, row.slack_user_id)
		}
	}
	for (const member of members) recordMembership(agent, channelId, member, now)
	agent.sql`
		INSERT INTO brain_channel_backfill (channel_id, backfilled_at)
		VALUES (${channelId}, ${now})
		ON CONFLICT(channel_id) DO UPDATE SET backfilled_at = ${now}
	`
	return members.length
}

// Prefer the cached bot-channel directory (avoids a per-event API call); fall
// back to a direct lookup for channels not yet in the cache.
async function resolveChannelPrivacy(
	env: Env,
	teamId: string,
	botToken: string,
	channelId: string,
): Promise<boolean | null> {
	try {
		const dir = await getChannelDirectory(env, teamId, botToken)
		const hit = dir.find((c) => c.id === channelId)
		if (hit) return hit.isPrivate
	} catch {}
	const info = await getSlackConversationInfo(botToken, channelId)
	return typeof info?.isPrivate === "boolean" ? info.isPrivate : null
}

// Handles member_joined_channel / member_left_channel. Slack only delivers these
// for channels the bot is in, so every event we see is for a relevant channel.
export async function runSlackMembershipEvent(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
): Promise<void> {
	const ev = msg.event
	const channel = ev.channel
	const user = ev.user
	if (!channel || !user) return
	const isJoin = ev.type === "member_joined_channel"
	const isLeave = ev.type === "member_left_channel"
	if (!isJoin && !isLeave) return

	const env = brainAgent(agent).env
	const ws = await getWorkspaceByTeamId(env, msg.teamId)
	if (!ws) return
	if (ws.orgId !== agent.name) {
		console.error(
			`[company-brain][membership] event dropped: workspace rebound team=${msg.teamId} eventOrg=${agent.name} currentOrg=${ws.orgId}`,
		)
		return
	}
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	const isPrivate = await resolveChannelPrivacy(
		env,
		msg.teamId,
		botToken,
		channel,
	)

	if (isPrivate !== true) return
	const botUserId = await ensureWorkspaceBotUserId(env, ws, botToken)
	const isBot = Boolean(botUserId) && user === botUserId

	ensureChannelMembershipTables(agent)
	const now = Date.now()

	if (isLeave) {
		if (isBot) {
			purgeChannel(agent, channel)
			console.log(
				`[company-brain][membership] bot left private channel=${channel}; purged`,
			)
		} else {
			removeMembership(agent, channel, user)
			console.log(
				`[company-brain][membership] leave channel=${channel} user=${user}`,
			)
		}
		return
	}

	if (isBot) {
		const count = await backfillChannelMembers(agent, botToken, channel, now)
		console.log(
			`[company-brain][membership] bot joined private channel=${channel}; backfilled ${count} members`,
		)
	} else {
		recordMembership(agent, channel, user, now)
		console.log(
			`[company-brain][membership] join channel=${channel} user=${user}`,
		)
	}
}

// Safety net for the event stream: re-enumerates every private channel the bot
// is in and rewrites their membership, then prunes channels the bot has left.
// Catches channels the bot joined before event subscriptions existed and any
// join/leave events dropped during downtime. Low-frequency (cron) — off the hot
// path.
export async function reconcileChannelMembership(
	agent: CompanyBrainAgent,
	teamId: string,
): Promise<void> {
	const env = brainAgent(agent).env
	const ws = await getWorkspaceByTeamId(env, teamId)
	if (!ws) return
	if (ws.orgId !== agent.name) {
		console.error(
			`[company-brain][membership] reconcile dropped: workspace rebound team=${teamId} reconcileOrg=${agent.name} currentOrg=${ws.orgId}`,
		)
		return
	}
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	const dir = await getChannelDirectory(env, teamId, botToken, {
		forceRefresh: true,
	})
	const privateChannels = dir.filter((c) => c.isPrivate)

	ensureChannelMembershipTables(agent)
	const now = Date.now()
	const keep = new Set<string>()
	for (const channel of privateChannels) {
		keep.add(channel.id)
		await backfillChannelMembers(agent, botToken, channel.id, now)
	}

	// Prune channels the bot is no longer in — their memory is inaccessible now.
	const known = agent.sql<{ channel_id: string }>`
		SELECT DISTINCT channel_id FROM brain_channel_membership
	`
	let pruned = 0
	for (const row of known) {
		if (!keep.has(row.channel_id)) {
			purgeChannel(agent, row.channel_id)
			pruned += 1
		}
	}
	console.log(
		`[company-brain][membership] reconciled team=${teamId} privateChannels=${privateChannels.length} pruned=${pruned}`,
	)
}

// Every private-channel container tag the given Slack user can read,
// most-recently active first. Local SQL only, no Slack calls — feeds the DM
// read scope. The default limit is a pathological guardrail (a user in
// thousands of private channels), not a product cap; searchBrain searches the
// full set and bounds cost with batched concurrency.
export function readableSlackChannelContainerTagsForUser(
	agent: CompanyBrainAgent,
	slackUserId: string | undefined,
	limit = 1000,
): string[] {
	if (!slackUserId?.trim()) return []
	try {
		ensureChannelMembershipTables(agent)
		const rows = agent.sql<{ channel_id: string }>`
			SELECT channel_id FROM brain_channel_membership
			WHERE slack_user_id = ${slackUserId} AND is_private = 1
			ORDER BY updated_at DESC
			LIMIT ${limit}
		`
		return rows.map((row) => privateSlackChannelContainerTag(row.channel_id))
	} catch (error) {
		captureException(
			error instanceof Error ? error : new Error(String(error)),
			{
				tags: { component: "brain-channel-membership" },
			},
		)
		return []
	}
}
