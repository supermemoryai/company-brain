import {
	getBotConversations,
	getConversationMembers,
	getSlackConversationInfo,
	type SlackConversation,
} from "./client"

const CHANNELS_CACHE_TTL_SECONDS = 10 * 60

export type ChannelDirectory = SlackConversation[]

export async function invalidateChannelDirectory(
	env: Env,
	teamId: string,
): Promise<void> {
	await env.BRAIN_KV?.delete(`slack:bot-channels:${teamId}`).catch(() => {})
}

export async function getChannelDirectory(
	env: Env,
	teamId: string | undefined,
	botToken: string,
	opts?: { forceRefresh?: boolean },
): Promise<ChannelDirectory> {
	const cacheKey = teamId ? `slack:bot-channels:${teamId}` : undefined
	if (!opts?.forceRefresh && cacheKey && env.BRAIN_KV) {
		const cached = await env.BRAIN_KV.get(cacheKey).catch(() => null)
		if (cached) {
			try {
				const parsed = JSON.parse(cached) as ChannelDirectory
				if (Array.isArray(parsed)) return parsed
			} catch {}
		}
	}
	const channels = await getBotConversations(botToken)
	if (cacheKey && env.BRAIN_KV && channels.length) {
		await env.BRAIN_KV.put(cacheKey, JSON.stringify(channels), {
			expirationTtl: CHANNELS_CACHE_TTL_SECONDS,
		}).catch(() => {})
	}
	return channels
}

export function parseChannelRef(ref: string): { id?: string; name?: string } {
	const t = ref.trim()
	const mention = t.match(/^<#([A-Z0-9]+)(?:\|([^>]*))?>$/i)
	if (mention) return { id: mention[1], name: mention[2]?.trim() || undefined }
	if (/^[CGD][A-Z0-9]{5,}$/i.test(t)) return { id: t }
	return { name: t.replace(/^[#@]/, "") }
}

export function resolveChannelRef(
	dir: ChannelDirectory,
	ref: string,
): SlackConversation | undefined {
	const { id, name } = parseChannelRef(ref)
	if (id) {
		const byId = dir.find((c) => c.id === id)
		if (byId) return byId
	}
	if (name) {
		const lower = name.toLowerCase()
		const byName = dir.find((c) => c.name.toLowerCase() === lower)
		if (byName) return byName
	}
	return undefined
}

export type ChannelResolution =
	| { status: "ok"; channel: SlackConversation }
	| { status: "not_member"; name: string; isPrivate: boolean }
	| { status: "unknown"; ref: string }

export async function resolveChannel(
	env: Env,
	teamId: string | undefined,
	botToken: string,
	ref: string,
): Promise<ChannelResolution> {
	const dir = await getChannelDirectory(env, teamId, botToken)
	const cached = resolveChannelRef(dir, ref)
	if (cached) return { status: "ok", channel: cached }

	const { id, name } = parseChannelRef(ref)
	if (id) {
		const info = await getSlackConversationInfo(botToken, id)
		if (info?.id && info.name) {
			const channel: SlackConversation = {
				id: info.id,
				name: info.name,
				isPrivate: Boolean(info.isPrivate),
			}
			return info.isMember
				? { status: "ok", channel }
				: {
						status: "not_member",
						name: info.name,
						isPrivate: channel.isPrivate,
					}
		}
		return { status: "unknown", ref }
	}

	if (name) {
		const fresh = await getChannelDirectory(env, teamId, botToken, {
			forceRefresh: true,
		})
		const hit = resolveChannelRef(fresh, ref)
		if (hit) return { status: "ok", channel: hit }
	}
	return { status: "unknown", ref }
}

function queryTokens(query: string): Set<string> {
	return new Set(
		query
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, " ")
			.split(/\s+/)
			.filter((t) => t.length > 2),
	)
}

export function findChannelsNamedInQuery(
	dir: ChannelDirectory,
	query: string,
	limit: number,
): SlackConversation[] {
	const qTokens = queryTokens(query)
	if (qTokens.size === 0) return []
	return dir
		.map((c) => {
			const nameTokens = c.name.toLowerCase().split(/[-_\s]+/)
			let score = 0
			for (const t of nameTokens) if (qTokens.has(t)) score++
			return { c, score }
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.map((x) => x.c)
		.slice(0, limit)
}

export function rankChannelsForQuery(
	dir: ChannelDirectory,
	query: string,
	limit: number,
): SlackConversation[] {
	const matched = findChannelsNamedInQuery(dir, query, limit)
	if (matched.length >= limit) return matched.slice(0, limit)
	const picked = [...matched]
	const backfill = [...dir].sort(
		(a, b) => Number(a.isPrivate) - Number(b.isPrivate),
	)
	for (const c of backfill) {
		if (picked.length >= limit) break
		if (!picked.includes(c)) picked.push(c)
	}
	return picked.slice(0, limit)
}

export type ChannelSearchAccess =
	| { ok: true }
	| {
			ok: false
			reason:
				| "not_org_member"
				| "private_channel_requires_membership"
				| "private_channel_non_dm_response"
				| "unknown_asker"
	  }

export type SlackResponseSurface = "public_channel" | "private_channel" | "dm"

export async function checkAskerCanSearchChannel(
	_env: Env,
	_teamId: string | undefined,
	botToken: string,
	channel: SlackConversation,
	askerSlackUserId: string | undefined,
	opts?: {
		currentChannelId?: string
		isOrgMember?: boolean
		responseSurface?: SlackResponseSurface
		/** A future response delivered directly into this channel is not a leak. */
		responseChannelId?: string
		/** Slack guest: only sees channels they're in, even public ones. */
		askerIsRestricted?: boolean
	},
): Promise<ChannelSearchAccess> {
	const isCurrentChannel = channel.id === opts?.currentChannelId
	if (!isCurrentChannel && !opts?.isOrgMember) {
		return { ok: false, reason: "not_org_member" }
	}

	// Full members can read any public channel, but Slack guests only see
	// channels they've been added to — so verify membership for a guest even
	// on a public channel the bot happens to be in.
	const guestNeedsMembership =
		opts?.askerIsRestricted === true && !isCurrentChannel
	if (!channel.isPrivate && !guestNeedsMembership) return { ok: true }
	if (!askerSlackUserId) return { ok: false, reason: "unknown_asker" }

	const members = await getConversationMembers(botToken, channel.id)
	if (!members.includes(askerSlackUserId)) {
		return { ok: false, reason: "private_channel_requires_membership" }
	}
	// Private-channel content must not be echoed outside that channel or a DM;
	// public channels the guest belongs to carry no such surface restriction.
	if (
		channel.isPrivate &&
		!isCurrentChannel &&
		opts?.responseSurface !== "dm" &&
		opts?.responseChannelId !== channel.id
	) {
		return { ok: false, reason: "private_channel_non_dm_response" }
	}
	return { ok: true }
}
