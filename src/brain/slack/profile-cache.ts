import type { CompanyBrainAgent } from "../turn/agent"
import {
	lookupSlackConversationInfo,
	lookupSlackUserInfo,
	type SlackConversationInfo,
	type SlackUserInfo,
	type SlackUserInfoLookup,
} from "./client"

export const SLACK_PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1_000
export const SLACK_PROFILE_NEGATIVE_CACHE_TTL_MS = 60 * 60 * 1_000
export const SLACK_PROFILE_TRANSIENT_ERROR_CACHE_TTL_MS = 60 * 1_000
export const SLACK_CHANNEL_CACHE_TTL_MS = 60 * 60 * 1_000
export const SLACK_CHANNEL_NEGATIVE_CACHE_TTL_MS = 60 * 60 * 1_000
export const SLACK_CHANNEL_TRANSIENT_ERROR_CACHE_TTL_MS = 60 * 1_000

type CachedProfileRow = {
	name: string | null
	display_name: string | null
	handle: string | null
	email: string | null
	is_bot: number
	is_restricted: number
	tz_offset: number | null
	lookup_ok: number
	lookup_reason: string | null
	lookup_error: string | null
	expires_at: number
}

const inFlightByAgent = new WeakMap<
	CompanyBrainAgent,
	Map<string, Promise<SlackUserInfoLookup>>
>()
const channelInFlightByAgent = new WeakMap<
	CompanyBrainAgent,
	Map<string, Promise<SlackConversationInfo | undefined>>
>()

export function ensureSlackProfileCacheTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_slack_user_cache (
			team_id TEXT NOT NULL,
			slack_user_id TEXT NOT NULL,
			name TEXT,
			display_name TEXT,
			handle TEXT,
			email TEXT,
			is_bot INTEGER NOT NULL DEFAULT 0,
			is_restricted INTEGER NOT NULL DEFAULT 0,
			tz_offset INTEGER,
			lookup_ok INTEGER NOT NULL DEFAULT 1,
			lookup_reason TEXT,
			lookup_error TEXT,
			fetched_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			PRIMARY KEY (team_id, slack_user_id)
		)
	`
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_slack_channel_cache (
			team_id TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			name TEXT,
			topic TEXT,
			purpose TEXT,
			is_private INTEGER,
			is_member INTEGER,
			is_archived INTEGER,
			lookup_ok INTEGER NOT NULL DEFAULT 1,
			fetched_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			PRIMARY KEY (team_id, channel_id)
		)
	`
}

function rowToLookup(row: CachedProfileRow): SlackUserInfoLookup {
	if (!row.lookup_ok) {
		return {
			ok: false,
			reason:
				row.lookup_reason === "missing_user_id" ||
				row.lookup_reason === "user_not_found" ||
				row.lookup_reason === "profile_unavailable"
					? row.lookup_reason
					: "slack_api_error",
			...(row.lookup_error ? { error: row.lookup_error } : {}),
		}
	}
	const user: SlackUserInfo = {
		...(row.name ? { name: row.name } : {}),
		...(row.display_name ? { displayName: row.display_name } : {}),
		...(row.handle ? { handle: row.handle } : {}),
		...(row.email ? { email: row.email } : {}),
		...(row.is_bot ? { isBot: true } : {}),
		...(row.is_restricted ? { isRestricted: true } : {}),
		...(row.tz_offset !== null ? { tzOffset: row.tz_offset } : {}),
	}
	return { ok: true, user }
}

function readCachedProfile(
	agent: CompanyBrainAgent,
	teamId: string,
	userId: string,
	nowMs: number,
): SlackUserInfoLookup | undefined {
	const row = agent.sql<CachedProfileRow>`
		SELECT name, display_name, handle, email, is_bot, is_restricted,
			tz_offset, lookup_ok, lookup_reason, lookup_error, expires_at
		FROM brain_slack_user_cache
		WHERE team_id = ${teamId} AND slack_user_id = ${userId}
	`[0]
	if (!row || row.expires_at <= nowMs) return undefined
	return rowToLookup(row)
}

function writeCachedProfile(
	agent: CompanyBrainAgent,
	teamId: string,
	userId: string,
	lookup: SlackUserInfoLookup,
	nowMs: number,
): void {
	const user = lookup.ok ? lookup.user : undefined
	const ttl = lookup.ok
		? SLACK_PROFILE_CACHE_TTL_MS
		: lookup.reason === "slack_api_error"
			? SLACK_PROFILE_TRANSIENT_ERROR_CACHE_TTL_MS
			: SLACK_PROFILE_NEGATIVE_CACHE_TTL_MS
	agent.sql`
		INSERT INTO brain_slack_user_cache (
			team_id, slack_user_id, name, display_name, handle, email, is_bot,
			is_restricted, tz_offset, lookup_ok, lookup_reason, lookup_error,
			fetched_at, expires_at
		) VALUES (
			${teamId}, ${userId}, ${user?.name ?? null},
			${user?.displayName ?? null}, ${user?.handle ?? null},
			${user?.email ?? null}, ${user?.isBot ? 1 : 0},
			${user?.isRestricted ? 1 : 0}, ${user?.tzOffset ?? null},
			${lookup.ok ? 1 : 0}, ${lookup.ok ? null : lookup.reason},
			${lookup.ok ? null : (lookup.error ?? null)}, ${nowMs}, ${nowMs + ttl}
		)
		ON CONFLICT(team_id, slack_user_id) DO UPDATE SET
			name = excluded.name,
			display_name = excluded.display_name,
			handle = excluded.handle,
			email = excluded.email,
			is_bot = excluded.is_bot,
			is_restricted = excluded.is_restricted,
			tz_offset = excluded.tz_offset,
			lookup_ok = excluded.lookup_ok,
			lookup_reason = excluded.lookup_reason,
			lookup_error = excluded.lookup_error,
			fetched_at = excluded.fetched_at,
			expires_at = excluded.expires_at
	`
}

/** Cached users.info lookup with per-agent single-flight on cold misses. */
export async function getCachedSlackUserInfo(
	agent: CompanyBrainAgent,
	args: {
		teamId: string
		botToken: string
		userId: string
		nowMs?: number
	},
): Promise<SlackUserInfoLookup> {
	ensureSlackProfileCacheTable(agent)
	const nowMs = args.nowMs ?? Date.now()
	const cached = readCachedProfile(agent, args.teamId, args.userId, nowMs)
	if (cached) return cached

	let map = inFlightByAgent.get(agent)
	if (!map) {
		map = new Map()
		inFlightByAgent.set(agent, map)
	}
	const key = `${args.teamId}:${args.userId}`
	const existing = map.get(key)
	if (existing) return await existing

	const lookup = (async () => {
		const result = await lookupSlackUserInfo(args.botToken, args.userId)
		writeCachedProfile(agent, args.teamId, args.userId, result, Date.now())
		return result
	})()
	map.set(key, lookup)
	try {
		return await lookup
	} finally {
		map.delete(key)
	}
}

export async function getCachedSlackUserProfiles(
	agent: CompanyBrainAgent,
	args: { teamId: string; botToken: string; userIds: ReadonlyArray<string> },
): Promise<Map<string, SlackUserInfo>> {
	const ids = [...new Set(args.userIds.filter(Boolean))]
	const entries = await Promise.all(
		ids.map(async (userId) => {
			const lookup = await getCachedSlackUserInfo(agent, {
				teamId: args.teamId,
				botToken: args.botToken,
				userId,
			})
			return [userId, lookup.ok ? lookup.user : undefined] as const
		}),
	)
	return new Map(
		entries.filter(
			(entry): entry is readonly [string, SlackUserInfo] =>
				entry[1] !== undefined,
		),
	)
}

type CachedChannelRow = {
	name: string | null
	topic: string | null
	purpose: string | null
	is_private: number | null
	is_member: number | null
	is_archived: number | null
	lookup_ok: number
	expires_at: number
}

function nullableBoolean(value: number | null): boolean | undefined {
	return value === null ? undefined : value === 1
}

/** DO-local conversations.info cache; cold misses are single-flight per channel. */
export async function getCachedSlackChannelInfo(
	agent: CompanyBrainAgent,
	args: {
		teamId: string
		botToken: string
		channelId: string
		nowMs?: number
	},
): Promise<SlackConversationInfo | undefined> {
	ensureSlackProfileCacheTable(agent)
	const nowMs = args.nowMs ?? Date.now()
	const row = agent.sql<CachedChannelRow>`
		SELECT name, topic, purpose, is_private, is_member, is_archived,
			lookup_ok, expires_at
		FROM brain_slack_channel_cache
		WHERE team_id = ${args.teamId} AND channel_id = ${args.channelId}
	`[0]
	if (row && row.expires_at > nowMs) {
		if (!row.lookup_ok) return undefined
		return {
			id: args.channelId,
			...(row.name ? { name: row.name } : {}),
			...(row.topic ? { topic: row.topic } : {}),
			...(row.purpose ? { purpose: row.purpose } : {}),
			...(nullableBoolean(row.is_private) !== undefined
				? { isPrivate: nullableBoolean(row.is_private) }
				: {}),
			...(nullableBoolean(row.is_member) !== undefined
				? { isMember: nullableBoolean(row.is_member) }
				: {}),
			...(nullableBoolean(row.is_archived) !== undefined
				? { isArchived: nullableBoolean(row.is_archived) }
				: {}),
		}
	}

	let map = channelInFlightByAgent.get(agent)
	if (!map) {
		map = new Map()
		channelInFlightByAgent.set(agent, map)
	}
	const key = `${args.teamId}:${args.channelId}`
	const existing = map.get(key)
	if (existing) return await existing

	const lookup = (async () => {
		const result = await lookupSlackConversationInfo(
			args.botToken,
			args.channelId,
		)
		const info = result.ok ? result.info : undefined
		const fetchedAt = Date.now()
		const ttl = result.ok
			? SLACK_CHANNEL_CACHE_TTL_MS
			: result.reason === "slack_api_error"
				? SLACK_CHANNEL_TRANSIENT_ERROR_CACHE_TTL_MS
				: SLACK_CHANNEL_NEGATIVE_CACHE_TTL_MS
		agent.sql`
			INSERT INTO brain_slack_channel_cache (
				team_id, channel_id, name, topic, purpose, is_private, is_member,
				is_archived, lookup_ok, fetched_at, expires_at
			) VALUES (
				${args.teamId}, ${args.channelId}, ${info?.name ?? null},
				${info?.topic ?? null}, ${info?.purpose ?? null},
				${info?.isPrivate === undefined ? null : info.isPrivate ? 1 : 0},
				${info?.isMember === undefined ? null : info.isMember ? 1 : 0},
				${info?.isArchived === undefined ? null : info.isArchived ? 1 : 0},
				${info ? 1 : 0}, ${fetchedAt}, ${fetchedAt + ttl}
			)
			ON CONFLICT(team_id, channel_id) DO UPDATE SET
				name = excluded.name,
				topic = excluded.topic,
				purpose = excluded.purpose,
				is_private = excluded.is_private,
				is_member = excluded.is_member,
				is_archived = excluded.is_archived,
				lookup_ok = excluded.lookup_ok,
				fetched_at = excluded.fetched_at,
				expires_at = excluded.expires_at
		`
		return info
	})()
	map.set(key, lookup)
	try {
		return await lookup
	} finally {
		map.delete(key)
	}
}
