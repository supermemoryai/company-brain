import { generateId } from "@repo/lib/generate-id"
import {
	captureAiGeneration,
	captureAiGenerationAwaitable,
	captureAiSpan,
	captureAiSpanAwaitable,
	captureAiTrace,
	flushTelemetry,
} from "@/lib/posthog"
import { getModelInfo, type SupportedModel } from "@/routes/chat/util"
import type {
	ChimeContext,
	TriageGenerationError,
	TriageOutcome,
	TriageProviderError,
	TriageResult,
} from "../slack/triage"
import type { ToolErrorKind } from "../turn/errors"
import type { TurnReplySource } from "../turn/finalization"
import { BRAIN_MODEL, TRIAGE_MODEL } from "../turn/model-profile"
import type { TurnState } from "../turn/state"
import type { TurnTerminalOutcome } from "../turn/terminal"
import { toolErrorKindsFromOutput } from "./tool-outcome"

export { toolErrorKindsFromOutput } from "./tool-outcome"

export type BrainObservabilityInput = {
	traceId?: string
	sessionId?: string
	channel?: string
	/** Slack ts of the message that triggered this turn. */
	messageTs?: string
	/** Slack thread_ts (same as session root when in a thread). */
	threadTs?: string
	source?:
		| "slack_turn"
		| "slack_chime_thread"
		| "slack_chime_channel"
		| "slack_connect_retry"
		| "slack_approval"
		| "automation"
		| "scheduled_reminder"
		| "auto_research"
		| "api"
	triageResult?: string
	/** PostHog distinct id — defaults to computeTurn userId when omitted. */
	distinctId?: string
	/** Automation identity, set on scheduled/run-now automation turns. */
	automationId?: string
	automationTitle?: string
	automationCadence?: "daily" | "weekly"
	deliverTo?: "origin" | "dm" | "channel"
	runTrigger?: "scheduled" | "run_now"
}

function slackThreadRef(
	channel?: string,
	threadTs?: string,
): string | undefined {
	return channel && threadTs ? `${channel}:${threadTs}` : undefined
}

type PromptStats = {
	systemChars: number
	runtimeChars: number
	threadChars: number
	threadMessages: number
	requestChars: number
	contextMode: "lazy"
	hiddenToolCount: number
	lazyToolFamilies: string[]
}

function toolLatencyPhase(
	toolName: string,
): "discover" | "sandbox" | undefined {
	if (
		toolName === "discover_app_methods" ||
		toolName === "mcp_search_tools" ||
		toolName === "mcp_describe_tool"
	) {
		return "discover"
	}
	if (toolName === "run_app_code" || toolName === "mcp_execute_tool") {
		return "sandbox"
	}
	return undefined
}

/** Discovery/bookkeeping tools don't count as investigation. */
export function toolProducesEvidence(toolName: string): boolean {
	return ![
		"enable_tool_family",
		"discover_app_methods",
		"mcp_search_tools",
		"mcp_describe_tool",
		"list_memory_tags",
		"save_memory",
		"connect_app",
		"search_mcp_directory",
		"request_access_lease",
		"finish_turn",
	].includes(toolName)
}

export function createBrainTurnTelemetry(
	orgId: string,
	userId: string,
	input?: BrainObservabilityInput,
	mainModel: SupportedModel = BRAIN_MODEL,
) {
	const distinctId = input?.distinctId ?? userId
	const traceId = input?.traceId ?? generateId()
	const turnSpanId = generateId()
	const groups = { company: orgId }
	const baseProps: Record<string, unknown> = {
		app: "api",
		feature: "company_brain",
		orgId,
		source: input?.source ?? "api",
	}
	if (input?.channel) baseProps.slack_channel = input.channel
	if (input?.messageTs) baseProps.slack_message_ts = input.messageTs
	if (input?.threadTs) baseProps.slack_thread_ts = input.threadTs
	const threadRef = slackThreadRef(input?.channel, input?.threadTs)
	if (threadRef) baseProps.slack_thread = threadRef
	baseProps.brain_trace_id = traceId
	if (input?.triageResult) baseProps.triage_result = input.triageResult
	if (input?.automationId) baseProps.automation_id = input.automationId
	if (input?.automationTitle) baseProps.automation_title = input.automationTitle
	if (input?.automationCadence)
		baseProps.automation_cadence = input.automationCadence
	if (input?.deliverTo) baseProps.deliver_to = input.deliverTo
	if (input?.runTrigger) baseProps.run_trigger = input.runTrigger

	let generationStartTime: number | null = null
	let capturedStepCount = 0
	let turnFinished = false
	const toolStarts = new Map<string, number>()
	const calledToolNames = new Set<string>()
	let toolCallCount = 0
	const toolErrorsByKind = new Map<ToolErrorKind, number>()
	const harnessRejections = new Map<
		"duplicate_call" | "budget_exhausted" | "policy_denied",
		number
	>()
	const latencyByPhase = new Map<
		"connect" | "discover" | "sandbox" | "model",
		number
	>()
	let cacheHitTokens = 0
	let salvaged = false
	let replySource: TurnReplySource | undefined
	let terminalProposalCount = 0
	let terminalOutcome: TurnTerminalOutcome | undefined
	let terminalDuplicateCall = false
	let approvalCount = 0
	let cannedAnswer = false
	let stepsToFirstEvidence: number | undefined
	let promptProperties: Record<string, unknown> = {}

	return {
		traceId,
		turnSpanId,
		groups,
		sessionId: input?.sessionId,

		markGenerationStart(args: {
			input: unknown
			toolNames: string[]
			promptStats?: PromptStats
		}) {
			generationStartTime = Date.now()
			if (args.promptStats) {
				promptProperties = {
					prompt_system_chars: args.promptStats.systemChars,
					prompt_runtime_chars: args.promptStats.runtimeChars,
					prompt_thread_chars: args.promptStats.threadChars,
					prompt_thread_messages: args.promptStats.threadMessages,
					prompt_request_chars: args.promptStats.requestChars,
					prompt_context_mode: args.promptStats.contextMode,
					hidden_tool_count: args.promptStats.hiddenToolCount,
					lazy_tool_families:
						args.promptStats.lazyToolFamilies.join(",") || "none",
					prompt_message_count: Array.isArray(args.input)
						? args.input.length
						: undefined,
					available_tool_count: args.toolNames.length,
				}
			}
			captureAiSpan({
				distinctId,
				traceId,
				sessionId: input?.sessionId,
				spanId: turnSpanId,
				parentId: traceId,
				spanName: "company_brain_turn",
				inputState: promptProperties,
				outputState: { tools: args.toolNames },
				latencySeconds: 0,
				groups,
				properties: {
					...baseProps,
					...promptProperties,
					turn_status: "started",
				},
			})
		},

		onToolCallStart(toolCallId: string) {
			toolCallCount++
			toolStarts.set(toolCallId, Date.now())
		},

		recordToolError(kind: ToolErrorKind) {
			toolErrorsByKind.set(kind, (toolErrorsByKind.get(kind) ?? 0) + 1)
		},

		recordHarnessRejection(
			kind: "duplicate_call" | "budget_exhausted" | "policy_denied",
		) {
			harnessRejections.set(kind, (harnessRejections.get(kind) ?? 0) + 1)
		},

		recordCacheHitTokens(tokens: number | undefined) {
			if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
				cacheHitTokens += tokens
			}
		},

		recordSalvaged() {
			salvaged = true
		},

		recordReplySource(source: TurnReplySource) {
			replySource = source
		},

		recordTerminalProposal(
			outcome: TurnTerminalOutcome,
			duplicateInAttempt = false,
		) {
			terminalProposalCount += 1
			terminalOutcome = outcome
			terminalDuplicateCall ||= duplicateInAttempt
		},

		recordApproval(count = 1) {
			approvalCount += Math.max(0, count)
		},

		recordCannedAnswer() {
			cannedAnswer = true
		},

		recordPhaseLatency(
			phase: "connect" | "discover" | "sandbox" | "model",
			latencyMs: number,
		) {
			if (!Number.isFinite(latencyMs) || latencyMs < 0) return
			latencyByPhase.set(phase, (latencyByPhase.get(phase) ?? 0) + latencyMs)
		},

		onToolCallFinish(args: {
			toolCallId: string
			toolName: string
			success: boolean
			input?: unknown
			output?: unknown
		}) {
			const startedAt = toolStarts.get(args.toolCallId)
			const latencyMs = startedAt ? Date.now() - startedAt : undefined
			const phase = toolLatencyPhase(args.toolName)
			if (phase && latencyMs !== undefined) {
				latencyByPhase.set(phase, (latencyByPhase.get(phase) ?? 0) + latencyMs)
			}
			const observedKinds = toolErrorKindsFromOutput(args.output)
			if (
				stepsToFirstEvidence === undefined &&
				args.success &&
				observedKinds.length === 0 &&
				toolProducesEvidence(args.toolName)
			) {
				stepsToFirstEvidence = capturedStepCount + 1
			}
			for (const kind of observedKinds) {
				toolErrorsByKind.set(kind, (toolErrorsByKind.get(kind) ?? 0) + 1)
				if (
					kind === "duplicate_call" ||
					kind === "budget_exhausted" ||
					kind === "policy_denied"
				) {
					harnessRejections.set(kind, (harnessRejections.get(kind) ?? 0) + 1)
				}
			}
			calledToolNames.add(args.toolName)
			captureAiSpan({
				distinctId,
				traceId,
				sessionId: input?.sessionId,
				spanId: args.toolCallId,
				parentId: turnSpanId,
				spanName: args.toolName,
				inputState: args.input,
				outputState:
					args.output === undefined
						? { success: args.success }
						: { success: args.success, output: args.output },
				latencySeconds: latencyMs !== undefined ? latencyMs / 1000 : undefined,
				isError: !args.success || observedKinds.length > 0,
				groups,
				properties: {
					...baseProps,
					...(observedKinds[0] ? { tool_error_kind: observedKinds[0] } : {}),
				},
			})
		},

		captureStepGeneration(args: {
			attempt: string
			stepNumber: number
			input: unknown
			outputChoices: unknown[]
			inputTokens?: number
			outputTokens?: number
			toolNames: string[]
			latencyMs?: number
			isError?: boolean
			error?: string
		}) {
			capturedStepCount++
			if (typeof args.latencyMs === "number" && args.latencyMs >= 0) {
				latencyByPhase.set(
					"model",
					(latencyByPhase.get("model") ?? 0) + args.latencyMs,
				)
			}
			const modelInfo = getModelInfo(mainModel)
			const generationProperties = {
				...baseProps,
				...promptProperties,
				turn_status: "model_step",
				brain_attempt: args.attempt,
				brain_step_number: args.stepNumber,
				$ai_tools_called: [...calledToolNames].join(","),
				brain_available_tools: args.toolNames.join(","),
			}
			captureAiGeneration({
				distinctId,
				traceId,
				sessionId: input?.sessionId,
				spanId: generateId(),
				parentId: turnSpanId,
				spanName: `company_brain_${args.attempt}_step_${args.stepNumber}`,
				model: modelInfo.modelId,
				provider: modelInfo.provider,
				input: args.input,
				outputChoices: args.outputChoices,
				inputTokens: args.inputTokens,
				outputTokens: args.outputTokens,
				latencySeconds:
					typeof args.latencyMs === "number" ? args.latencyMs / 1000 : 0,
				tools: args.toolNames.map((name) => ({
					type: "function" as const,
					function: { name },
				})),
				isError: args.isError,
				error: args.error,
				groups,
				properties: generationProperties,
			})
		},

		finishTurn(args: {
			outputChoices: unknown[]
			turnStatus: string
			inputTokens?: number
			outputTokens?: number
			isError?: boolean
			error?: string
			failurePhase?: string
			failureCode?: string
			turnState?: TurnState
		}) {
			if (turnFinished) return
			turnFinished = true
			const latencySeconds =
				generationStartTime != null
					? (Date.now() - generationStartTime) / 1000
					: 0
			const turnProperties = {
				...baseProps,
				...promptProperties,
				turn_status: args.turnStatus,
				brain_model_step_count: capturedStepCount,
				$ai_tools_called: [...calledToolNames].join(","),
				total_input_tokens: args.inputTokens,
				total_output_tokens: args.outputTokens,
				steps_used: capturedStepCount,
				native_calls: args.turnState?.budget.nativeCalls.used ?? 0,
				tool_call_count: toolCallCount,
				steps_to_first_evidence: stepsToFirstEvidence,
				tool_errors_by_kind: Object.fromEntries(toolErrorsByKind),
				harness_rejections: [...harnessRejections.values()].reduce(
					(total, count) => total + count,
					0,
				),
				harness_rejections_by_kind: Object.fromEntries(harnessRejections),
				harness_rejection_rate:
					toolCallCount > 0
						? [...harnessRejections.values()].reduce(
								(total, count) => total + count,
								0,
							) / toolCallCount
						: 0,
				duplicate_call_rate:
					toolCallCount > 0
						? (harnessRejections.get("duplicate_call") ?? 0) / toolCallCount
						: 0,
				cache_hit_tokens: cacheHitTokens,
				cache_hit_ratio:
					(args.inputTokens ?? 0) > 0
						? cacheHitTokens / (args.inputTokens ?? 1)
						: 0,
				salvaged,
				reply_source: replySource,
				answer_checker_mode: "posthog_shadow",
				answer_checker_enforced: false,
				terminal_protocol_used: terminalProposalCount > 0,
				terminal_outcome: terminalOutcome,
				terminal_proposal_count: terminalProposalCount,
				terminal_multiple_calls: terminalDuplicateCall,
				canned_answer: cannedAnswer,
				approval_count: approvalCount,
				latency_by_phase: Object.fromEntries(latencyByPhase),
				...(args.failurePhase ? { failure_phase: args.failurePhase } : {}),
				...(args.failureCode ? { failure_code: args.failureCode } : {}),
			}
			captureAiTrace({
				distinctId,
				traceId,
				sessionId: input?.sessionId,
				traceName: "company_brain_turn",
				inputState: promptProperties,
				outputState: args.outputChoices,
				latencySeconds,
				isError: args.isError,
				error: args.error,
				groups,
				properties: turnProperties,
			})
		},
	}
}

export async function flushBrainTelemetry(): Promise<void> {
	await flushTelemetry()
}

function boundedTriageTraceText(value: string, maxChars = 4_000): string {
	return Array.from(value).slice(0, maxChars).join("")
}

export async function captureBrainTriageGeneration(args: {
	orgId: string
	distinctId: string
	traceId: string
	sessionId?: string
	channel?: string
	messageTs?: string
	threadTs?: string
	system: string
	prompt: string
	rawOutput?: string
	result: TriageResult
	contextChars: number
	chimeContext?: "thread" | "channel"
	latencyMs: number
	isError?: boolean
	error?: TriageGenerationError
	providerError?: TriageProviderError
	model?: SupportedModel
	traceSampleRate?: number
}): Promise<void> {
	const modelInfo = getModelInfo(args.model ?? TRIAGE_MODEL)
	const threadRef = slackThreadRef(args.channel, args.threadTs)
	const source =
		args.chimeContext === "channel"
			? "slack_chime_channel"
			: args.chimeContext === "thread"
				? "slack_chime_thread"
				: "slack_turn"
	await captureAiGenerationAwaitable({
		distinctId: args.distinctId,
		traceId: args.traceId,
		sessionId: args.sessionId,
		spanId: generateId(),
		parentId: args.traceId,
		spanName: "company_brain_triage",
		model: modelInfo.modelId,
		provider: modelInfo.provider,
		input: [
			{ role: "system", content: boundedTriageTraceText(args.system) },
			{ role: "user", content: boundedTriageTraceText(args.prompt) },
		],
		outputChoices:
			args.rawOutput !== undefined
				? [{ role: "assistant", content: args.rawOutput }]
				: [],
		latencySeconds: args.latencyMs / 1000,
		isError: args.isError,
		error: args.error,
		groups: { company: args.orgId },
		properties: {
			app: "api",
			feature: "company_brain",
			orgId: args.orgId,
			source,
			triage_result: args.result.decision,
			triage_decision_source: args.result.source,
			...("priority" in args.result
				? { triage_priority: args.result.priority }
				: {}),
			...("priorityNormalized" in args.result &&
			args.result.priorityNormalized === true
				? { priority_normalized: true }
				: {}),
			...("reason" in args.result ? { triage_reason: args.result.reason } : {}),
			...(args.result.decision === "ack"
				? { triage_emoji: args.result.emoji }
				: {}),
			...(args.result.decision === "answer" && args.result.fallbackEmoji
				? { triage_fallback_emoji: args.result.fallbackEmoji }
				: {}),
			triage_context_chars: args.contextChars,
			contains_channel_content: true,
			...(args.traceSampleRate !== undefined
				? { triage_trace_sample_rate: args.traceSampleRate }
				: {}),
			brain_trace_id: args.traceId,
			...(args.chimeContext ? { chime_context: args.chimeContext } : {}),
			...(args.channel ? { slack_channel: args.channel } : {}),
			...(args.messageTs ? { slack_message_ts: args.messageTs } : {}),
			...(args.threadTs ? { slack_thread_ts: args.threadTs } : {}),
			...(threadRef ? { slack_thread: threadRef } : {}),
			...(args.providerError?.name
				? { triage_error_name: args.providerError.name }
				: {}),
			...(args.providerError?.statusCode !== undefined
				? { triage_error_status_code: args.providerError.statusCode }
				: {}),
		},
	})
}

export async function captureBrainTriageOutcome(args: {
	orgId: string
	distinctId: string
	traceId: string
	sessionId?: string
	channel?: string
	messageTs?: string
	threadTs?: string
	chimeContext: ChimeContext
	outcome: TriageOutcome
}): Promise<void> {
	const threadRef = slackThreadRef(args.channel, args.threadTs)
	await captureAiSpanAwaitable({
		distinctId: args.distinctId,
		traceId: args.traceId,
		sessionId: args.sessionId,
		spanId: generateId(),
		parentId: args.traceId,
		spanName: "company_brain_triage_outcome",
		inputState: {
			decision: args.outcome.decision,
			reason: args.outcome.reason,
		},
		outputState: args.outcome,
		groups: { company: args.orgId },
		properties: {
			app: "api",
			feature: "company_brain",
			orgId: args.orgId,
			source:
				args.chimeContext === "channel"
					? "slack_chime_channel"
					: "slack_chime_thread",
			triage_result: args.outcome.decision,
			triage_reason: args.outcome.reason,
			chime_context: args.chimeContext,
			brain_trace_id: args.traceId,
			...(args.outcome.decision === "ack"
				? {
						triage_emoji: args.outcome.emoji,
						ack_outcome: args.outcome.outcome,
						...(args.outcome.error ? { ack_error: args.outcome.error } : {}),
					}
				: {
						investigate_outcome: args.outcome.outcome,
						...(args.outcome.deliverySucceeded !== undefined
							? {
									investigate_delivery_succeeded:
										args.outcome.deliverySucceeded,
								}
							: {}),
						...(args.outcome.terminalReason
							? {
									investigate_terminal_reason: args.outcome.terminalReason,
								}
							: {}),
					}),
			...(args.channel ? { slack_channel: args.channel } : {}),
			...(args.messageTs ? { slack_message_ts: args.messageTs } : {}),
			...(args.threadTs ? { slack_thread_ts: args.threadTs } : {}),
			...(threadRef ? { slack_thread: threadRef } : {}),
		},
	})
}

export async function captureBrainProactivitySuppression(args: {
	orgId: string
	distinctId: string
	traceId: string
	sessionId?: string
	channel?: string
	messageTs?: string
	threadTs?: string
	chimeContext?: ChimeContext
	reason: string
	priority?: string
	decision?: string
	fallbackUsed?: boolean
}): Promise<void> {
	const threadRef = slackThreadRef(args.channel, args.threadTs)
	await captureAiSpanAwaitable({
		distinctId: args.distinctId,
		traceId: args.traceId,
		sessionId: args.sessionId,
		spanId: generateId(),
		parentId: args.traceId,
		spanName: "company_brain_proactivity_suppression",
		inputState: {
			decision: args.decision,
			priority: args.priority,
		},
		outputState: {
			reason: args.reason,
			fallbackUsed: args.fallbackUsed === true,
		},
		groups: { company: args.orgId },
		properties: {
			app: "api",
			feature: "company_brain",
			orgId: args.orgId,
			source:
				args.chimeContext === "thread"
					? "slack_chime_thread"
					: "slack_chime_channel",
			proactivity_suppression: args.reason,
			...(args.decision ? { triage_result: args.decision } : {}),
			...(args.priority ? { triage_priority: args.priority } : {}),
			fallback_used: args.fallbackUsed === true,
			brain_trace_id: args.traceId,
			...(args.channel ? { slack_channel: args.channel } : {}),
			...(args.messageTs ? { slack_message_ts: args.messageTs } : {}),
			...(args.threadTs ? { slack_thread_ts: args.threadTs } : {}),
			...(threadRef ? { slack_thread: threadRef } : {}),
		},
	})
}

export function captureBrainActiveTurnGateGeneration(args: {
	orgId: string
	distinctId: string
	traceId: string
	sessionId?: string
	channel?: string
	messageTs?: string
	threadTs?: string
	system: string
	prompt: string
	rawOutput: string
	outcome: string
	authorOwnsTurn: boolean
	revision: number
	latencyMs: number
	isError?: boolean
}) {
	const modelInfo = getModelInfo(TRIAGE_MODEL)
	const threadRef = slackThreadRef(args.channel, args.threadTs)
	captureAiGeneration({
		distinctId: args.distinctId,
		traceId: args.traceId,
		sessionId: args.sessionId,
		spanId: generateId(),
		parentId: args.traceId,
		spanName: "company_brain_active_turn_gate",
		model: modelInfo.modelId,
		provider: modelInfo.provider,
		input: [
			{ role: "system", content: args.system },
			{ role: "user", content: args.prompt },
		],
		outputChoices: [{ role: "assistant", content: args.rawOutput }],
		latencySeconds: args.latencyMs / 1000,
		isError: args.isError,
		groups: { company: args.orgId },
		properties: {
			app: "api",
			feature: "company_brain",
			orgId: args.orgId,
			source: "slack_active_turn_gate",
			active_turn_gate_outcome: args.outcome,
			active_turn_author_owns_turn: args.authorOwnsTurn,
			active_turn_revision: args.revision,
			active_turn_update_applied: false,
			brain_trace_id: args.traceId,
			...(args.channel ? { slack_channel: args.channel } : {}),
			...(args.messageTs ? { slack_message_ts: args.messageTs } : {}),
			...(args.threadTs ? { slack_thread_ts: args.threadTs } : {}),
			...(threadRef ? { slack_thread: threadRef } : {}),
		},
	})
}

export function captureBrainTurnUpdateApplied(args: {
	orgId: string
	distinctId: string
	traceId: string
	sessionId?: string
	messageTs: string
	authorUser: string
	authorName?: string | null
	outcome: string
	revision: number
}) {
	captureAiSpan({
		distinctId: args.distinctId,
		traceId: args.traceId,
		sessionId: args.sessionId,
		spanId: generateId(),
		parentId: args.traceId,
		spanName: "company_brain_live_thread_update",
		inputState: {
			messageTs: args.messageTs,
			authorUser: args.authorUser,
			authorName: args.authorName,
			outcome: args.outcome,
		},
		outputState: { applied: true, revision: args.revision },
		groups: { company: args.orgId },
		properties: {
			app: "api",
			feature: "company_brain",
			orgId: args.orgId,
			source: "slack_turn",
			active_turn_gate_outcome: args.outcome,
			active_turn_revision: args.revision,
			active_turn_update_applied: true,
			slack_message_ts: args.messageTs,
			brain_trace_id: args.traceId,
		},
	})
}
