import type { TurnCardSource } from "./types"

// Tool results are usually structured: brain tools return { output, success },
// MCP tools return { content: [{ text }] }. Pull the human-readable text out.
function toDisplayText(output: unknown): string | undefined {
	if (typeof output === "string") return output
	if (!output || typeof output !== "object") return undefined
	const o = output as Record<string, unknown>
	if (typeof o.output === "string") return o.output
	if (typeof o.value === "string") return o.value
	if (typeof o.text === "string") return o.text
	if (Array.isArray(o.content)) {
		const parts = o.content
			.map((c) =>
				c &&
				typeof c === "object" &&
				typeof (c as Record<string, unknown>).text === "string"
					? ((c as Record<string, unknown>).text as string)
					: "",
			)
			.filter(Boolean)
		if (parts.length) return parts.join("\n")
	}
	return undefined
}

/** First meaningful line of a tool's output, cleaned of list/markdown noise. */
export function summarizeToolOutput(output: unknown): string | undefined {
	const text = toDisplayText(output)
	if (!text) return undefined
	const firstLine = text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0)
	if (!firstLine) return undefined
	const cleaned = firstLine
		.replace(/^[-*\d.)\s]+/, "")
		.replace(/[*_`>#]+/g, "")
		.replace(/\s+/g, " ")
		.trim()
	return cleaned ? cleaned.slice(0, 140) : undefined
}

const SLACK_LINK_RE = /<(https?:\/\/[^|>]+)\|([^>]+)>/gi
const URL_RE = /https?:\/\/[^\s<>|)\]]+/gi
const MAX_SOURCES = 3

/** Pull up to 3 unique links out of a tool's output for the card's sources row. */
export function extractCardSources(output: unknown): TurnCardSource[] {
	const text = toDisplayText(output)
	if (!text) return []
	const seen = new Set<string>()
	const sources: TurnCardSource[] = []
	const push = (rawUrl: string, label: string) => {
		if (sources.length >= MAX_SOURCES) return
		const url = rawUrl.replace(/[.,)]+$/, "")
		if (seen.has(url)) return
		seen.add(url)
		sources.push({ url, text: label.slice(0, 60) })
	}
	for (const m of text.matchAll(SLACK_LINK_RE)) {
		if (m[1]) push(m[1], sourceLabel(m[1], m[2]))
	}
	for (const m of text.matchAll(URL_RE)) {
		if (m[0]) push(m[0], sourceLabel(m[0]))
	}
	return sources
}

// Public cards leak personal-connection data, so only these tools show raw output.
const PUBLIC_CARD_PAYLOAD_TOOLS = new Set(["search_web"])

export function cardOutputPayload(
	toolName: string,
	output: unknown,
): { output?: string; sources?: TurnCardSource[] } {
	if (!PUBLIC_CARD_PAYLOAD_TOOLS.has(toolName)) return {}
	return {
		output: summarizeToolOutput(output),
		sources: extractCardSources(output),
	}
}

function sourceLabel(url: string, fallback?: string): string {
	if (fallback && !/^https?:/i.test(fallback)) return fallback.trim()
	try {
		const host = new URL(url).hostname.replace(/^www\./, "")
		return host.includes("slack.com") ? "Slack message" : host
	} catch {
		return "Source"
	}
}
