import type { SlackThreadMessage } from "./client"

export type SlackPromptBatch = {
	messages: SlackThreadMessage[]
	prompt: string
}

export function buildSlackPromptBatch(
	messages: SlackThreadMessage[],
	maxChars: number,
): SlackPromptBatch {
	const included: SlackThreadMessage[] = []
	const lines: string[] = []
	let length = 0

	for (const message of messages) {
		const line = `${message.user ?? "?"}: ${message.text ?? ""}`
		const separatorLength = lines.length ? 1 : 0
		if (length + separatorLength + line.length > maxChars) {
			if (included.length) break
			const fullMarker = " … [truncated]"
			const budget = Math.max(0, maxChars)
			const marker =
				budget > fullMarker.length ? fullMarker : "…".slice(0, budget)
			const truncated = `${line.slice(0, budget - marker.length)}${marker}`
			included.push(message)
			lines.push(truncated)
			break
		}
		included.push(message)
		lines.push(line)
		length += separatorLength + line.length
	}

	return { messages: included, prompt: lines.join("\n") }
}
