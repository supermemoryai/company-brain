import { BRAIN_TRACE_ID_RE } from "../slack/message-trace"

const STRUCTURED_REPLY_KEYS = ["reply", "memory", "connect", "disconnect"]
const ZERO_WIDTH_CHARS = /[\u200B-\u200D\uFEFF\u2060]/g
const POSTHOG_TRACE_URL_RE =
	/https?:\/\/[^\s)>]*posthog\.com[^\s)>]*\/ai-observability\/traces\/[^\s)>]+/gi
const DEBUG_TRACE_LINE_RE =
	/^(?:.*\b(?:debug\s*id|posthog\s+trace|brain[_\s-]?trace(?:\s+id)?)\b.*)$/i
const TRACE_ID_PHRASE_RE =
	/\b(?:posthog\s+)?trace(?:\s+id)?(?:\s+from|\s+for|\s+is|\s+here|\s*:)\s*[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{22}\b/gi

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function looksLikeTurnOutput(value: unknown): value is { reply?: unknown } {
	if (!isRecord(value)) return false
	return STRUCTURED_REPLY_KEYS.some((key) => key in value)
}

function parseJsonObject(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

const DRAFTING_SELF_TALK =
	/\blet me (?:just )?(?:write|fix|redo|structure|compose|rewrite|format|try again|do this)\b|format the response properly|write your final|write the (?:json|response|reply)\b|i keep making mistakes|the reply (?:should|must) be\b/i

// English reply with CJK chars/punctuation spliced in = code-switch degeneration.
// Blocks: CJK punctuation, kana, CJK ideographs, fullwidth forms.
const CJK_CODE_SWITCH = /[\u3000-\u303F\u3040-\u30FF\u3400-\u9FFF\uFF00-\uFFEF]/

function isBrokenSlackReply(reply: string): boolean {
	const t = reply.replace(ZERO_WIDTH_CHARS, "").trim()
	if (!t || t === "..." || t === "…") return true
	if (DRAFTING_SELF_TALK.test(t)) return true
	if (CJK_CODE_SWITCH.test(t) && /[a-z]/i.test(t)) return true
	if (/^,\s/.test(t)) return true
	if (/"memory"\s*:|"connect"\s*:|"disconnect"\s*:/.test(t)) return true
	if (/\{","memory"|\}\w|\{\s*",/.test(t)) return true
	if (/^[}\]]/.test(t)) return true
	if (/[{}]{2,}\s*$/.test(t)) return true
	return false
}

// A malformed reply must never reach Slack. Semantic quality is observed in
// PostHog and does not affect runtime delivery.
export function isPublishableSlackReply(sanitized: string): boolean {
	return Boolean(sanitized.trim()) && !isBrokenSlackReply(sanitized)
}

function stripBrainTraceFromReply(reply: string): string {
	let out = reply.replace(POSTHOG_TRACE_URL_RE, "")
	out = out.replace(
		/\bdebug\s*id\s*:?\s*[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{22}\b/gi,
		"",
	)
	out = out.replace(TRACE_ID_PHRASE_RE, "")
	out = out
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim()
			if (!trimmed) return true
			if (DEBUG_TRACE_LINE_RE.test(trimmed)) return false
			if (
				/\b(?:posthog|debug)\b/i.test(trimmed) &&
				BRAIN_TRACE_ID_RE.test(trimmed)
			) {
				BRAIN_TRACE_ID_RE.lastIndex = 0
				return false
			}
			BRAIN_TRACE_ID_RE.lastIndex = 0
			return true
		})
		.join("\n")
	return out.replace(/\n{3,}/g, "\n\n").trim()
}

export function sanitizeSlackReply(reply: string): string {
	let out = reply.replace(ZERO_WIDTH_CHARS, "").trim()
	if (!out) return ""

	const whole = parseJsonObject(out)
	if (looksLikeTurnOutput(whole) && typeof whole.reply === "string") {
		out = whole.reply.replace(ZERO_WIDTH_CHARS, "").trim()
	}

	out = out.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, (match, jsonText) => {
		const parsed = parseJsonObject(jsonText)
		return looksLikeTurnOutput(parsed) ? "" : match
	})

	out = stripBrainTraceFromReply(out)
	out = out.replace(/^\s*[}\]]+\s*/, "").replace(/\s*[{}]{2,}\s*$/, "")
	return out.replace(/\n{3,}/g, "\n\n").trim()
}
