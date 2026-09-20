import type { ModelMessage } from "ai"
import {
	BrainCostLedger,
	recordFinishEvent,
	scheduleChargeBrainLlmCost,
} from "../billing/cost"
import { memoryDocsFromWriteback } from "../memory/writeback"
import {
	captureBrainTurnUpdateApplied,
	createBrainTurnTelemetry,
} from "../observability"
import {
	type BrainToolCallEvent,
	getToolFinishOutput,
	logToolInput,
	redactedPreview,
} from "../observability/log-utils"
import { mapToolDetail, mapToolLabel } from "../prompt/build"
import { claimThreadTurnApprovalIfInboxEmpty } from "../slack/turn-control"
import {
	consumePendingTurnUpdates,
	formatTurnUpdates,
	waitForTurnUpdateClassification,
} from "../slack/turn-inbox"
import { replaceConnectedAppToolResult } from "../tools/mcp/pause"
import { brainAgent } from "./agent"
import {
	batchApproval,
	buildApprovalResponseMessage,
	enrichApprovalRequestFromMessages,
	findApprovalRequests,
} from "./approval-requests"
import { reportLegacyStructuredReply, type TurnCapture } from "./capture-tools"
import { cardOutputPayload } from "./card-content"
import {
	applySystemCacheBreakpoints,
	compactMessagesAtBoundary,
} from "./context"
import { getTurnDeps } from "./deps"
import {
	selectTurnReply,
	settleTurn,
	type TurnFinalizationAdapter,
} from "./finalization"
import { runModelLoop, type TurnAttempt } from "./loop"
import { resolveBrainMainProfile } from "./model-profile"
import { shouldShowToolProgressCard } from "./progress"
import {
	createTurnState,
	recordConnectedAppTrajectory,
	restoreTurnState,
	type TurnState,
	touchTurnState,
} from "./state"
import {
	createTurnTerminalCapture,
	FINISH_TURN_TOOL_NAME,
	type TurnTerminalCapture,
} from "./terminal"
import {
	buildThreadInvestigationCheckpoint,
	investigationPrincipalKey,
	saveThreadInvestigation,
} from "./thread-investigation"
import {
	assembleTurnTools,
	restoreTurnToolAssembly,
	snapshotTurnToolAssembly,
	type TurnToolAssemblySnapshot,
} from "./tools"
import type {
	ComputeTurnResult,
	ResumeTurnAfterApprovalInput,
	TurnToolTraceEntry,
} from "./types"
import {
	safeStringify,
	throwIfAborted,
	turnFailureCode,
	turnFailureTerminal,
} from "./util"

type ResumeTurnFailurePhase =
	| "tool_assembly"
	| "approval_resolution"
	| "approval_handshake"
	| "model_generation"
	| "output_read"
	| "turn_finalization"
	| "completion"

type ResumeTurnAttempt = Extract<TurnAttempt, "approval_resume" | "live_update">

function legacyAssemblySnapshot(
	input: ResumeTurnAfterApprovalInput,
): TurnToolAssemblySnapshot {
	return {
		slackLookup: input.slackBotToken
			? {
					channel: input.approval.channel,
					threadTs: input.approval.threadTs,
					teamId: input.approval.teamId,
					memoryScope: input.approval.state.memoryScope,
				}
			: undefined,
		askerSlackUserId: input.approval.askerUser,
		enabledFamilies: [],
	}
}

function restoredState(
	input: ResumeTurnAfterApprovalInput,
	connectedApps: TurnState["apps"]["connected"] = [],
): TurnState {
	if (input.approval.state.turnState) {
		return restoreTurnState(input.approval.state.turnState)
	}
	return createTurnState({
		request: {
			text: input.approval.state.question ?? "",
			askerSlackId: input.approval.askerUser,
			threadKey: `${input.approval.teamId}:${input.approval.channel}:${input.approval.threadTs}`,
		},
		connectedApps,
	})
}

export async function resumeTurnAfterApproval(
	input: ResumeTurnAfterApprovalInput,
): Promise<ComputeTurnResult> {
	const {
		agent,
		org,
		approval,
		approved,
		progress,
		obs,
		abortSignal,
		onTerminalProposal,
		slackBotToken,
	} = input
	const deps = await getTurnDeps()
	const env = brainAgent(agent).env
	const profile = resolveBrainMainProfile(org.metadata)
	throwIfAborted(abortSignal)
	const capture: TurnCapture = {
		memory: approval.state.memory ?? null,
		connect: null,
	}
	const telemetry = createBrainTurnTelemetry(
		org.id,
		approval.state.userId,
		{
			distinctId: approval.state.actor.userId ?? approval.state.userId,
			source: "slack_approval",
			sessionId: obs?.sessionId ?? `${approval.channel}:${approval.threadTs}`,
			channel: obs?.channel ?? approval.channel,
			threadTs: obs?.threadTs ?? approval.threadTs,
			...obs,
		},
		profile.name,
	)
	const traceId = telemetry.traceId
	const costLedger = new BrainCostLedger()
	let chargedOps = 0
	let chargeChain: Promise<void> = Promise.resolve()
	// Serialized so the abort and terminal charges bill one cumulative total.
	const charge = (): Promise<void> => {
		chargeChain = chargeChain.then(async () => {
			chargedOps += await scheduleChargeBrainLlmCost({
				orgId: org.id,
				ledger: costLedger,
				source: "resume_turn",
				traceId,
				env,
				chargedOps,
			})
		})
		return chargeChain
	}
	// The caller abandons this at the deadline; the finally may never run.
	abortSignal?.addEventListener(
		"abort",
		() => {
			brainAgent(agent).waitUntil(charge())
		},
		{ once: true },
	)
	const assemblySnapshot =
		approval.state.assembly ?? legacyAssemblySnapshot(input)
	const restoredAssembly = restoreTurnToolAssembly(
		assemblySnapshot,
		slackBotToken,
	)
	const state = restoredState(input)
	state.pendingApproval = undefined
	touchTurnState(state)
	let totalInputTokens = 0
	let totalOutputTokens = 0
	let lastProviderOutputChoices: unknown[] = []
	let failurePhase: ResumeTurnFailurePhase = "tool_assembly"
	const finishFailedTurn = (error: unknown): void => {
		const terminal = turnFailureTerminal(abortSignal)
		telemetry.finishTurn({
			outputChoices: lastProviderOutputChoices,
			turnStatus: terminal.turnStatus,
			inputTokens: totalInputTokens || undefined,
			outputTokens: totalOutputTokens || undefined,
			isError: true,
			error: terminal.error,
			failurePhase,
			failureCode: turnFailureCode(error, abortSignal),
			turnState: state,
		})
	}
	console.log(
		`[company-brain][${traceId}] resume approval=${approval.approvalId} approved=${approved} org=${org.id} model=${profile.name} effort=${profile.effort} tool=${approval.toolName} slug=${approval.slug ?? "-"}`,
	)

	const assemblyArgs = {
		deps,
		env,
		agent,
		org,
		userId: approval.state.userId,
		actor: approval.state.actor,
		...restoredAssembly,
		options: {
			abortSignal,
			turnControl: approval.state.turnControl,
		},
		progress,
		traceId,
		capture,
		turnState: state,
		onPhaseLatency: telemetry.recordPhaseLatency,
		costLedger,
	} satisfies Parameters<typeof assembleTurnTools>[0]
	const assembled = await assembleTurnTools(assemblyArgs).catch((error) => {
		finishFailedTurn(error)
		throw error
	})
	if (!assembled.ready) return assembled.result
	const {
		tools,
		hasApps,
		toolDiscovery,
		connectedApps,
		connectedAppRuntime,
		connectedAppRouting,
	} = assembled
	if (!state.apps.connected.length && connectedApps.length) {
		state.apps.connected = connectedApps.map((app) => ({ ...app }))
		touchTurnState(state)
	}

	try {
		failurePhase = "approval_resolution"
		const toolTrace: TurnToolTraceEntry[] = []
		let salvaged = false
		const canRequestAccessLease = "request_access_lease" in tools
		const hasAppAccessTools = hasApps || canRequestAccessLease
		const detailedAppPolicy = hasAppAccessTools
		const activeSystem = deps.buildSystemPrompt({
			toolMode: hasAppAccessTools ? "apps" : "memory_only",
			appPolicy: detailedAppPolicy ? "detailed" : "compact",
			hasSandbox: toolDiscovery.availableFamilies().includes("sandbox"),
			canRequestAccessLease,
			connectedAppRouting,
			explicitFinish: true,
		})
		const buildActiveSystem = () => activeSystem
		const buildCurrentSystemMessages = () =>
			applySystemCacheBreakpoints(
				deps.buildSystemPromptMessages(
					buildActiveSystem(),
					approval.state.botIdentity,
				),
				profile,
			)
		const showProgressCard = async (
			toolCallId: string,
			toolName: string,
			toolCall?: unknown,
		): Promise<void> => {
			if (!shouldShowToolProgressCard(toolName)) return
			await progress?.card(
				toolCallId,
				mapToolLabel(toolName, toolCall),
				"in_progress",
				{ detail: mapToolDetail(toolName, toolCall) },
			)
		}
		let currentRunLiveUpdateMessages: ModelMessage[] = []
		const terminalCaptures = new WeakMap<object, TurnTerminalCapture>()
		const consumeLiveUpdateMessages = (): ModelMessage[] => {
			const control = approval.state.turnControl
			if (!control) return []
			const updates = consumePendingTurnUpdates(agent, control)
			if (!updates.length) return []
			for (const update of updates) {
				captureBrainTurnUpdateApplied({
					orgId: org.id,
					distinctId: obs?.distinctId ?? approval.state.userId,
					traceId,
					sessionId: obs?.sessionId,
					messageTs: update.message_ts,
					authorUser: update.author_user,
					authorName: update.author_name,
					outcome: update.outcome,
					revision: update.revision,
				})
			}
			console.log(
				`[company-brain][${traceId}] applied approval-resume live updates count=${updates.length} messages=${updates.map((update) => update.message_ts).join(",")}`,
			)
			return [{ role: "user", content: formatTurnUpdates(updates) }]
		}
		const claimApprovalWithoutPendingUpdates = async (): Promise<boolean> => {
			const control = approval.state.turnControl
			if (!control) return true
			failurePhase = "approval_handshake"
			let claimed = claimThreadTurnApprovalIfInboxEmpty(agent, control)
			if (!claimed) {
				await waitForTurnUpdateClassification(agent, control, abortSignal)
				claimed = claimThreadTurnApprovalIfInboxEmpty(agent, control)
			}
			return claimed
		}
		let messages: ModelMessage[]
		if (approval.state.connectedAppPause) {
			const resolved = connectedAppRuntime
				? await connectedAppRuntime.resolveApproval(
						approval.state.connectedAppPause,
						approved,
					)
				: {
						output: {
							status: "error" as const,
							kind: "unavailable" as const,
							tool: "run_app_code",
							message:
								"Code Mode is unavailable, so the paused connected-app action did not run.",
							suggestion:
								"Reconnect the app or retry the request after Code Mode is available.",
							retryable: false,
							logs: "",
							calls: [],
						},
					}
			recordConnectedAppTrajectory(state, {
				tool: "run_app_code",
				input: {
					executionId: approval.state.connectedAppPause.executionId,
					approved,
				},
				output: resolved.output,
			})
			messages = replaceConnectedAppToolResult(
				approval.state.messages,
				approval.state.connectedAppPause.outerToolCallId,
				resolved.output,
			)
			if (resolved.pending) {
				const pending = resolved.pending
				if (await claimApprovalWithoutPendingUpdates()) {
					telemetry.recordApproval(1)
					telemetry.finishTurn({
						outputChoices: [],
						turnStatus: "waiting_approval",
						turnState: state,
					})
					return {
						status: "suspended",
						approval: pending.request,
						state: {
							...approval.state,
							memory: capture.memory,
							messages: compactMessagesAtBoundary(messages, {
								activeDiscoveryApps: Object.keys(state.apps.discovered),
							}),
							approvalIds: [pending.request.approvalId],
							connectedAppPause: pending.ref,
							turnState: restoreTurnState(state),
							assembly: snapshotTurnToolAssembly(
								assemblyArgs,
								toolDiscovery.enabledFamilies(),
							),
							detailedAppPolicy: true,
						},
					}
				}
				const pendingMessages = consumeLiveUpdateMessages()
				if (!pendingMessages.length) {
					throwIfAborted(abortSignal)
					throw new Error(
						"connected-app approval claim failed without a pending update",
					)
				}
				messages = [...messages, ...pendingMessages]
				capture.memory = null
				capture.connect = null
			}
		} else {
			const idsToAnswer = approval.state.approvalIds?.length
				? approval.state.approvalIds
				: [approval.approvalId]
			messages = [
				...approval.state.messages,
				buildApprovalResponseMessage(idsToAnswer, approved),
			]
		}
		telemetry.markGenerationStart({
			input: [...buildCurrentSystemMessages(), ...messages],
			toolNames: toolDiscovery.activeToolNames(Object.keys(tools)),
		})

		function runResumeModel(
			sourceMessages: ModelMessage[],
			attempt: ResumeTurnAttempt,
		) {
			onTerminalProposal?.(null)
			failurePhase = "model_generation"
			const stepSnapshots = new Map<
				number,
				{ input: unknown; toolNames: string[]; startedAt: number }
			>()
			const terminalCapture = createTurnTerminalCapture({
				onProposal: onTerminalProposal,
			})
			const result = runModelLoop({
				deps,
				env,
				profile,
				system: buildCurrentSystemMessages,
				messages: sourceMessages,
				tools,
				activeTools: () => toolDiscovery.activeToolNames(Object.keys(tools)),
				alwaysActiveTools: [FINISH_TURN_TOOL_NAME],
				state,
				attempt,
				suspendRequested: () =>
					Boolean(
						connectedAppRuntime?.pendingApproval() ||
							terminalCapture.requested(),
					),
				abortSignal,
				prepareMessages: (stepMessages) => {
					currentRunLiveUpdateMessages.push(...consumeLiveUpdateMessages())
					return [...stepMessages, ...currentRunLiveUpdateMessages]
				},
				functionId:
					attempt === "approval_resume"
						? "company-brain-approval-resume"
						: "company-brain-approval-live-update",
				onPreparedStep: (snapshot) => {
					stepSnapshots.set(snapshot.stepNumber, snapshot)
				},
				onStepFinish: async (event) => {
					const snapshot = stepSnapshots.get(event.stepNumber)
					const outputChoices =
						event.response?.messages
							?.filter((message) => message.role === "assistant")
							.map((message) => ({
								role: "assistant",
								content: message.content,
							})) ?? []
					telemetry.captureStepGeneration({
						attempt,
						stepNumber: event.stepNumber,
						input: event.request?.body ?? snapshot?.input ?? sourceMessages,
						outputChoices,
						inputTokens: event.usage?.inputTokens,
						outputTokens: event.usage?.outputTokens,
						toolNames:
							snapshot?.toolNames ??
							toolDiscovery.activeToolNames(Object.keys(tools)),
						latencyMs: snapshot ? Date.now() - snapshot.startedAt : undefined,
					})
				},
				onFinish: async (event) => {
					const usage = event.totalUsage ?? event.usage
					telemetry.recordCacheHitTokens(
						usage?.inputTokenDetails?.cacheReadTokens,
					)
					totalInputTokens += usage?.inputTokens ?? 0
					totalOutputTokens += usage?.outputTokens ?? 0
					recordFinishEvent(costLedger, event, profile.name)
					lastProviderOutputChoices =
						event.response?.messages
							?.filter((message) => message.role === "assistant")
							.map((message) => ({
								role: "assistant",
								content: message.content,
							})) ?? []
				},
				onError: ({ error }) => {
					console.warn(
						`[company-brain][${traceId}] streamText ${attempt} error:`,
						error,
					)
				},
				onToolCallStart: async (event: BrainToolCallEvent) => {
					const terminalProposal = terminalCapture.record(event.toolCall)
					if (terminalProposal) {
						telemetry.recordTerminalProposal(
							terminalProposal.outcome,
							terminalCapture.count() > 1,
						)
						console.log(
							`[company-brain][${traceId}] terminal proposal after approval outcome=${terminalProposal.outcome} replyChars=${terminalProposal.reply.length}`,
						)
						return
					}
					telemetry.onToolCallStart(event.toolCall.toolCallId)
					console.log(
						`[company-brain][${traceId}] tool start id=${event.toolCall.toolCallId} name=${event.toolCall.toolName} input=${logToolInput(event.toolCall)}`,
					)
					await showProgressCard(
						event.toolCall.toolCallId,
						event.toolCall.toolName,
						event.toolCall,
					)
				},
				onToolCallFinish: async (event: BrainToolCallEvent) => {
					if (event.toolCall.toolName === FINISH_TURN_TOOL_NAME) return
					const output = getToolFinishOutput(event)
					recordConnectedAppTrajectory(state, {
						tool: event.toolCall.toolName,
						input: event.toolCall.input,
						output,
						status: event.success ? "ok" : "error",
					})
					telemetry.onToolCallFinish({
						toolCallId: event.toolCall.toolCallId,
						toolName: event.toolCall.toolName,
						success: event.success ?? false,
						input: event.toolCall.input,
						output,
					})
					console.log(
						`[company-brain][${traceId}] tool finish id=${event.toolCall.toolCallId} name=${event.toolCall.toolName} success=${event.success} output=${output === undefined ? "unavailable" : redactedPreview(output, event.success ? 4000 : 8000)}`,
					)
					if (event.success) {
						toolTrace.push({
							tool: event.toolCall.toolName,
							input: event.toolCall.input,
							output:
								typeof output === "string"
									? output.slice(0, 2000)
									: output === undefined
										? undefined
										: safeStringify(output).slice(0, 2000),
						})
					}
					if (shouldShowToolProgressCard(event.toolCall.toolName)) {
						await progress?.card(
							event.toolCall.toolCallId,
							mapToolLabel(event.toolCall.toolName, event.toolCall),
							event.success ? "complete" : "error",
							event.success
								? cardOutputPayload(event.toolCall.toolName, output)
								: undefined,
						)
					}
				},
			})
			terminalCaptures.set(result, terminalCapture)
			return result
		}
		async function readOutput(
			modelResult: ReturnType<typeof runResumeModel>,
		): Promise<{ reply: string }> {
			failurePhase = "output_read"
			throwIfAborted(abortSignal)
			const selected = await selectTurnReply({
				result: modelResult,
				terminalProposal: terminalCaptures.get(modelResult)?.selected(),
			})
			throwIfAborted(abortSignal)
			telemetry.recordReplySource(selected.source)
			reportLegacyStructuredReply(selected.reply, traceId)
			if (selected.source === "response") {
				salvaged = true
				telemetry.recordSalvaged()
			}
			return { reply: selected.reply }
		}

		const compactContinuation = (messages: ModelMessage[]): ModelMessage[] =>
			compactMessagesAtBoundary(messages, {
				activeDiscoveryApps: Object.keys(state.apps.discovered),
			})

		let sourceMessages = messages
		let attempt: ResumeTurnAttempt = "approval_resume"
		const finalizationAdapter: TurnFinalizationAdapter<
			ReturnType<typeof runResumeModel>,
			Awaited<ReturnType<typeof readOutput>>
		> = {
			reply: { read: readOutput },
			liveUpdates: {
				current: () => currentRunLiveUpdateMessages,
				consume: consumeLiveUpdateMessages,
			},
			observe: {
				finalClaim: () => {
					failurePhase = "turn_finalization"
				},
			},
		}
		while (true) {
			throwIfAborted(abortSignal)
			currentRunLiveUpdateMessages = []
			const result = runResumeModel(sourceMessages, attempt)
			const nativeApprovals = await findApprovalRequests(result)
			const nextConnectedAppPause = connectedAppRuntime?.pendingApproval()
			let nextApprovals = nextConnectedAppPause
				? [nextConnectedAppPause.request]
				: nativeApprovals
			throwIfAborted(abortSignal)
			let nextApproval = batchApproval(nextApprovals)
			if (nextApproval) {
				if (!(await claimApprovalWithoutPendingUpdates())) {
					const pendingMessages = consumeLiveUpdateMessages()
					if (!pendingMessages.length) {
						throwIfAborted(abortSignal)
						throw new Error(
							"approval resume claim failed without a pending update",
						)
					}
					const response = await result.response
					sourceMessages = compactContinuation([
						...sourceMessages,
						...currentRunLiveUpdateMessages,
						...response.messages,
						...pendingMessages,
					])
					capture.memory = null
					capture.connect = null
					attempt = "live_update"
					continue
				}
				const { messages: responseMessages } = await result.response
				const conversation = [
					...sourceMessages,
					...currentRunLiveUpdateMessages,
					...responseMessages,
				]
				if (!nextConnectedAppPause) {
					nextApprovals = nextApprovals.map((item) =>
						enrichApprovalRequestFromMessages(item, conversation),
					)
				}
				nextApproval = batchApproval(nextApprovals) ?? nextApproval
				state.pendingApproval = {
					executionId:
						nextConnectedAppPause?.ref.executionId ?? nextApproval.approvalId,
					method: nextApproval.slug ?? nextApproval.toolName,
					summary: nextApproval.summary,
				}
				touchTurnState(state)
				telemetry.recordApproval(nextApprovals.length)
				console.log(
					`[company-brain][${traceId}] follow-up approval requested count=${nextApprovals.length} id=${nextApproval.approvalId} tool=${nextApproval.toolName} slug=${nextApproval.slug ?? "-"}`,
				)
				telemetry.finishTurn({
					outputChoices: lastProviderOutputChoices,
					turnStatus: "waiting_approval",
					inputTokens: totalInputTokens || undefined,
					outputTokens: totalOutputTokens || undefined,
					turnState: state,
				})
				return {
					status: "suspended",
					approval: nextApproval,
					state: {
						...approval.state,
						memory: capture.memory,
						messages: compactContinuation(conversation),
						approvalIds: nextApprovals.map((item) => item.approvalId),
						connectedAppPause: nextConnectedAppPause?.ref,
						turnState: restoreTurnState(state),
						assembly: snapshotTurnToolAssembly(
							assemblyArgs,
							toolDiscovery.enabledFamilies(),
						),
						detailedAppPolicy,
						terminalProposal: terminalCaptures.get(result)?.selected(),
					},
				}
			}

			const settlement = await settleTurn({
				run: { result, messages: sourceMessages },
				adapter: finalizationAdapter,
				activeDiscoveryApps: Object.keys(state.apps.discovered),
				coordination: approval.state.turnControl
					? {
							agent,
							control: approval.state.turnControl,
							traceId,
							origin: "approval_resume",
						}
					: undefined,
				abortSignal,
			})
			if (settlement.status === "continue") {
				sourceMessages = settlement.messages
				capture.memory = null
				capture.connect = null
				attempt = "live_update"
				continue
			}

			let { reply } = settlement.candidate

			if (!reply.trim()) {
				telemetry.recordCannedAnswer()
				reply = approved
					? "I ran the approved action, but couldn't put together a final answer."
					: "Okay, I won't run that action."
			}
			try {
				const checkpoint = buildThreadInvestigationCheckpoint({
					state,
					answer: reply,
				})
				if (checkpoint) {
					state.checkpoint = saveThreadInvestigation({
						agent,
						threadKey: state.request.threadKey,
						principalKey: investigationPrincipalKey({
							userId: approval.state.userId,
							actor: approval.state.actor,
						}),
						checkpoint,
					})
					touchTurnState(state)
				}
			} catch (error) {
				console.warn(
					`[company-brain][${traceId}] thread investigation checkpoint unavailable after approval: ${error instanceof Error ? error.message : String(error)}`,
				)
			}

			console.log(
				`[company-brain][${traceId}] approval resume final replyChars=${reply.length} memoryCount=${memoryDocsFromWriteback(capture.memory).length}`,
			)
			failurePhase = "completion"
			telemetry.finishTurn({
				outputChoices: [{ role: "assistant", content: reply }],
				turnStatus: approved
					? salvaged
						? "approval_resume_salvaged"
						: "approval_resume"
					: "approval_denied",
				inputTokens: totalInputTokens || undefined,
				outputTokens: totalOutputTokens || undefined,
				turnState: state,
			})
			return {
				status: "completed",
				reply,
				memory: capture.memory,
				connect: capture.connect,
				toolTrace,
				salvaged,
			}
		}
	} catch (error) {
		finishFailedTurn(error)
		throw error
	} finally {
		brainAgent(agent).waitUntil(charge())
		await assembled.mcpClose?.()
	}
}
