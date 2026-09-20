export const TOOL_ERROR_KINDS = [
	"discovery_required",
	"invalid_arguments",
	"remote_error",
	"policy_denied",
	"approval_required",
	"duplicate_call",
	"program_too_large",
	"budget_exhausted",
	"timeout",
	"unavailable",
	"auth_required",
	"unknown_method",
	"schema_hydration_failed",
	"result_too_large",
	"sandbox_error",
	"error_swallowed",
	"internal_error",
] as const

export type ToolErrorKind = (typeof TOOL_ERROR_KINDS)[number]

export type ToolErrorInit = {
	kind: ToolErrorKind
	tool: string
	message: string
	suggestion: string
	retryable: boolean
	contract?: string
	detail?: string
	traceId?: string
}

export type SerializedToolError = {
	status: "error"
	kind: ToolErrorKind
	tool: string
	message: string
	suggestion: string
	retryable: boolean
	expected?: string
	detail?: string
}

function bounded(value: string | undefined, max: number): string | undefined {
	const normalized = value?.replace(/\s+/g, " ").trim()
	if (!normalized) return undefined
	return normalized.length <= max
		? normalized
		: `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

export class ToolError extends Error {
	readonly kind: ToolErrorKind
	readonly tool: string
	readonly suggestion: string
	readonly retryable: boolean
	readonly contract?: string
	readonly detail?: string
	readonly traceId?: string

	constructor(init: ToolErrorInit) {
		super(init.message)
		this.name = "ToolError"
		this.kind = init.kind
		this.tool = init.tool
		this.suggestion = init.suggestion
		this.retryable = init.retryable
		this.contract = bounded(init.contract, 4_000)
		this.detail = bounded(init.detail, 2_000)
		this.traceId = init.traceId
		console.warn(
			`[company-brain][${init.traceId ?? "no-trace"}] ToolError kind=${init.kind} tool=${init.tool}`,
		)
	}

	serialize(): SerializedToolError {
		return {
			status: "error",
			kind: this.kind,
			tool: this.tool,
			message: this.message,
			suggestion: this.suggestion,
			retryable: this.retryable,
			...(this.contract ? { expected: this.contract } : {}),
			...(this.detail ? { detail: this.detail } : {}),
		}
	}

	toJSON(): SerializedToolError {
		return this.serialize()
	}
}
