export function abortError(
	signal: AbortSignal,
	fallbackMessage = "Turn aborted",
): Error {
	const reason = signal.reason
	if (reason instanceof Error) return reason
	const error = new Error(
		typeof reason === "string" && reason.trim() ? reason : fallbackMessage,
	)
	if (
		typeof reason === "object" &&
		reason !== null &&
		"name" in reason &&
		typeof reason.name === "string"
	) {
		error.name = reason.name
	}
	return error
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return
	throw abortError(signal)
}

// Stops awaiting on abort; it cannot terminate `operation`, which runs on.
export function raceWithAbortSignal<T>(
	operation: Promise<T>,
	signal: AbortSignal | undefined,
): Promise<T> {
	if (!signal) return operation
	if (signal.aborted) {
		return Promise.reject(abortError(signal))
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(abortError(signal))
		}
		signal.addEventListener("abort", onAbort, { once: true })
		operation.then(
			(value) => {
				signal.removeEventListener("abort", onAbort)
				resolve(value)
			},
			(error) => {
				signal.removeEventListener("abort", onAbort)
				reject(error)
			},
		)
	})
}

export const TURN_DEADLINE_MS = 5 * 60 * 1000

// The race stops awaiting; the operation still needs to meter and clean up.
export function retainAbandoned(
	operation: Promise<unknown>,
	waitUntil: (promise: Promise<unknown>) => void,
): void {
	waitUntil(
		operation.then(
			() => {},
			() => {},
		),
	)
}

// Continuations are full turns, so each gets its own deadline.
export function turnDeadlineSignal(control?: AbortSignal): {
	deadline: AbortSignal
	signal: AbortSignal
} {
	const deadline = AbortSignal.timeout(TURN_DEADLINE_MS)
	return {
		deadline,
		signal: control ? AbortSignal.any([control, deadline]) : deadline,
	}
}

export type TurnFailureTerminal = {
	turnStatus: "timed_out" | "cancelled" | "failed"
	error: "turn_deadline" | "turn_cancelled" | "turn_failed"
}

export type TurnCoordinationFailureCode =
	| "turn_finalization_inactive"
	| "turn_finalization_inbox_inconsistent"

const TURN_EXCEPTION_FAILURE_CODE_BY_NAME = {
	Error: "exception_error",
	TypeError: "exception_type_error",
	RangeError: "exception_range_error",
	SyntaxError: "exception_syntax_error",
	AggregateError: "exception_aggregate_error",
	AbortError: "exception_abort_error",
	TimeoutError: "exception_timeout_error",
	ToolError: "exception_tool_error",
	SlackArtifactUploadError: "exception_slack_artifact_upload_error",
	AI_APICallError: "exception_ai_api_call_error",
	AI_EmptyResponseBodyError: "exception_ai_empty_response_body_error",
	AI_InvalidArgumentError: "exception_ai_invalid_argument_error",
	AI_InvalidPromptError: "exception_ai_invalid_prompt_error",
	AI_InvalidResponseDataError: "exception_ai_invalid_response_data_error",
	AI_JSONParseError: "exception_ai_json_parse_error",
	AI_LoadAPIKeyError: "exception_ai_load_api_key_error",
	AI_LoadSettingError: "exception_ai_load_setting_error",
	AI_NoContentGeneratedError: "exception_ai_no_content_generated_error",
	AI_NoSuchModelError: "exception_ai_no_such_model_error",
	AI_RetryError: "exception_ai_retry_error",
	AI_TypeValidationError: "exception_ai_type_validation_error",
	AI_UnsupportedFunctionalityError:
		"exception_ai_unsupported_functionality_error",
} as const

type TurnExceptionFailureCode =
	| (typeof TURN_EXCEPTION_FAILURE_CODE_BY_NAME)[keyof typeof TURN_EXCEPTION_FAILURE_CODE_BY_NAME]
	| "exception_unknown"

export type TurnFailureCode =
	| TurnFailureTerminal["error"]
	| TurnCoordinationFailureCode
	| TurnExceptionFailureCode

export class TurnCoordinationError extends Error {
	readonly code: TurnCoordinationFailureCode

	constructor(code: TurnCoordinationFailureCode) {
		super("Turn coordination failed", { cause: code })
		this.name = "TurnCoordinationError"
		this.code = code
	}
}

export function turnFailureTerminal(
	signal: AbortSignal | undefined,
): TurnFailureTerminal {
	if (!signal?.aborted) {
		return { turnStatus: "failed", error: "turn_failed" }
	}
	const reason = signal.reason
	if (
		typeof reason === "object" &&
		reason !== null &&
		"name" in reason &&
		reason.name === "TimeoutError"
	) {
		return { turnStatus: "timed_out", error: "turn_deadline" }
	}
	return { turnStatus: "cancelled", error: "turn_cancelled" }
}

export function turnFailureCode(
	error: unknown,
	signal: AbortSignal | undefined,
): TurnFailureCode {
	const terminal = turnFailureTerminal(signal)
	if (terminal.error !== "turn_failed") return terminal.error
	if (error instanceof TurnCoordinationError) return error.code

	if (!(error instanceof Error)) return "exception_unknown"
	return (
		TURN_EXCEPTION_FAILURE_CODE_BY_NAME[
			error.name as keyof typeof TURN_EXCEPTION_FAILURE_CODE_BY_NAME
		] ?? "exception_unknown"
	)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

export function toolInputSlug(input: unknown): string | undefined {
	if (!isRecord(input)) return undefined
	const slug = input.slug ?? input.tool
	return typeof slug === "string" ? slug : undefined
}

export function toolInputArguments(input: unknown): Record<string, unknown> {
	if (!isRecord(input)) return {}
	const args = input.arguments
	return isRecord(args) ? args : input
}

export function firstString(
	record: Record<string, unknown>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = record[key]
		if (typeof value === "string" && value.trim()) return value.trim()
	}
}

export function compactText(value: string, max = 1400): string {
	const compact = value
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
	return compact.length > max
		? `${compact.slice(0, max - 1).trim()}...`
		: compact
}

/**
 * JSON.stringify that never throws. Tool inputs/outputs are untrusted shapes
 * (a BigInt or circular ref throws a raw TypeError), and some callers run
 * outside a try/catch (e.g. the post-turn memory pass in extraction.ts),
 * where a throw would abort the turn and drop the memory write.
 */
export function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value)
	} catch {
		return "[unserializable]"
	}
}
