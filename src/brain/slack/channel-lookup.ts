import type { SlackMemoryScope } from "../memory"
import { normalizeSlackMessageContent } from "./attachments"
import {
	checkAskerCanSearchChannel,
	findChannelsNamedInQuery,
	getChannelDirectory,
	rankChannelsForQuery,
	resolveChannel,
	type SlackResponseSurface,
} from "./channel-directory"
import {
	getSlackChannelHistory,
	getSlackThread,
	type SlackConversation,
	type SlackThreadMessage,
} from "./client"

export function formatChannelMessageText(
	text: string | undefined,
	userNames?: Map<string, string>,
	groupHandles?: Map<string, string>,
): string {
	if (!text) return ""
	// Keep native channel tokens intact so downstream routing can distinguish
	// Slack channel selections from issue numbers and ordinary hashtags.
	return text
		.replace(
			/<@([A-Z0-9]+)(?:\|([^>]+))?>/g,
			(_, userId: string, label?: string) => {
				const name = userNames?.get(userId)
				return name ? `@${name}` : label ? `@${label}` : `@${userId}`
			},
		)
		.replace(
			/<!subteam\^[A-Z0-9]+\|([^>]+)>/g,
			(_, handle: string) => `@${handle}`,
		)
		.replace(/<!subteam\^([A-Z0-9]+)>/g, (_, id: string) => {
			const handle = groupHandles?.get(id)
			return handle ? `@${handle}` : `@${id}`
		})
		.replace(/<!(here|channel|everyone)>/g, (_, kw: string) => `@${kw}`)
		.replace(/\s+/g, " ")
		.trim()
}

export type SlackLookupContext = {
	botToken: string
	channel: string
	threadTs?: string
	teamId?: string
	memoryScope?: SlackMemoryScope
	/** Explicit read surface (admin console); replaces what memoryScope implies. */
	memoryContainerTags?: string[]
	tzOffsetSeconds?: number
	userNames?: Map<string, string>
}

export type ChannelLookupIntent =
	| "summarize_window"
	| "find_related"
	| "extract_open_actions"
	| "find_link"

export type ChannelLookupWindow =
	| "today"
	| "yesterday"
	| "last_7_days"
	| "last_24_hours"
	| "last_30_days"
	| "last_90_days"

export type ChannelLookupArgs = {
	intent: ChannelLookupIntent
	query?: string
	window?: ChannelLookupWindow
	limit?: number
}

export type SlackTimeRange = {
	oldestMs: number
	latestMs: number
	label: string
}

const DEFAULT_LIMIT = 80
const MAX_LIMIT = 150
const PAGE_SIZE = 200
const SCAN_BUDGET: Record<
	ChannelLookupWindow,
	{ maxMessages: number; maxPages: number }
> = {
	today: { maxMessages: 200, maxPages: 1 },
	yesterday: { maxMessages: 200, maxPages: 1 },
	last_24_hours: { maxMessages: 200, maxPages: 1 },
	last_7_days: { maxMessages: 400, maxPages: 2 },
	last_30_days: { maxMessages: 1000, maxPages: 5 },
	last_90_days: { maxMessages: 1600, maxPages: 8 },
}
const MAX_THREAD_PARENTS = 4
const THREAD_REPLY_LIMIT = 12

const ACTION_PATTERNS = [
	/\b(todo|to-do|action item|follow[- ]?up)\b/i,
	/\b(need to|needs to|should|must|have to)\b/i,
	/\b(i'll|i will|we'll|we will|can someone|could someone|who can)\b/i,
	/\b(assign|assigned to|owner:|please)\b/i,
]

const COMPLETION_PATTERNS = [
	/\b(done|completed|finished|shipped|fixed|resolved|closed|merged|deployed)\b/i,
	/\b(took care of|handled|all set|no longer needed)\b/i,
]

export function slackTsToMs(ts: string | undefined): number {
	if (!ts) return 0
	const n = Number.parseFloat(ts)
	return Number.isFinite(n) ? Math.floor(n * 1000) : 0
}

export function msToSlackTs(ms: number): string {
	return (ms / 1000).toFixed(6)
}

function startOfLocalDay(ms: number, tzOffsetSeconds: number): number {
	const local = new Date(ms + tzOffsetSeconds * 1000)
	return (
		Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) -
		tzOffsetSeconds * 1000
	)
}

export function parseSlackTimeWindow(
	window: ChannelLookupWindow | undefined,
	nowMs: number,
	tzOffsetSeconds = 0,
): SlackTimeRange {
	const w = window ?? "last_7_days"
	const todayStart = startOfLocalDay(nowMs, tzOffsetSeconds)
	if (w === "today") {
		return { oldestMs: todayStart, latestMs: nowMs, label: "today" }
	}
	if (w === "yesterday") {
		const yesterdayStart = todayStart - 24 * 60 * 60 * 1000
		return {
			oldestMs: yesterdayStart,
			latestMs: todayStart,
			label: "yesterday",
		}
	}
	if (w === "last_24_hours") {
		return {
			oldestMs: nowMs - 24 * 60 * 60 * 1000,
			latestMs: nowMs,
			label: "last 24 hours",
		}
	}
	if (w === "last_30_days") {
		return {
			oldestMs: nowMs - 30 * 24 * 60 * 60 * 1000,
			latestMs: nowMs,
			label: "last 30 days",
		}
	}
	if (w === "last_90_days") {
		return {
			oldestMs: nowMs - 90 * 24 * 60 * 60 * 1000,
			latestMs: nowMs,
			label: "last 90 days",
		}
	}
	return {
		oldestMs: nowMs - 7 * 24 * 60 * 60 * 1000,
		latestMs: nowMs,
		label: "last 7 days",
	}
}

export function formatSlackTsHuman(ts: string, tzOffsetSeconds = 0): string {
	const ms = slackTsToMs(ts)
	if (!ms) return ts
	const d = new Date(ms + tzOffsetSeconds * 1000)
	return d.toISOString().replace("T", " ").slice(0, 16)
}

export type FormattedSlackMessage = {
	ts: string
	when: string
	userId?: string
	speaker: string
	text: string
	threadTs?: string
	replyCount?: number
}

export function formatChannelMessages(
	messages: ReadonlyArray<SlackThreadMessage>,
	userNames?: Map<string, string>,
	tzOffsetSeconds = 0,
): FormattedSlackMessage[] {
	return messages.flatMap((m) => {
		const text = formatChannelMessageText(
			normalizeSlackMessageContent(m),
			userNames,
		)
		if (!text) return []
		const userId = m.user
		const speaker = userId
			? (userNames?.get(userId) ?? userId)
			: m.bot_id
				? "bot"
				: "user"
		return [
			{
				ts: m.ts ?? "",
				when: formatSlackTsHuman(m.ts ?? "", tzOffsetSeconds),
				...(userId !== undefined && { userId }),
				speaker,
				text,
				...(m.thread_ts !== undefined && { threadTs: m.thread_ts }),
				...(typeof (m as { reply_count?: number }).reply_count === "number" && {
					replyCount: (m as { reply_count?: number }).reply_count,
				}),
			},
		]
	})
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length > 2)
}

export function scoreRelatedMessage(text: string, query: string): number {
	const qTokens = new Set(tokenize(query))
	if (qTokens.size === 0) return 0
	const mTokens = tokenize(text)
	if (mTokens.length === 0) return 0
	let hits = 0
	for (const t of mTokens) {
		if (qTokens.has(t)) hits++
	}
	const phrase = query.toLowerCase().trim()
	if (phrase.length > 4 && text.toLowerCase().includes(phrase)) hits += 3
	return hits / Math.max(qTokens.size, 1)
}

export function looksLikeAction(text: string): boolean {
	return ACTION_PATTERNS.some((p) => p.test(text))
}

export function looksLikeCompletion(text: string): boolean {
	return COMPLETION_PATTERNS.some((p) => p.test(text))
}

export type ActionItemStatus = "likely_open" | "likely_done"

export type ExtractedActionItem = {
	ts: string
	when: string
	speaker: string
	text: string
	status: ActionItemStatus
	statusReason: string
}

export function extractActionItemsFromMessages(
	messages: FormattedSlackMessage[],
): ExtractedActionItem[] {
	const sorted = [...messages].sort(
		(a, b) => slackTsToMs(a.ts) - slackTsToMs(b.ts),
	)
	const items: ExtractedActionItem[] = []
	let nextCompletion: FormattedSlackMessage | undefined
	for (let i = sorted.length - 1; i >= 0; i--) {
		const msg = sorted[i]
		if (!msg) continue
		const completionAfter = nextCompletion
		if (looksLikeAction(msg.text)) {
			const status: ActionItemStatus = completionAfter
				? "likely_done"
				: "likely_open"
			const statusReason = completionAfter
				? `Later message at ${completionAfter.when} suggests completion.`
				: "No later completion signal in this window."
			items.push({
				ts: msg.ts,
				when: msg.when,
				speaker: msg.speaker,
				text: msg.text,
				status,
				statusReason,
			})
		}
		if (looksLikeCompletion(msg.text)) nextCompletion = msg
	}
	return items.reverse()
}

function compactLines(messages: FormattedSlackMessage[], max = 40): string[] {
	return messages.slice(-max).map((m) => `[${m.when}] ${m.speaker}: ${m.text}`)
}

function isThreadParent(m: SlackThreadMessage): boolean {
	const replyCount = (m as { reply_count?: number }).reply_count
	return typeof replyCount === "number" && replyCount > 0 && Boolean(m.ts)
}

async function expandThreadSnippets(
	ctx: SlackLookupContext,
	parents: SlackThreadMessage[],
): Promise<string[]> {
	const snippets: string[] = []
	for (const parent of parents.slice(0, MAX_THREAD_PARENTS)) {
		if (!parent.ts) continue
		const replies = await getSlackThread(
			ctx.botToken,
			ctx.channel,
			parent.ts,
			THREAD_REPLY_LIMIT,
		)
		const formatted = formatChannelMessages(
			replies,
			ctx.userNames,
			ctx.tzOffsetSeconds,
		)
		if (formatted.length <= 1) continue
		snippets.push(
			`Thread ${parent.ts}:`,
			...compactLines(formatted.slice(1), THREAD_REPLY_LIMIT),
		)
	}
	return snippets
}

export type ExtractedLink = {
	ts: string
	when: string
	speaker: string
	label: string
	url: string
	kind: "link" | "file"
	context: string
}

const SLACK_LINK_RE = /<(https?:\/\/[^|>]+)(?:\|([^>]*))?>/gi
const BARE_URL_RE = /(https?:\/\/[^\s|<>]+)/gi

export function extractLinksFromMessages(
	messages: ReadonlyArray<SlackThreadMessage>,
	userNames?: Map<string, string>,
	tzOffsetSeconds = 0,
): ExtractedLink[] {
	const out: ExtractedLink[] = []
	const seen = new Set<string>()
	for (const m of messages) {
		const ts = m.ts ?? ""
		const when = formatSlackTsHuman(ts, tzOffsetSeconds)
		const speaker = m.user
			? (userNames?.get(m.user) ?? m.user)
			: m.bot_id
				? "bot"
				: "user"
		const text = normalizeSlackMessageContent(m)
		const context = formatChannelMessageText(text, userNames)
		const push = (
			url: string,
			label: string,
			kind: "link" | "file",
			key: string,
		) => {
			if (!url || seen.has(key)) return
			seen.add(key)
			out.push({ ts, when, speaker, url, label: label || url, kind, context })
		}
		for (const match of text.matchAll(SLACK_LINK_RE)) {
			push(match[1] ?? "", (match[2] ?? "").trim(), "link", `${ts}:${match[1]}`)
		}
		for (const match of text
			.replace(SLACK_LINK_RE, " ")
			.matchAll(BARE_URL_RE)) {
			push(match[1] ?? "", match[1] ?? "", "link", `${ts}:${match[1]}`)
		}
		for (const f of m.files ?? []) {
			const url = f.url_private ?? f.url_private_download ?? ""
			push(url, f.name ?? "file", "file", `${ts}:${f.id}`)
		}
	}
	return out
}

export async function runSlackChannelLookup(
	ctx: SlackLookupContext,
	args: ChannelLookupArgs,
	nowMs = Date.now(),
): Promise<string> {
	const range = parseSlackTimeWindow(
		args.window,
		nowMs,
		ctx.tzOffsetSeconds ?? 0,
	)
	const budget = SCAN_BUDGET[args.window ?? "last_7_days"]
	const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
	const historyResult = await getSlackChannelHistory(
		ctx.botToken,
		ctx.channel,
		{
			oldest: msToSlackTs(range.oldestMs),
			latest: msToSlackTs(range.latestMs),
			limit: PAGE_SIZE,
			maxMessages: budget.maxMessages,
			maxPages: budget.maxPages,
		},
	)
	if (!historyResult.ok && historyResult.messages.length === 0) {
		return `Channel history unavailable (${historyResult.error}). The bot may be rate-limited; please retry shortly.`
	}
	const raw = historyResult.messages
	// True when rate-limiting cut pagination short after at least one page was fetched.
	// Negative results below append a caveat so the model doesn't claim the window
	// was exhaustively scanned.
	const incomplete = !historyResult.ok
	const incompleteCaveat = incomplete
		? " (scan incomplete — rate-limited mid-pagination; older messages in this window may be missing)"
		: ""

	if (args.intent === "find_link") {
		const query = args.query?.trim()
		const links = extractLinksFromMessages(
			raw,
			ctx.userNames,
			ctx.tzOffsetSeconds,
		)
		if (links.length === 0) {
			return `No links or files shared in ${range.label}.${incompleteCaveat}`
		}
		const ranked = query
			? links
					.map((l) => ({
						l,
						score: scoreRelatedMessage(
							`${l.label} ${l.url} ${l.context}`,
							query,
						),
					}))
					.filter((x) => x.score > 0)
					.sort((a, b) => b.score - a.score)
					.map((x) => x.l)
			: [...links].sort((a, b) => slackTsToMs(b.ts) - slackTsToMs(a.ts))
		const top = ranked.slice(0, Math.min(limit, 15))
		if (top.length === 0) {
			return `No links or files matching "${query}" in ${range.label}.${incompleteCaveat}`
		}
		return [
			`Links/files (${range.label})${query ? ` matching "${query}"` : ""}:${incompleteCaveat}`,
			...top.map(
				(l) =>
					`[${l.when}] ${l.speaker} — ${l.label}: ${l.url}${l.kind === "file" ? " (file)" : ""}`,
			),
		].join("\n")
	}

	const formatted = formatChannelMessages(
		raw,
		ctx.userNames,
		ctx.tzOffsetSeconds,
	)
	if (formatted.length === 0) {
		return `No channel messages found for ${range.label}. The bot may lack access to this channel or the window was empty.${incompleteCaveat}`
	}

	if (args.intent === "summarize_window") {
		const lines = compactLines(formatted)
		const threaded = raw.filter(isThreadParent)
		const threadSnippets = await expandThreadSnippets(ctx, threaded)
		return [
			`Channel activity (${range.label}, ${formatted.length} messages)${incompleteCaveat}:`,
			...lines,
			...(threadSnippets.length
				? ["", "Thread snippets:", ...threadSnippets]
				: []),
		].join("\n")
	}

	if (args.intent === "find_related") {
		const query = args.query?.trim()
		if (!query) {
			return "find_related requires a query describing what to match in channel history."
		}
		const scored = formatted
			.map((m) => ({ m, score: scoreRelatedMessage(m.text, query) }))
			.filter((x) => x.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 20)
		if (scored.length === 0) {
			return `No related messages found in ${range.label} for: ${query}${incompleteCaveat}`
		}
		const topTs = new Set(scored.slice(0, 5).map((x) => x.m.ts))
		const threadParents = raw.filter(
			(m) => m.ts && topTs.has(m.ts) && isThreadParent(m),
		)
		const threadSnippets = await expandThreadSnippets(ctx, threadParents)
		return [
			`Related channel messages (${range.label}) for "${query}"${incompleteCaveat}:`,
			...scored.map(({ m, score }) => {
				const pct = Math.round(score * 100)
				return `[${m.when}] ${m.speaker} (match ${pct}%): ${m.text}`
			}),
			...(threadSnippets.length
				? ["", "Thread snippets:", ...threadSnippets]
				: []),
		].join("\n")
	}

	const actions = extractActionItemsFromMessages(formatted)
	const open = actions.filter((a) => a.status === "likely_open")
	const done = actions.filter((a) => a.status === "likely_done")
	if (actions.length === 0) {
		return `No likely action items detected in ${range.label}. Slack has no task state — this is inferred from message language only.${incompleteCaveat}`
	}
	return [
		`Likely action items in channel (${range.label})${incompleteCaveat}. Status is inferred from message wording, not a task system.`,
		"",
		open.length
			? `Likely open (${open.length}):`
			: "Likely open: none detected.",
		...open.map(
			(a) => `- [${a.when}] ${a.speaker}: ${a.text} (${a.statusReason})`,
		),
		"",
		done.length
			? `Likely done (${done.length}):`
			: "Likely done: none detected.",
		...done.map(
			(a) => `- [${a.when}] ${a.speaker}: ${a.text} (${a.statusReason})`,
		),
	].join("\n")
}

export type SlackChannelsSearchArgs = {
	query: string
	window?: ChannelLookupWindow
	channels?: string[]
}

const MAX_SLACK_FANOUT = 5
const FANOUT_MAX_MESSAGES = 300
const FANOUT_MAX_PAGES = 2

function formatChannelNameList(channels: SlackConversation[]): string {
	const names = channels.map((c) => `#${c.name}`)
	if (names.length <= 1) return names[0] ?? "that channel"
	if (names.length === 2) return `${names[0]} and ${names[1]}`
	return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`
}

export async function runSlackChannelsSearch(
	env: Env,
	ctx: SlackLookupContext,
	auth: {
		askerSlackUserId?: string
		isOrgMember?: boolean
		responseSurface?: SlackResponseSurface
		askerIsRestricted?: boolean
	},
	args: SlackChannelsSearchArgs,
	nowMs = Date.now(),
): Promise<string> {
	const query = args.query.trim()
	if (!query) {
		return "search_slack_channels needs a query describing what to find."
	}
	const notFound: string[] = []
	let candidates: SlackConversation[]
	let truncatedExplicitChannels = 0
	if (args.channels?.length) {
		const refs = args.channels
		const resolved = await Promise.all(
			refs.map((ref) => resolveChannel(env, ctx.teamId, ctx.botToken, ref)),
		)
		candidates = []
		resolved.forEach((res, i) => {
			if (res.status === "ok") candidates.push(res.channel)
			else notFound.push(refs[i] ?? "")
		})
		truncatedExplicitChannels = Math.max(
			candidates.length - MAX_SLACK_FANOUT,
			0,
		)
	} else {
		let dir = await getChannelDirectory(env, ctx.teamId, ctx.botToken)
		if (dir.length === 0) {
			return "I'm not in any channels I can search yet. Invite me to a channel with /invite, then ask again."
		}
		let named = findChannelsNamedInQuery(dir, query, MAX_SLACK_FANOUT)
		if (named.length === 0) {
			const fresh = await getChannelDirectory(env, ctx.teamId, ctx.botToken, {
				forceRefresh: true,
			})
			if (fresh.length) {
				dir = fresh
				named = findChannelsNamedInQuery(dir, query, MAX_SLACK_FANOUT)
			}
		}
		const ranked = rankChannelsForQuery(dir, query, MAX_SLACK_FANOUT)
		candidates = []
		for (const c of [...named, ...ranked]) {
			if (!candidates.some((picked) => picked.id === c.id)) candidates.push(c)
			if (candidates.length >= MAX_SLACK_FANOUT) break
		}
	}
	candidates = candidates.slice(0, MAX_SLACK_FANOUT)

	const gated = await Promise.all(
		candidates.map(async (c) => {
			const access = await checkAskerCanSearchChannel(
				env,
				ctx.teamId,
				ctx.botToken,
				c,
				auth.askerSlackUserId,
				{
					currentChannelId: ctx.channel,
					isOrgMember: auth.isOrgMember === true,
					responseSurface: auth.responseSurface,
					askerIsRestricted: auth.askerIsRestricted === true,
				},
			)
			return { c, access }
		}),
	)
	const allowed = gated.filter((x) => x.access.ok).map((x) => x.c)
	const denied = gated.filter((x) => !x.access.ok)
	const deniedCount = denied.length
	const explicitSingleChannel = args.channels?.length === 1
	if (
		explicitSingleChannel &&
		denied.some(
			(x) =>
				!x.access.ok &&
				(x.access.reason === "private_channel_requires_membership" ||
					x.access.reason === "unknown_asker"),
		)
	) {
		const channels = denied
			.filter(
				(x) =>
					!x.access.ok &&
					(x.access.reason === "private_channel_requires_membership" ||
						x.access.reason === "unknown_asker"),
			)
			.map((x) => x.c)
		return `I can't go through ${formatChannelNameList(channels)} because you're not a member of ${channels.length === 1 ? "it" : "them"}.`
	}
	if (
		explicitSingleChannel &&
		denied.some(
			(x) =>
				!x.access.ok && x.access.reason === "private_channel_non_dm_response",
		)
	) {
		const channels = denied
			.filter(
				(x) =>
					!x.access.ok && x.access.reason === "private_channel_non_dm_response",
			)
			.map((x) => x.c)
		return `I can't answer from ${formatChannelNameList(channels)} here. DM me and I can answer there.`
	}
	if (allowed.length === 0) {
		if (
			denied.some(
				(x) =>
					!x.access.ok &&
					(x.access.reason === "private_channel_requires_membership" ||
						x.access.reason === "unknown_asker"),
			)
		) {
			return "I can't go through that channel because you're not a member of it."
		}
		if (
			denied.some(
				(x) =>
					!x.access.ok && x.access.reason === "private_channel_non_dm_response",
			)
		) {
			return "I can't answer from that private channel here. DM me and I can answer there."
		}
		if (
			denied.some((x) => !x.access.ok && x.access.reason === "not_org_member")
		) {
			return "I can only search other Slack channels for confirmed org members."
		}
		const parts = [
			"No searchable channels matched. Private channels are searchable only by their members.",
		]
		if (truncatedExplicitChannels) {
			parts.push(
				`Only checked the first ${MAX_SLACK_FANOUT} resolved requested channels; skipped ${truncatedExplicitChannels} additional channel${truncatedExplicitChannels === 1 ? "" : "s"}.`,
			)
		}
		if (deniedCount) {
			parts.push(
				`Skipped ${deniedCount} channel${deniedCount === 1 ? "" : "s"}.`,
			)
		}
		if (notFound.length) parts.push("Some requested channels weren't found.")
		return parts.join(" ")
	}

	const range = parseSlackTimeWindow(
		args.window,
		nowMs,
		ctx.tzOffsetSeconds ?? 0,
	)
	const incompleteChannels: string[] = []
	const perChannel = await Promise.all(
		allowed.map(async (c) => {
			const fanoutResult = await getSlackChannelHistory(ctx.botToken, c.id, {
				oldest: msToSlackTs(range.oldestMs),
				latest: msToSlackTs(range.latestMs),
				limit: PAGE_SIZE,
				maxMessages: FANOUT_MAX_MESSAGES,
				maxPages: FANOUT_MAX_PAGES,
			})
			if (!fanoutResult.ok) {
				incompleteChannels.push(c.name)
				if (fanoutResult.messages.length === 0) return []
			}
			const raw = fanoutResult.messages
			const formatted = formatChannelMessages(
				raw,
				ctx.userNames,
				ctx.tzOffsetSeconds,
			)
			return formatted
				.map((m) => ({
					channel: c.name,
					m,
					score: scoreRelatedMessage(m.text, query),
				}))
				.filter((x) => x.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, 5)
		}),
	)
	const merged = perChannel
		.flat()
		.sort((a, b) => b.score - a.score)
		.slice(0, 20)

	const searchedLabel = allowed.map((c) => `#${c.name}`).join(", ")
	const incompleteLabel =
		incompleteChannels.length > 0
			? ` History for ${incompleteChannels.map((n) => `#${n}`).join(", ")} was incomplete (rate-limited mid-pagination).`
			: ""
	if (merged.length === 0) {
		return `No matches for "${query}" in ${range.label} across ${searchedLabel}.${incompleteLabel}`
	}
	const footer: string[] = []
	if (incompleteChannels.length > 0) {
		footer.push(
			`History for ${incompleteChannels.map((n) => `#${n}`).join(", ")} was incomplete (rate-limited mid-pagination; some messages may be missing).`,
		)
	}
	if (truncatedExplicitChannels) {
		footer.push(
			`Only searched the first ${MAX_SLACK_FANOUT} resolved requested channels; skipped ${truncatedExplicitChannels} additional channel${truncatedExplicitChannels === 1 ? "" : "s"}.`,
		)
	}
	if (deniedCount) {
		if (args.channels?.length) {
			footer.push(`Skipped ${formatChannelNameList(denied.map((x) => x.c))}.`)
		} else {
			footer.push(
				`Skipped ${deniedCount} channel${deniedCount === 1 ? "" : "s"}.`,
			)
		}
	}
	if (notFound.length) footer.push("Some requested channels weren't found.")
	return [
		`Cross-channel matches for "${query}" (${range.label}, searched ${searchedLabel}):`,
		...merged.map(
			({ channel, m, score }) =>
				`[#${channel}] [${m.when}] ${m.speaker} (match ${Math.round(score * 100)}%): ${m.text}`,
		),
		...(footer.length ? ["", ...footer] : []),
	].join("\n")
}
