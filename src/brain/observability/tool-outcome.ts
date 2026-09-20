import { TOOL_ERROR_KINDS, type ToolErrorKind } from "../turn/errors"

const TOOL_ERROR_KIND_SET = new Set<string>(TOOL_ERROR_KINDS)

function outputValue(output: unknown): unknown {
	if (typeof output === "string" && output.trimStart().startsWith("{")) {
		try {
			return JSON.parse(output)
		} catch {
			return output
		}
	}
	if (!output || typeof output !== "object" || Array.isArray(output))
		return output
	const record = output as Record<string, unknown>
	return "value" in record ? record.value : output
}

export function toolErrorKindsFromOutput(output: unknown): ToolErrorKind[] {
	const value = outputValue(output)
	if (!value || typeof value !== "object" || Array.isArray(value)) return []
	const record = value as Record<string, unknown>
	if (
		record.status === "error" &&
		typeof record.kind === "string" &&
		TOOL_ERROR_KIND_SET.has(record.kind)
	) {
		return [record.kind as ToolErrorKind]
	}
	const calls = Array.isArray(record.calls) ? record.calls : []
	return calls.flatMap((call) => {
		if (!call || typeof call !== "object" || Array.isArray(call)) return []
		const kind = (call as Record<string, unknown>).errorKind
		return typeof kind === "string" && TOOL_ERROR_KIND_SET.has(kind)
			? [kind as ToolErrorKind]
			: []
	})
}
