/** Max chars for markdown block / markdown_text stream chunk (per payload). */
export const SLACK_MARKDOWN_LIMIT = 12_000

/** Max chars for mrkdwn inside a section block. */
export const SLACK_MRKDWN_SECTION_LIMIT = 3_000

const FENCE_RE = /(```[\s\S]*?```)/g
const SLACK_CONTINUATION_SENTENCE = "_Continued in the next section._"

function normalizeSegment(
	text: string,
	collapseSpaces: boolean,
	dash: string,
): string {
	let out = text
		.replace(/(\d)\s*[\u2014\u2013]\s*(\d)/g, "$1-$2")
		.replace(/\s*\u2014\s*/g, dash)
		.replace(/\s*\u2013\s*/g, dash)
	if (collapseSpaces) out = out.replace(/ {2,}/g, " ")
	return out
}

/** Normalize em/en dashes outside fenced code. `dash` is the replacement:
 * Slack rendering uses " - ", prose uses ", ". Numeric ranges keep a hyphen. */
export function normalizeTextPreservingCodeFences(
	text: string,
	dash = " - ",
): string {
	const parts = text.split(FENCE_RE)
	return parts
		.map((part, i) => normalizeSegment(part, i % 2 === 0, dash))
		.join("")
}

function fenceAt(text: string, index: number): boolean {
	let fences = 0
	let cursor = text.indexOf("```")
	while (cursor >= 0 && cursor < index) {
		fences += 1
		cursor = text.indexOf("```", cursor + 3)
	}
	return fences % 2 === 1
}

function lastCompleteSentenceBoundary(text: string): number {
	const pattern = /[.!?](?:["'’”\])}*_`]+)?(?=\s|$)/g
	let boundary = 0
	for (const match of text.matchAll(pattern)) {
		const end = (match.index ?? 0) + match[0].length
		if (fenceAt(text, end)) continue
		const lineStart = text.lastIndexOf("\n", match.index ?? 0) + 1
		const lineEnd = text.indexOf("\n", end)
		const line = text.slice(lineStart, lineEnd >= 0 ? lineEnd : text.length)
		// A period inside a table cell is not a safe row boundary.
		if (line.trimStart().startsWith("|")) continue
		boundary = end
	}
	return boundary
}

function openFenceLanguage(text: string): string | undefined {
	const matches = [...text.matchAll(/```([^\n]*)/g)]
	if (matches.length % 2 === 0) return undefined
	return matches.at(-1)?.[1]?.trim() ?? ""
}

/** Split long Slack markdown without making normal prose look abruptly cut.
 * Complete sentences are preferred. A pathological single sentence, table,
 * or code block gets an explicit continuation sentence; fenced code is closed
 * and reopened so every individual Slack block remains renderable. */
export function splitSlackMarkdown(
	text: string,
	maxChars: number = SLACK_MARKDOWN_LIMIT,
): string[] {
	if (maxChars <= SLACK_CONTINUATION_SENTENCE.length + 16) {
		throw new RangeError(
			"Slack markdown chunks need room for continuation text",
		)
	}
	let remaining = normalizeTextPreservingCodeFences(text).trim()
	if (!remaining) return []
	const chunks: string[] = []

	while (remaining.length > maxChars) {
		const window = remaining.slice(0, maxChars)
		const sentenceBoundary = lastCompleteSentenceBoundary(window)
		if (sentenceBoundary > 0) {
			chunks.push(remaining.slice(0, sentenceBoundary).trimEnd())
			remaining = remaining.slice(sentenceBoundary).trimStart()
			continue
		}

		const marker = `\n\n${SLACK_CONTINUATION_SENTENCE}`
		const provisionalLimit = maxChars - marker.length - 5
		const provisional = remaining.slice(0, provisionalLimit)
		const lineBoundary = provisional.lastIndexOf("\n")
		const wordBoundary = provisional.lastIndexOf(" ")
		// Prefer a reasonably full line boundary for tables and code. Falling back
		// to the latest word keeps pathological single lines within Slack's limit.
		let boundary =
			lineBoundary >= provisionalLimit / 2 ? lineBoundary : wordBoundary
		if (boundary <= 0) boundary = provisionalLimit
		let body = remaining.slice(0, boundary).trimEnd()
		let next = remaining.slice(boundary).trimStart()
		const language = openFenceLanguage(body)
		if (language !== undefined) {
			body = `${body}\n\`\`\``
			next = `\`\`\`${language}\n${next}`
		}
		chunks.push(`${body}${marker}`)
		remaining = next
	}

	if (remaining) chunks.push(remaining)
	return chunks
}

/**
 * Legacy mrkdwn for section/context blocks and plain `text` on chat.postMessage.
 * Subset only: *bold*, _italic_, `code`, <url|label>, `-` bullets.
 * No tables, headers, or horizontal rules.
 */
export function toSlackMrkdwn(text: string): string {
	const normalized = normalizeTextPreservingCodeFences(text)
	const inline = (s: string): string =>
		s
			.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>")
			.replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
			.replace(/__([^_\n]+)__/g, "*$1*")
	const out: string[] = []
	for (const line of normalized.split("\n")) {
		if (/^\s*([-*_])\1{2,}\s*$/.test(line)) continue
		const header = line.match(/^#{1,6}\s+(.+?)\s*$/)
		if (header?.[1]) {
			out.push(`*${inline(header[1])}*`)
			continue
		}
		if (/^\s*\|.*\|\s*$/.test(line)) {
			if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-")) continue
			const cells = line
				.trim()
				.replace(/^\||\|$/g, "")
				.split("|")
				.map((c) => inline(c.trim()))
				.filter((c) => c.length > 0)
			if (cells.length) out.push(cells.join("  ·  "))
			continue
		}
		out.push(inline(line))
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n")
}

/** Strip markdown-ish syntax for notification fallback `text`. */
export function plainTextFallback(text: string): string {
	return normalizeTextPreservingCodeFences(text)
		.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/_([^_]+)_/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.slice(0, SLACK_MRKDWN_SECTION_LIMIT)
}

// Turn a tool id like `notion.notion-create-pages` into "Notion · Create pages".
export function humanizeToolAction(raw: string): string {
	const dot = raw.indexOf(".")
	const server = dot > 0 ? raw.slice(0, dot) : ""
	let tool = dot > 0 ? raw.slice(dot + 1) : raw
	if (server && tool.toLowerCase().startsWith(`${server.toLowerCase()}-`)) {
		tool = tool.slice(server.length + 1)
	}
	const words = (s: string) =>
		s
			.split(/[-_\s]+/)
			.filter(Boolean)
			.join(" ")
	const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
	const app = server ? cap(words(server)) : ""
	const action = cap(words(tool))
	return app ? `${app} · ${action}` : action
}

export const BRAIN_TRACE_POSTHOG_BASE =
	"https://us.posthog.com/project/148541/ai-observability/traces"

export function markdownReplyBlocks(text: string): unknown[] {
	const chunks = splitSlackMarkdown(text)
	if (chunks.length > 1) {
		throw new RangeError(
			"Slack markdown blocks have a cumulative 12,000-character payload limit; send chunks as separate messages",
		)
	}
	return chunks.map((chunk) => ({ type: "markdown", text: chunk }))
}

export function mrkdwnReplyBlocks(text: string): unknown[] {
	return [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: toSlackMrkdwn(text).slice(0, SLACK_MRKDWN_SECTION_LIMIT),
			},
		},
	]
}
