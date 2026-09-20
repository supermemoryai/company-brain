import {
	isDurableObjectCodeUpdateReset,
	isDurableObjectMemoryLimitReset,
} from "agents"
import {
	type SerializedToolError,
	TOOL_ERROR_KINDS,
	ToolError,
	type ToolErrorInit,
} from "../../turn/errors"

const TOOL_ERROR_PREFIX = "CONNECTED_APP_TOOL_ERROR:"
const TOOL_ERROR_KIND_SET: ReadonlySet<string> = new Set(TOOL_ERROR_KINDS)

export function connectedAppError(init: ToolErrorInit): ToolError {
	return new ToolError(init)
}

export function encodeConnectedAppError(error: ToolError): string {
	return `${TOOL_ERROR_PREFIX}${JSON.stringify(error.serialize())}`
}

function serializedToolError(value: unknown): value is SerializedToolError {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const item = value as Partial<SerializedToolError>
	return (
		item.status === "error" &&
		typeof item.kind === "string" &&
		TOOL_ERROR_KIND_SET.has(item.kind) &&
		typeof item.tool === "string" &&
		typeof item.message === "string" &&
		typeof item.suggestion === "string" &&
		typeof item.retryable === "boolean"
	)
}

export function decodeConnectedAppError(
	message: string,
): SerializedToolError | undefined {
	const start = message.indexOf(TOOL_ERROR_PREFIX)
	if (start < 0) return undefined
	const encoded = message.slice(start + TOOL_ERROR_PREFIX.length).trim()
	try {
		const parsed: unknown = JSON.parse(encoded)
		return serializedToolError(parsed) ? parsed : undefined
	} catch {
		return undefined
	}
}

// Inlined from the agents SDK (landed there in 0.18.0); drop once we can take that version.
const STORAGE_RESET_PATTERN =
	/Internal error in Durable Object storage caused object to be reset/i

function isStorageReset(error: unknown): boolean {
	const text =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: ""
	return STORAGE_RESET_PATTERN.test(text)
}

export function isTransientRuntimeReset(error: unknown): boolean {
	return isDurableObjectCodeUpdateReset(error) || isStorageReset(error)
}

// An OOM re-OOMs on re-run: the program's working set is the cause, not the platform.
export function isRuntimeMemoryLimitReset(error: unknown): boolean {
	return isDurableObjectMemoryLimitReset(error)
}

function boundedDetail(message: string): string {
	return message.replace(/\s+/g, " ").trim().slice(0, 2_000)
}

export function sandboxToolError(
	message: string,
	traceId: string,
	kind: "sandbox_error" | "timeout",
): SerializedToolError {
	if (kind === "sandbox_error" && isTransientRuntimeReset(message)) {
		return connectedAppError({
			kind,
			tool: "run_app_code",
			message:
				"The connected-app runtime was restarted while the program was running (platform deploy or storage reset). The program itself was not at fault.",
			detail: boundedDetail(message),
			suggestion: "Retry the exact same program unchanged.",
			retryable: true,
			traceId,
		}).serialize()
	}
	if (kind === "sandbox_error" && isRuntimeMemoryLimitReset(message)) {
		return connectedAppError({
			kind,
			tool: "run_app_code",
			message:
				"The connected-app runtime ran out of memory and was reset. The program's syntax was not at fault; it asked for too much data at once.",
			detail: boundedDetail(message),
			suggestion:
				"Do not rerun this program unchanged — it will exhaust memory again. Fetch less per call: narrow the query, add limits, or split it into smaller sequential programs.",
			retryable: false,
			traceId,
		}).serialize()
	}
	return connectedAppError({
		kind,
		tool: "run_app_code",
		message:
			message.replace(/\s+/g, " ").trim().slice(0, 2_000) ||
			"The connected-app sandbox failed.",
		suggestion:
			"Correct the JavaScript using only discovered connector methods, then retry once. Split long programs into smaller bounded calls.",
		retryable: false,
		traceId,
	}).serialize()
}

export function errorResult(args: {
	error: ToolError | SerializedToolError
	logs?: string
	calls?: unknown[]
	partialResult?: unknown
}) {
	const error =
		args.error instanceof ToolError ? args.error.serialize() : args.error
	return {
		...error,
		logs: args.logs ?? "",
		calls: args.calls ?? [],
		...(args.partialResult !== undefined
			? { partialResult: args.partialResult }
			: {}),
	}
}
