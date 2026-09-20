export function logPreview(value: string | undefined, max = 160): string {
	return (value ?? "").replace(/\s+/g, " ").trim().slice(0, max)
}

export function redactedPreview(value: unknown, max = 1500): string {
	const secretKey =
		/token|secret|password|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie/i
	const secretValue =
		/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{20,})\b/g
	try {
		const text =
			typeof value === "string"
				? value
				: JSON.stringify(value, (key, val) => {
						if (secretKey.test(key)) return "[redacted]"
						if (typeof val === "string")
							return val.replace(secretValue, "[redacted]")
						return val
					})
		return text.replace(/\s+/g, " ").slice(0, max)
	} catch {
		return "[unserializable]"
	}
}

export function logToolInput(toolCall: unknown): string {
	const call = toolCall as Record<string, unknown>
	const input = call.input ?? call.args ?? call.arguments
	if (input === undefined) return "{}"
	return redactedPreview(input, 2000)
}

export type BrainToolCallEvent = {
	toolCall: { toolCallId: string; toolName: string; input?: unknown }
	success?: boolean
}

export function getToolFinishOutput(event: unknown): unknown {
	const e = event as Record<string, unknown>
	return (
		e.output ??
		e.result ??
		e.toolResult ??
		e.response ??
		(e.toolCall && typeof e.toolCall === "object"
			? (e.toolCall as Record<string, unknown>).output
			: undefined)
	)
}
