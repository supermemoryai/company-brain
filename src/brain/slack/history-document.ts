import { generateContentHash } from "@/lib/hash"
import { SHARED_TEAM_BRAIN_CONTAINER_TAG } from "@/lib/spaces/provisioning"
import {
	BRAIN_TAG_LABELS_METADATA_KEY,
	BRAIN_TAGS_METADATA_KEY,
	normalizeBrainTagKey,
} from "../memory/tags"
import { normalizeSlackMessageContent } from "./attachments"
import type { SlackThreadMessage } from "./client"

export const SLACK_HISTORY_DOCUMENT_VERSION = 1
export const SLACK_HISTORY_DOCUMENT_MAX_CHARS = 30_000

export type SlackHistoryDocument = {
	customId: string
	content: string
	containerTag: string
	metadata: Record<string, string | number | boolean | string[]>
	date: string
	part: number
}

export type SlackHistoryDocumentInput = {
	teamId: string
	channelId: string
	channelName: string
	topic?: string | null
	purpose?: string | null
	windowStartMs: number
	windowEndMs: number
	botUserId?: string | null
	messages: SlackThreadMessage[]
}

function timestampMs(ts: string | undefined): number | null {
	if (!ts) return null
	const seconds = Number.parseFloat(ts)
	return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null
}

function isoTimestamp(ts: string): string {
	const ms = timestampMs(ts)
	return ms === null ? ts : new Date(ms).toISOString()
}

function utcDate(ts: string): string {
	const ms = timestampMs(ts)
	return ms === null ? "unknown-date" : new Date(ms).toISOString().slice(0, 10)
}

function cleanText(text: string | undefined): string {
	return (text ?? "")
		.replace(/\r\n/g, "\n")
		.replaceAll(String.fromCharCode(0), "")
		.trim()
}

function fileSummary(message: SlackThreadMessage): string {
	const names = (message.files ?? [])
		.flatMap((file) => (file.name?.trim() ? [file.name.trim()] : []))
		.slice(0, 8)
	return names.length ? `[Files: ${names.join(", ")}]` : ""
}

function reactionSummary(message: SlackThreadMessage): string {
	const reactions = (message.reactions ?? [])
		.flatMap((reaction) => {
			if (!reaction.name?.trim()) return []
			return [`:${reaction.name.trim()}:×${Math.max(reaction.count ?? 1, 1)}`]
		})
		.slice(0, 12)
	return reactions.length ? ` [Reactions: ${reactions.join(" ")}]` : ""
}

function isSubstantive(
	message: SlackThreadMessage,
	botUserId: string | null | undefined,
): boolean {
	if (!message.ts) return false
	if (botUserId && message.user === botUserId) return false
	const text = cleanText(normalizeSlackMessageContent(message))
	if (!text && !(message.files?.length ?? 0)) return false
	if (
		message.subtype &&
		!["bot_message", "file_share", "thread_broadcast"].includes(message.subtype)
	) {
		return false
	}
	return true
}

function speaker(message: SlackThreadMessage): string {
	if (message.user) return `<@${message.user}>`
	if (message.app_id) return `Slack app ${message.app_id}`
	if (message.bot_id) return `Slack bot ${message.bot_id}`
	return "Unknown speaker"
}

function messageLine(message: SlackThreadMessage, isReply: boolean): string {
	const text = cleanText(normalizeSlackMessageContent(message))
	const files = fileSummary(message)
	const body = [text, files].filter(Boolean).join(" ")
	return `${isReply ? "  ↳ " : "- "}${isoTimestamp(message.ts ?? "")} · ${speaker(message)}: ${body}${reactionSummary(message)}`
}

type ThreadUnit = {
	date: string
	earliestTs: string
	latestTs: string
	text: string
}

function buildThreadUnits(input: SlackHistoryDocumentInput): ThreadUnit[] {
	const inWindow = input.messages.filter((message) => {
		if (!isSubstantive(message, input.botUserId)) return false
		const ms = timestampMs(message.ts)
		return ms !== null && ms >= input.windowStartMs && ms <= input.windowEndMs
	})
	const byTimestamp = new Map<string, SlackThreadMessage>()
	for (const message of inWindow) {
		if (message.ts) byTimestamp.set(message.ts, message)
	}
	const byRoot = new Map<string, SlackThreadMessage[]>()
	for (const message of byTimestamp.values()) {
		const root = message.thread_ts || message.ts
		if (!root) continue
		const group = byRoot.get(root) ?? []
		group.push(message)
		byRoot.set(root, group)
	}

	return [...byRoot.entries()]
		.map(([rootTs, messages]) => {
			messages.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""))
			const root = messages.find((message) => message.ts === rootTs)
			const ordered = root
				? [root, ...messages.filter((message) => message !== root)]
				: messages
			const earliestTs = ordered[0]?.ts ?? rootTs
			const latestTs = ordered.at(-1)?.ts ?? earliestTs
			return {
				date: utcDate(earliestTs),
				earliestTs,
				latestTs,
				text: ordered
					.map((message, index) => messageLine(message, index > 0))
					.join("\n"),
			}
		})
		.sort((a, b) => a.earliestTs.localeCompare(b.earliestTs))
}

function header(input: SlackHistoryDocumentInput, date: string): string {
	return [
		`# Slack history: #${input.channelName}`,
		`CHANNEL_ID: ${input.channelId}`,
		`DOCUMENT_DATE_UTC: ${date}`,
		`CAPTURE_WINDOW_UTC: ${new Date(input.windowStartMs).toISOString()} — ${new Date(input.windowEndMs).toISOString()}`,
		input.topic?.trim() ? `TOPIC: ${input.topic.trim()}` : "",
		input.purpose?.trim() ? `PURPOSE: ${input.purpose.trim()}` : "",
		"",
	]
		.filter((line, index, all) => line || index === all.length - 1)
		.join("\n")
}

function splitOversizedUnit(unit: ThreadUnit, maxChars: number): ThreadUnit[] {
	if (unit.text.length <= maxChars) return [unit]
	const lines = unit.text.split("\n")
	const chunks: ThreadUnit[] = []
	let current = ""
	for (const line of lines) {
		const clipped = line.length > maxChars ? line.slice(0, maxChars) : line
		if (current && current.length + clipped.length + 1 > maxChars) {
			chunks.push({ ...unit, text: current })
			current = ""
		}
		current = current ? `${current}\n${clipped}` : clipped
	}
	if (current) chunks.push({ ...unit, text: current })
	return chunks
}

/**
 * Packs coherent Slack threads oldest-to-newest into deterministic daily
 * documents. Participant IDs remain inline, but are intentionally not applied
 * as document-level person tags (which would over-scope every extracted fact).
 */
export function buildSlackHistoryDocuments(
	input: SlackHistoryDocumentInput,
	maxChars = SLACK_HISTORY_DOCUMENT_MAX_CHARS,
): SlackHistoryDocument[] {
	const byDate = new Map<string, ThreadUnit[]>()
	for (const unit of buildThreadUnits(input)) {
		const units = byDate.get(unit.date) ?? []
		units.push(...splitOversizedUnit(unit, Math.max(maxChars - 1_000, 1_000)))
		byDate.set(unit.date, units)
	}

	const documents: SlackHistoryDocument[] = []
	const channelTag = normalizeBrainTagKey(`slack_channel_${input.channelId}`)
	for (const [date, units] of [...byDate.entries()].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const prefix = header(input, date)
		let part = 1
		let body = ""
		let earliestTs = ""
		let latestTs = ""
		const flush = () => {
			if (!body) return
			// Include frozen window bounds so a later partial-day recapture does
			// not reuse the same customId and overwrite a fuller prior document.
			const identity = [
				SLACK_HISTORY_DOCUMENT_VERSION,
				input.teamId,
				input.channelId,
				date,
				part,
				String(input.windowStartMs),
				String(input.windowEndMs),
			].join(":")
			documents.push({
				customId: `slackhist_v${SLACK_HISTORY_DOCUMENT_VERSION}_${generateContentHash(identity).slice(0, 32)}`,
				content: `${prefix}${body}`,
				containerTag: SHARED_TEAM_BRAIN_CONTAINER_TAG,
				date,
				part,
				metadata: {
					source_type: "slack_channel_history",
					slack_team_id: input.teamId,
					slack_channel_id: input.channelId,
					slack_channel_name: input.channelName,
					document_date: date,
					window_start: new Date(input.windowStartMs).toISOString(),
					window_end: new Date(input.windowEndMs).toISOString(),
					earliest_message_ts: earliestTs,
					latest_message_ts: latestTs,
					title: `Slack #${input.channelName} — ${date} (part ${part})`,
					mime_type: "text/markdown",
					[BRAIN_TAGS_METADATA_KEY]: ["source_slack", channelTag],
					[BRAIN_TAG_LABELS_METADATA_KEY]: [
						"Slack",
						`Channel #${input.channelName}`,
					],
				},
			})
			part++
			body = ""
			earliestTs = ""
			latestTs = ""
		}
		for (const unit of units) {
			const addition = `${body ? "\n\n" : ""}${unit.text}`
			if (body && prefix.length + body.length + addition.length > maxChars) {
				flush()
			}
			body += `${body ? "\n\n" : ""}${unit.text}`
			earliestTs ||= unit.earliestTs
			latestTs = unit.latestTs
		}
		flush()
	}
	return documents
}

/** Compact, channel-local evidence for theme extraction and introductions. */
export function recentSlackChannelEvidence(
	messages: SlackThreadMessage[],
	botUserId?: string | null,
	limit = 40,
	window?: { startMs: number; endMs: number },
): string {
	return messages
		.filter((message) => {
			if (!isSubstantive(message, botUserId)) return false
			if (!window) return true
			const ms = timestampMs(message.ts)
			return ms !== null && ms >= window.startMs && ms <= window.endMs
		})
		.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""))
		.slice(-limit)
		.map((message) => messageLine(message, Boolean(message.thread_ts)))
		.join("\n")
}
