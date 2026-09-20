import { type ChannelDirectory, getChannelDirectory } from "./channel-directory"

const CHANNEL_REFERENCE_RE =
	/(^|[\s([{'"“‘>])(?:#?([CG][A-Z0-9]{8,})|#([A-Za-z0-9][A-Za-z0-9_-]*))(?=$|[\s)\]},.!?:;'"”’])/g
const CHANNEL_REFERENCE_CANDIDATE_RE =
	/(^|[\s([{'"“‘>])(?:#?[CG][A-Z0-9]{8,}|#[A-Za-z0-9][A-Za-z0-9_-]*)(?=$|[\s)\]},.!?:;'"”’])/
const SLACK_ANGLE_TOKEN_RE =
	/^<(?:#[CG][A-Z0-9]+(?:\|[^<>\r\n]*)?|@[A-Z0-9]+(?:\|[^<>\r\n]*)?|![^<>\r\n]+|(?:https?:\/\/|mailto:)[^<>\r\n]+)>/i

function backtickCodeEnd(text: string, start: number): number | undefined {
	let delimiterEnd = start
	while (text[delimiterEnd] === "`") delimiterEnd += 1
	const delimiterLength = delimiterEnd - start
	let cursor = delimiterEnd
	while (cursor < text.length) {
		const next = text.indexOf("`", cursor)
		if (next === -1) return undefined
		let runEnd = next
		while (text[runEnd] === "`") runEnd += 1
		if (runEnd - next === delimiterLength) return runEnd
		cursor = runEnd
	}
	return undefined
}

function bracketEnd(text: string, start: number): number | undefined {
	let depth = 1
	let cursor = start + 1
	while (cursor < text.length && depth > 0) {
		if (text[cursor] === "\\") {
			cursor += 2
			continue
		}
		if (text[cursor] === "`") {
			const codeEnd = backtickCodeEnd(text, cursor)
			if (codeEnd !== undefined) {
				cursor = codeEnd
				continue
			}
		}
		if (text[cursor] === "[") depth += 1
		if (text[cursor] === "]") depth -= 1
		cursor += 1
	}
	return depth === 0 ? cursor - 1 : undefined
}

function normalizeReferenceLabel(label: string): string {
	return label
		.replace(/\\([[\]\\])/g, "$1")
		.trim()
		.replace(/\s+/g, " ")
		.toLowerCase()
}

function referenceLabels(text: string): Set<string> {
	const labels = new Set<string>()
	let lineStart = 0
	while (lineStart < text.length) {
		const lineEnd = text.indexOf("\n", lineStart)
		const end = lineEnd === -1 ? text.length : lineEnd
		const line = text.slice(lineStart, end)
		const opening = line.match(/^[ \t]{0,3}\[/)?.[0]
		if (opening) {
			const bracketStart = lineStart + opening.length - 1
			const close = bracketEnd(text, bracketStart)
			if (close !== undefined && close < end && text[close + 1] === ":") {
				labels.add(normalizeReferenceLabel(text.slice(bracketStart + 1, close)))
			}
		}
		if (lineEnd === -1) break
		lineStart = lineEnd + 1
	}
	return labels
}

function skipLinkWhitespace(text: string, start: number): number {
	let cursor = start
	let newlines = 0
	while (cursor < text.length && /[ \t\r\n]/.test(text[cursor] ?? "")) {
		if (text[cursor] === "\n" && ++newlines > 1) break
		cursor += 1
	}
	return cursor
}

function linkTitleEnd(text: string, start: number): number | undefined {
	const opener = text[start]
	if (opener !== '"' && opener !== "'" && opener !== "(") return undefined
	const closer = opener === "(" ? ")" : opener
	let cursor = start + 1
	while (cursor < text.length) {
		if (text[cursor] === "\\") {
			cursor += 2
			continue
		}
		if (text[cursor] === "\n" && text[cursor + 1] === "\n") return undefined
		if (text[cursor] === closer) return cursor + 1
		cursor += 1
	}
	return undefined
}

function inlineLinkEnd(text: string, labelEnd: number): number | undefined {
	if (text[labelEnd + 1] !== "(") return undefined
	let cursor = skipLinkWhitespace(text, labelEnd + 2)
	if (text[cursor] === "<") {
		cursor += 1
		while (cursor < text.length) {
			if (text[cursor] === "\\") {
				cursor += 2
				continue
			}
			if (text[cursor] === "\n" || text[cursor] === "<") return undefined
			if (text[cursor] === ">") {
				cursor += 1
				break
			}
			cursor += 1
		}
		if (text[cursor - 1] !== ">") return undefined
	} else {
		let depth = 0
		while (cursor < text.length) {
			if (text[cursor] === "\\") {
				cursor += 2
				continue
			}
			if (/[ \t\r\n]/.test(text[cursor] ?? "")) break
			if (text[cursor] === "<") return undefined
			if (text[cursor] === "(") depth += 1
			if (text[cursor] === ")") {
				if (depth === 0) return cursor + 1
				depth -= 1
			}
			cursor += 1
		}
		if (depth !== 0) return undefined
	}

	const titleStart = skipLinkWhitespace(text, cursor)
	if (text[titleStart] === ")") return titleStart + 1
	if (titleStart === cursor) return undefined
	const titleEnd = linkTitleEnd(text, titleStart)
	if (titleEnd === undefined) return undefined
	const close = skipLinkWhitespace(text, titleEnd)
	return text[close] === ")" ? close + 1 : undefined
}

function markdownLinkEnd(
	text: string,
	start: number,
	definitions: Set<string>,
): number | undefined {
	const labelEnd = bracketEnd(text, start)
	if (labelEnd === undefined) return undefined
	const inlineEnd = inlineLinkEnd(text, labelEnd)
	if (inlineEnd !== undefined) return inlineEnd

	const label = text.slice(start + 1, labelEnd)
	if (text[labelEnd + 1] === "[") {
		const referenceEnd = bracketEnd(text, labelEnd + 1)
		if (referenceEnd === undefined) return undefined
		const reference = text.slice(labelEnd + 2, referenceEnd)
		const key = normalizeReferenceLabel(reference || label)
		return definitions.has(key) ? referenceEnd + 1 : undefined
	}
	return definitions.has(normalizeReferenceLabel(label))
		? labelEnd + 1
		: undefined
}

function referenceDefinitionEnd(
	text: string,
	start: number,
	definitions: Set<string>,
): number | undefined {
	const lineStart = text.lastIndexOf("\n", start - 1) + 1
	if (!/^[ \t]{0,3}$/.test(text.slice(lineStart, start))) return undefined
	const labelEnd = bracketEnd(text, start)
	if (labelEnd === undefined || text[labelEnd + 1] !== ":") return undefined
	const label = normalizeReferenceLabel(text.slice(start + 1, labelEnd))
	if (!definitions.has(label)) return undefined
	const lineEnd = text.indexOf("\n", labelEnd + 2)
	if (lineEnd === -1) return text.length

	let destinationEnd = labelEnd + 2
	while (/[ \t]/.test(text[destinationEnd] ?? "")) destinationEnd += 1
	if (text[destinationEnd] === "<") {
		const close = text.indexOf(">", destinationEnd + 1)
		if (close === -1 || close > lineEnd) return lineEnd + 1
		destinationEnd = close + 1
	} else {
		while (
			destinationEnd < lineEnd &&
			!/[ \t\r]/.test(text[destinationEnd] ?? "")
		) {
			destinationEnd += 1
		}
	}
	if (text.slice(destinationEnd, lineEnd).trim()) return lineEnd + 1

	const continuationEnd = text.indexOf("\n", lineEnd + 1)
	const nextLineEnd = continuationEnd === -1 ? text.length : continuationEnd
	const continuation = text.slice(lineEnd + 1, nextLineEnd)
	const indentation = continuation.match(/^[ \t]{1,3}/)?.[0]
	if (!indentation) return lineEnd + 1
	const titleStart = lineEnd + 1 + indentation.length
	const titleEnd = linkTitleEnd(text, titleStart)
	if (
		titleEnd === undefined ||
		titleEnd > nextLineEnd ||
		text.slice(titleEnd, nextLineEnd).trim()
	) {
		return lineEnd + 1
	}
	return continuationEnd === -1 ? text.length : continuationEnd + 1
}

function fencedCodeEnd(text: string, start: number): number | undefined {
	const marker = text[start]
	if (marker !== "`" && marker !== "~") return undefined
	const lineStart = text.lastIndexOf("\n", start - 1) + 1
	if (!/^[ \t]{0,3}$/.test(text.slice(lineStart, start))) return undefined
	let markerEnd = start
	while (text[markerEnd] === marker) markerEnd += 1
	const markerLength = markerEnd - start
	if (markerLength < 3) return undefined
	const openingLineEnd = text.indexOf("\n", markerEnd)
	const openingEnd = openingLineEnd === -1 ? text.length : openingLineEnd
	if (marker === "`" && text.slice(markerEnd, openingEnd).includes("`")) {
		return undefined
	}

	let nextLine = openingLineEnd === -1 ? text.length : openingLineEnd + 1
	while (nextLine < text.length) {
		const lineEnd = text.indexOf("\n", nextLine)
		const end = lineEnd === -1 ? text.length : lineEnd
		let cursor = nextLine
		while (
			cursor < end &&
			cursor - nextLine < 3 &&
			/[ \t]/.test(text[cursor] ?? "")
		) {
			cursor += 1
		}
		let closeEnd = cursor
		while (text[closeEnd] === marker) closeEnd += 1
		if (
			closeEnd - cursor >= markerLength &&
			/^[ \t\r]*$/.test(text.slice(closeEnd, end))
		) {
			return lineEnd === -1 ? text.length : lineEnd + 1
		}
		if (lineEnd === -1) break
		nextLine = lineEnd + 1
	}
	return text.length
}

function outsideProtectedRanges(
	text: string,
	transform: (segment: string) => string,
): string {
	const definitions = referenceLabels(text)
	let output = ""
	let segmentStart = 0
	let cursor = 0

	while (cursor < text.length) {
		let protectedEnd = fencedCodeEnd(text, cursor)
		if (protectedEnd === undefined && text[cursor] === "[") {
			protectedEnd =
				referenceDefinitionEnd(text, cursor, definitions) ??
				markdownLinkEnd(text, cursor, definitions)
		} else if (protectedEnd === undefined && text[cursor] === "<") {
			const token = text.slice(cursor).match(SLACK_ANGLE_TOKEN_RE)?.[0]
			if (token) protectedEnd = cursor + token.length
		}
		if (protectedEnd !== undefined) {
			output += transform(text.slice(segmentStart, cursor))
			output += text.slice(cursor, protectedEnd)
			cursor = protectedEnd
			segmentStart = protectedEnd
			continue
		}

		if (text[cursor] !== "`") {
			cursor += 1
			continue
		}
		const codeEnd = backtickCodeEnd(text, cursor)
		output += transform(text.slice(segmentStart, cursor))
		if (codeEnd === undefined) return output + text.slice(cursor)
		protectedEnd = codeEnd
		output += text.slice(cursor, protectedEnd)
		cursor = protectedEnd
		segmentStart = protectedEnd
	}
	return output + transform(text.slice(segmentStart))
}

/**
 * Convert model-friendly Slack channel references into standard Markdown links.
 * Existing Slack control tokens, person names/mentions, URLs, and code stay
 * untouched. Unknown channel names remain readable, while unknown raw IDs are
 * made generic rather than being exposed to a person.
 */
export function formatSlackChannelReferences(
	text: string,
	channels: ChannelDirectory,
	teamId: string,
): string {
	const normalizedTeamId = typeof teamId === "string" ? teamId.trim() : ""
	if (!text.trim() || !normalizedTeamId) return text
	const channelsByName = new Map(
		channels.map((channel) => [channel.name.toLowerCase(), channel]),
	)
	const channelsById = new Map(
		channels.map((channel) => [channel.id.toUpperCase(), channel]),
	)
	const encodedTeamId = encodeURIComponent(normalizedTeamId)

	return outsideProtectedRanges(text, (segment) => {
		return segment.replace(
			CHANNEL_REFERENCE_RE,
			(
				full,
				prefix: string,
				rawId: string | undefined,
				rawName: string | undefined,
			) => {
				const channel = rawId
					? (channelsById.get(rawId.toUpperCase()) ??
						(full.slice(prefix.length).startsWith("#")
							? channelsByName.get(rawId.toLowerCase())
							: undefined))
					: channelsByName.get(rawName?.toLowerCase() ?? "")
				if (!channel) return rawId ? `${prefix}that channel` : full
				const url = `https://app.slack.com/client/${encodedTeamId}/${encodeURIComponent(channel.id)}`
				return `${prefix}[#${channel.name}](${url})`
			},
		)
	})
}

export type SlackReplyReferenceResolver = (reply: string) => Promise<string>

/** Lazily loads the bot-visible channel directory once per delivery session. */
export function createSlackReplyReferenceResolver(args: {
	env: Env
	teamId: string
	botToken: string
}): SlackReplyReferenceResolver {
	let directoryPromise: Promise<ChannelDirectory> | undefined

	return async (reply) => {
		const teamId = typeof args.teamId === "string" ? args.teamId.trim() : ""
		if (
			!teamId ||
			!reply.trim() ||
			!CHANNEL_REFERENCE_CANDIDATE_RE.test(reply)
		) {
			return reply
		}
		directoryPromise ??= getChannelDirectory(args.env, teamId, args.botToken)
		try {
			const channels = await directoryPromise
			return formatSlackChannelReferences(reply, channels, teamId)
		} catch (error) {
			console.warn(
				"[company-brain] Slack channel reference lookup failed:",
				error,
			)
			return formatSlackChannelReferences(reply, [], teamId)
		}
	}
}
