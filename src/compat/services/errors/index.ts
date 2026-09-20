import * as Data from "effect/Data"

// Billing related errors
export class BillingCheckError extends Data.TaggedError("BillingCheckError")<{
	orgId: string
	message: string
	cause?: unknown
}> {}

export class QuotaExceededError extends Data.TaggedError("QuotaExceededError")<{
	orgId: string
	userId: string
	featureId: string
	balance?: number
	allowed: boolean
	message?: string
}> {}

export class InvalidDocumentParametersError extends Data.TaggedError(
	"InvalidDocumentParametersError",
)<{
	message: string
	cause?: unknown
}> {}

export class SpaceCreationError extends Data.TaggedError("SpaceCreationError")<{
	containerTags: readonly string[]
	message: string
	cause?: unknown
}> {}

export class ContainerTagMergeInProgressError extends Data.TaggedError(
	"ContainerTagMergeInProgressError",
)<{
	containerTag: string
	targetTag: string
	mergeId: string
	message: string
}> {}

export class ContainerTagIngestInProgressError extends Data.TaggedError(
	"ContainerTagIngestInProgressError",
)<{
	containerTag: string
	message: string
}> {}

export class DocumentUpsertError extends Data.TaggedError(
	"DocumentUpsertError",
)<{
	orgId: string
	message: string
	cause?: unknown
}> {}

export class FilepathCollisionError extends Data.TaggedError(
	"FilepathCollisionError",
)<{
	filepath: string
	conflictingFilepath: string
}> {}

/** Cloudflare Workflow.create / createBatch / get failed (incl. FiberFailure from the runtime). */
export class WorkflowScheduleError extends Data.TaggedError(
	"WorkflowScheduleError",
)<{
	readonly operation: "create" | "createBatch" | "get"
	readonly message: string
	readonly cause?: unknown
}> {}

// Qualitative analysis errors
export class QualitativeAnalysisError extends Data.TaggedError(
	"QualitativeAnalysisError",
)<{
	orgId: string
	message: string
	cause?: unknown
}> {}

export class AgentExecutionError extends Data.TaggedError(
	"AgentExecutionError",
)<{
	orgId: string
	message: string
	cause?: unknown
}> {}

export class ReportParsingError extends Data.TaggedError("ReportParsingError")<{
	orgId: string
	message: string
	rawOutput?: string
	cause?: unknown
}> {}
