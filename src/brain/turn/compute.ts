import type { ModelMessage } from "ai"
import {
	BrainCostLedger,
	recordFinishEvent,
	scheduleChargeBrainLlmCost,
} from "../billing/cost"
import { getCompanyContext } from "../memory/company-context"
import {
	loadInteractionStyleProfile,
	renderInteractionStyle,
} from "../memory/interaction-style"
import { buildAmbientBrainProfileContext } from "../memory/profile-recall"
import { getWorkspacePrompt } from "../memory/workspace-prompt"
import {
	type MemoryWriteback,
	memoryDocsFromWriteback,
} from "../memory/writeback"
import {
	captureBrainTurnUpdateApplied,
	createBrainTurnTelemetry,
} from "../observability"
import {
	type BrainToolCallEvent,
	getToolFinishOutput,
	logPreview,
	logToolInput,
	redactedPreview,
} from "../observability/log-utils"
import {
	buildCurrentRequestPrompt,
	buildRuntimeContextPrompt,
	mapToolDetail,
	mapToolLabel,
	slackChannelRefFromToolCall,
	slackChannelRefsFromToolCall,
} from "../prompt/build"
import { buildAvailableSkillsContext } from "../skills/context"
import { buildTurnUserContent } from "../slack/attachments"
import { resolveChannel } from "../slack/channel-directory"
import { claimThreadTurnApprovalIfInboxEmpty } from "../slack/turn-control"
import {
	consumePendingTurnUpdates,
	formatTurnUpdates,
	waitForTurnUpdateClassification,
} from "../slack/turn-inbox"
import { brainAgent } from "./agent"
import {
	batchApproval,
	enrichApprovalRequestFromMessages,
	findApprovalRequests,
} from "./approval-requests"
import { reportLegacyStructuredReply, type TurnCapture } from "./capture-tools"
import { cardOutputPayload } from "./card-content"
import {
	applySystemCacheBreakpoints,
	buildTurnMessageLayout,
	compactMessagesAtBoundary,
} from "./context"
import { getTurnDeps } from "./deps"
import {
	selectTurnReply,
	settleTurn,
	type TurnFinalizationAdapter,
} from "./finalization"
import {
	applyProgressPacingPolicy,
	runModelLoop,
	type TurnAttempt,
} from "./loop"
import { resolveBrainMainProfile } from "./model-profile"
import {
	buildPassiveInvocationContext,
	isPassiveNoReply,
	PASSIVE_NO_REPLY,
} from "./passive"
import { shouldShowToolProgressCard } from "./progress"
import {
	createTurnState,
	recordConnectedAppTrajectory,
	restoreTurnState,
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
	loadThreadInvestigation,
	saveThreadInvestigation,
} from "./thread-investigation"
import { assembleTurnTools, snapshotTurnToolAssembly } from "./tools"
import type {
	ComputeTurnInput,
	ComputeTurnResult,
	TurnProgress,
	TurnToolTraceEntry,
} from "./types"
import {
	raceWithAbortSignal,
	safeStringify,
	throwIfAborted,
	turnFailureCode,
	turnFailureTerminal,
} from "./util"

export const EMPTY_REPLY =
	"Sorry — I couldn't put together an answer for that one. Mind rephrasing or trying again in a moment?"

type TurnFailurePhase =
	| "tool_assembly"
	| "context_loading"
	| "model_generation"
	| "approval_handshake"
	| "output_read"
	| "turn_finalization"
	| "completion"

type ComputeTurnAttempt = Extract<TurnAttempt, "initial" | "live_update">

function turnThreadKey(input: ComputeTurnInput, traceId: string): string {
	if (input.options?.turnControl?.threadKey) {
		return input.options.turnControl.threadKey
	}
	const slackKey = [
		input.slackLookup?.teamId,
		input.slackLookup?.channel,
		input.slackLookup?.threadTs,
	]
		.filter(Boolean)
		.join(":")
	return slackKey || `${input.org.id}:${traceId}`
}

export async function computeTurn(
	input: ComputeTurnInput,
): Promise<ComputeTurnResult> {
	const {
		agent,
		org,
		userId,
		actor,
		question,
		threadText,
		conversationMessages,
		threadHistory,
		threadParticipants,
		workspaceGroups,
		attachmentParts = [],
		loc,
		asker,
		botIdentity,
		directory,
		progress,
		interaction,
		slackLookup,
		mentionedSlackUserIds,
		scheduledRun,
		skipBilling,
		ephemeral,
		agentMainEffort,
		effortOverride,
		stepLimit,
		obs,
		env: envOverride,
		options,
	} = input
	const deps = await getTurnDeps()
	const env = envOverride ?? brainAgent(agent).env
	const profile = resolveBrainMainProfile(
		org.metadata,
		agentMainEffort,
		effortOverride,
	)
	const abortSignal = options?.abortSignal
	throwIfAborted(abortSignal)
	const capture: TurnCapture = { memory: null, connect: null }
	const telemetry = createBrainTurnTelemetry(org.id, userId, obs, profile.name)
	const traceId = telemetry.traceId
	const costLedger = new BrainCostLedger()
	// Pacing clock: when the person last saw a message, and whether they've heard
	// anything at all. Reset when the model posts, so silence during long tool
	// work can be measured/nudged (and a missing opener prompted).
	let lastUserVisibleAt = 0
	let updatesSent = 0
	let pacingInitialized = false
	// Wrapped so a post_update (progress.narrate) resets the pacing clock.
	const pacingProgress: TurnProgress | undefined = progress
		? {
				card: progress.card,
				...(progress.narrate
					? {
							narrate: async (text: string) => {
								// Pace on delivery only: an undelivered update (deduped, capped, stream
								// closed, or a failed Slack post) means the person heard nothing, so the
								// clock must keep running.
								const delivered = (await progress.narrate?.(text)) ?? false
								if (delivered) {
									lastUserVisibleAt = Date.now()
									updatesSent += 1
								}
								return delivered
							},
						}
					: {}),
			}
		: undefined
	console.log(
		`[company-brain][${traceId}] computeTurn start org=${org.id} user=${userId} model=${profile.name} effort=${profile.effort} question="${logPreview(question)}" threadChars=${threadText.length} attachments=${attachmentParts.length} directoryCount=${directory?.length ?? 0}`,
	)
	const state = createTurnState({
		request: {
			text: question,
			askerSlackId: asker?.slackUserId,
			threadKey: turnThreadKey(input, traceId),
		},
		stepLimit,
	})
	let totalInputTokens = 0
	let totalOutputTokens = 0
	let lastProviderOutputChoices: unknown[] = []
	let failurePhase: TurnFailurePhase = "tool_assembly"
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
	const investigationPrincipal = investigationPrincipalKey({ userId, actor })
	try {
		state.checkpoint = ephemeral
			? undefined
			: loadThreadInvestigation({
					agent,
					threadKey: state.request.threadKey,
					principalKey: investigationPrincipal,
				})
		if (state.checkpoint) {
			console.log(
				`[company-brain][${traceId}] restored thread investigation methods=${state.checkpoint.discoveredMethods.length} evidence=${state.checkpoint.verifiedEvidence.length}`,
			)
		}
	} catch (error) {
		console.warn(
			`[company-brain][${traceId}] thread investigation restore unavailable: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	const assemblyArgs = {
		deps,
		env,
		agent,
		org,
		userId,
		actor,
		directory,
		threadHistory,
		slackLookup,
		askerSlackUserId: asker?.slackUserId,
		mentionedSlackUserIds,
		askerIsRestricted: asker?.isRestricted,
		scheduledRun,
		options,
		progress: pacingProgress,
		traceId,
		capture,
		turnState: state,
		onPhaseLatency: telemetry.recordPhaseLatency,
		costLedger,
	} satisfies Parameters<typeof assembleTurnTools>[0]
	const assembly = assembleTurnTools(assemblyArgs)
	const assembled = await raceWithAbortSignal(assembly, abortSignal).catch(
		(error) => {
			// Abandoned, not cancelled: it still opens MCP transports.
			assembly
				.then((late) => (late.ready ? late.mcpClose?.() : undefined))
				.catch(() => {})
			finishFailedTurn(error)
			throw error
		},
	)
	if (!assembled.ready) return assembled.result
	const {
		tools,
		hasApps,
		toolDiscovery,
		connectedApps,
		connectedAppRuntime,
		connectedAppRouting,
	} = assembled

	const runTurn = async (): Promise<ComputeTurnResult> => {
		failurePhase = "context_loading"
		const toolTrace: TurnToolTraceEntry[] = []
		let salvaged = false
		const toolLabelContext = {
			slackChannelId: slackLookup?.channel,
			slackChannelNames: {} as Record<string, string>,
			slackVisibleChannelRefs: {} as Record<string, true>,
			slackPrivateChannelRefs: {} as Record<string, true>,
			genericNonVisibleSlackChannelLabels: true,
		}
		const markSlackChannelRef = (
			visibility: "visible" | "private",
			ref: string,
			channelId: string,
			channelName: string,
		): void => {
			const target =
				visibility === "visible"
					? toolLabelContext.slackVisibleChannelRefs
					: toolLabelContext.slackPrivateChannelRefs
			for (const value of [ref, channelId, channelName, `#${channelName}`]) {
				const normalized = value.trim().toLowerCase()
				if (normalized) target[normalized] = true
			}
		}
		const hydrateSlackChannelLabels = async (
			toolName: string,
			toolCall?: unknown,
		): Promise<void> => {
			if (!slackLookup) return
			const normalizedName = toolName.toUpperCase()
			const refs =
				normalizedName === "SEARCH_SLACK_CHANNEL"
					? [slackChannelRefFromToolCall(toolCall)].filter(
							(ref): ref is string => Boolean(ref),
						)
					: normalizedName === "SEARCH_SLACK_CHANNELS"
						? slackChannelRefsFromToolCall(toolCall)
						: []
			await Promise.all(
				refs.map(async (ref) => {
					const resolved = await resolveChannel(
						env,
						slackLookup.teamId,
						slackLookup.botToken,
						ref,
					).catch(() => undefined)
					if (resolved?.status !== "ok") return
					if (resolved.channel.isPrivate) {
						markSlackChannelRef(
							"private",
							ref,
							resolved.channel.id,
							resolved.channel.name,
						)
						return
					}
					if (resolved.channel.id !== slackLookup.channel) return
					toolLabelContext.slackChannelNames[resolved.channel.id] =
						resolved.channel.name
					markSlackChannelRef(
						"visible",
						ref,
						resolved.channel.id,
						resolved.channel.name,
					)
				}),
			)
		}
		const toolLabel = async (
			toolName: string,
			toolCall?: unknown,
		): Promise<string> => {
			await hydrateSlackChannelLabels(toolName, toolCall)
			return mapToolLabel(toolName, toolCall, toolLabelContext)
		}
		const showProgressCard = async (
			toolCallId: string,
			toolName: string,
			toolCall?: unknown,
		): Promise<void> => {
			if (!shouldShowToolProgressCard(toolName)) return
			await progress?.card(
				toolCallId,
				await toolLabel(toolName, toolCall),
				"in_progress",
				{ detail: mapToolDetail(toolName, toolCall) },
			)
		}

		const canRequestAccessLease = "request_access_lease" in tools
		const hasAppAccessTools = hasApps || canRequestAccessLease
		const detailedAppPolicy = hasAppAccessTools
		const activeSystem = deps.buildSystemPrompt({
			toolMode: hasAppAccessTools ? "apps" : "memory_only",
			appPolicy: detailedAppPolicy ? "detailed" : "compact",
			hasSandbox: toolDiscovery.availableFamilies().includes("sandbox"),
			canRequestAccessLease,
			connectedAppRouting,
			allowMemoryWriteback: !options?.passiveInvestigation,
			explicitFinish: !options?.passiveInvestigation,
		})
		const buildActiveSystem = () => activeSystem
		const buildCurrentSystemMessages = () =>
			applySystemCacheBreakpoints(
				deps.buildSystemPromptMessages(buildActiveSystem(), botIdentity),
				profile,
			)

		const [companyContext, brainMemoryContext, interactionStyleProfile] =
			await Promise.all([
				getCompanyContext(env, org.id, traceId),
				buildAmbientBrainProfileContext(agent, {
					orgId: org.id,
					senderSlackUserId: asker?.slackUserId,
					mentionedSlackUserIds,
					scope: slackLookup?.memoryScope,
					// Ambient recall reads memory before any tool runs, so an explicit
					// surface has to bind it too or the turn leaks in ahead of them.
					containerTags: slackLookup?.memoryContainerTags,
				}),
				loadInteractionStyleProfile(env, org.id, asker?.slackUserId).catch(
					() => null,
				),
			])
		const availableSkills = buildAvailableSkillsContext({
			agent,
			userId: actor.userId,
		})
		let workspacePrompt: string | null = null
		try {
			workspacePrompt = getWorkspacePrompt(agent)
		} catch {
			console.warn(
				`[company-brain][${traceId}] workspace_prompt lookup failed org=${org.id}`,
			)
		}
		console.log(
			`[company-brain][${traceId}] prompt context ready mode=lazy companyContext=${companyContext ? "yes" : "no"} ambientBrainProfile=${brainMemoryContext ? "yes" : "no"} interactionStyle=${interactionStyleProfile ? "yes" : "no"} workspacePrompt=${workspacePrompt ? "yes" : "no"} availableSkills=${availableSkills ? "yes" : "no"} directoryAvailable=${directory?.length ?? 0} hasApps=${hasApps ? "yes" : "no"}`,
		)
		state.availableSkillIds = availableSkills?.skillIds ?? []
		touchTurnState(state)
		const baseRuntimePrompt = buildRuntimeContextPrompt({
			asker,
			interaction,
			companyContext: companyContext ?? undefined,
			brainMemoryContext: brainMemoryContext ?? undefined,
			interactionStyle:
				renderInteractionStyle(interactionStyleProfile) ?? undefined,
			workspacePrompt: workspacePrompt ?? undefined,
			availableSkillsContext: availableSkills?.text,
			threadParticipants,
			workspaceGroups,
		})
		const runtimePrompt = [
			baseRuntimePrompt,
			options?.passiveInvestigation
				? buildPassiveInvocationContext(options.passiveInvestigation.reason)
				: "",
		]
			.filter(Boolean)
			.join("\n\n")
		const currentRequestPrompt = buildCurrentRequestPrompt({
			question,
			loc,
			asker,
			turnSteering: options?.turnSteering,
		})
		const currentUserContent = buildTurnUserContent(
			currentRequestPrompt,
			attachmentParts,
		)
		state.apps.connected = connectedApps.map((app) => ({ ...app }))
		touchTurnState(state)
		const layout = buildTurnMessageLayout({
			profile,
			systemMessages: deps.buildSystemPromptMessages(
				buildActiveSystem(),
				botIdentity,
			),
			runtimeContext: runtimePrompt,
			connectedApps,
			conversationMessages,
			threadText,
			requestText: question,
			requestContent: currentUserContent,
			state,
		})
		const initialMessages = layout.messages
		const threadPromptChars = conversationMessages?.length
			? conversationMessages.reduce(
					(total, message) => total + safeStringify(message.content).length,
					0,
				)
			: threadText.length
		const initialActiveToolNames = toolDiscovery.activeToolNames(
			Object.keys(tools),
		)
		telemetry.markGenerationStart({
			input: [...layout.system, ...initialMessages],
			toolNames: initialActiveToolNames,
			promptStats: {
				systemChars: layout.system.reduce(
					(total, message) => total + message.content.length,
					0,
				),
				runtimeChars: layout.runtimeContext.length,
				threadChars: threadPromptChars,
				threadMessages: conversationMessages?.length ?? 0,
				requestChars: currentRequestPrompt.length,
				contextMode: "lazy",
				hiddenToolCount:
					Object.keys(tools).length - initialActiveToolNames.length,
				lazyToolFamilies: toolDiscovery.availableFamilies(),
			},
		})
		console.log(
			`[company-brain][${traceId}] main model start activeToolCount=${initialActiveToolNames.length} hiddenToolCount=${Object.keys(tools).length - initialActiveToolNames.length} messages=${initialMessages.length} runtimeChars=${layout.runtimeContext.length} threadChars=${threadPromptChars} requestChars=${currentRequestPrompt.length}`,
		)

		let currentRunLiveUpdateMessages: ModelMessage[] = []
		const terminalCaptures = new WeakMap<object, TurnTerminalCapture>()
		const consumeLiveUpdateMessages = (): ModelMessage[] => {
			const control = options?.turnControl
			if (!control) return []
			const updates = consumePendingTurnUpdates(agent, control)
			if (!updates.length) return []
			for (const update of updates) {
				captureBrainTurnUpdateApplied({
					orgId: org.id,
					distinctId: obs?.distinctId ?? userId,
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
				`[company-brain][${traceId}] applied live thread updates count=${updates.length} messages=${updates.map((update) => update.message_ts).join(",")}`,
			)
			return [{ role: "user", content: formatTurnUpdates(updates) }]
		}
		function runTurnModel(
			messages: ModelMessage[],
			attempt: ComputeTurnAttempt,
		) {
			options?.onTerminalProposal?.(null)
			failurePhase = "model_generation"
			const stepSnapshots = new Map<
				number,
				{ input: unknown; toolNames: string[]; startedAt: number }
			>()
			const terminalCapture = createTurnTerminalCapture({
				onProposal: options?.onTerminalProposal,
			})
			const result = runModelLoop({
				deps,
				env,
				profile,
				system: buildCurrentSystemMessages,
				messages,
				tools,
				activeTools: () => toolDiscovery.activeToolNames(Object.keys(tools)),
				alwaysActiveTools: [FINISH_TURN_TOOL_NAME],
				state,
				attempt,
				// Continuations keep their own smaller cap.
				stepLimit: attempt === "initial" ? stepLimit : undefined,
				suspendRequested: () =>
					Boolean(
						connectedAppRuntime?.pendingApproval() ||
							terminalCapture.requested(),
					),
				abortSignal,
				onBeforeStep: () => {
					// Only pace the main investigation, and only when a live sink exists.
					if (attempt !== "initial" || !pacingProgress?.narrate) return
					if (!pacingInitialized) {
						// Start the clock when the model actually begins, not during setup.
						pacingInitialized = true
						lastUserVisibleAt = Date.now()
						return
					}
					applyProgressPacingPolicy(
						state,
						Date.now() - lastUserVisibleAt,
						updatesSent > 0,
					)
				},
				prepareMessages: (stepMessages) => {
					currentRunLiveUpdateMessages.push(...consumeLiveUpdateMessages())
					return [...stepMessages, ...currentRunLiveUpdateMessages]
				},
				functionId:
					attempt === "initial"
						? "company-brain-turn"
						: "company-brain-live-update",
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
						input: event.request?.body ?? snapshot?.input ?? messages,
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
					// Real USD from provider response (e.g. xAI cost_in_usd_ticks), not a price table.
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
							`[company-brain][${traceId}] terminal proposal outcome=${terminalProposal.outcome} replyChars=${terminalProposal.reply.length}`,
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
							await toolLabel(event.toolCall.toolName, event.toolCall),
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

		async function suspendedApprovalResult(
			result: ReturnType<typeof runTurnModel>,
			sourceMessages: ModelMessage[],
		): Promise<ComputeTurnResult | "retry_live_updates" | null> {
			const nativeApprovals = await findApprovalRequests(result)
			const connectedAppPause = connectedAppRuntime?.pendingApproval()
			let approvals = connectedAppPause
				? [connectedAppPause.request]
				: nativeApprovals
			throwIfAborted(abortSignal)
			let approval = batchApproval(approvals)
			if (!approval) return null
			failurePhase = "approval_handshake"
			if (
				options?.turnControl &&
				!claimThreadTurnApprovalIfInboxEmpty(agent, options.turnControl)
			) {
				await waitForTurnUpdateClassification(
					agent,
					options.turnControl,
					abortSignal,
				)
				if (!claimThreadTurnApprovalIfInboxEmpty(agent, options.turnControl)) {
					return "retry_live_updates"
				}
			}
			const { messages } = await result.response
			const conversation = [
				...sourceMessages,
				...currentRunLiveUpdateMessages,
				...messages,
			]
			if (!connectedAppPause) {
				approvals = approvals.map((item) =>
					enrichApprovalRequestFromMessages(item, conversation),
				)
			}
			approval = batchApproval(approvals) ?? approval
			if (options?.passiveInvestigation) {
				console.warn(
					`[company-brain][${traceId}] passive investigation suppressed approval request tool=${approval.toolName}`,
				)
				telemetry.finishTurn({
					outputChoices: [{ role: "assistant", content: PASSIVE_NO_REPLY }],
					turnStatus: "completed_silent",
					inputTokens: totalInputTokens || undefined,
					outputTokens: totalOutputTokens || undefined,
					turnState: state,
				})
				return {
					status: "completed",
					reply: "",
					memory: null,
					connect: null,
					silentConclusion: true,
				}
			}
			state.pendingApproval = {
				executionId: connectedAppPause?.ref.executionId ?? approval.approvalId,
				method: approval.slug ?? approval.toolName,
				summary: approval.summary,
			}
			touchTurnState(state)
			telemetry.recordApproval(approvals.length)
			console.log(
				`[company-brain][${traceId}] approval requested count=${approvals.length} id=${approval.approvalId} tool=${approval.toolName} slug=${approval.slug ?? "-"} input=${redactedPreview(approval.input, 2000)}`,
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
				approval,
				state: {
					userId,
					actor,
					question,
					messages: compactMessagesAtBoundary(conversation, {
						activeDiscoveryApps: Object.keys(state.apps.discovered),
					}),
					approvalIds: approvals.map((item) => item.approvalId),
					connectedAppPause: connectedAppPause?.ref,
					turnState: restoreTurnState(state),
					assembly: snapshotTurnToolAssembly(
						assemblyArgs,
						toolDiscovery.enabledFamilies(),
					),
					botIdentity,
					detailedAppPolicy,
					memoryScope: slackLookup?.memoryScope,
					memoryTagSlackUserIds: input.memoryTagSlackUserIds,
					memory: capture.memory,
					turnControl: options?.turnControl,
					terminalProposal: terminalCaptures.get(result)?.selected(),
				},
			}
		}

		async function readTurnOutput(
			result: ReturnType<typeof runTurnModel>,
		): Promise<{
			reply: string
			memory: MemoryWriteback
			connect: string[] | null
			silentConclusion?: boolean
		}> {
			failurePhase = "output_read"
			throwIfAborted(abortSignal)
			const selected = await selectTurnReply({
				result,
				terminalProposal: terminalCaptures.get(result)?.selected(),
			})
			throwIfAborted(abortSignal)
			const { reply } = selected
			telemetry.recordReplySource(selected.source)
			reportLegacyStructuredReply(reply, traceId)
			if (selected.source === "response") {
				salvaged = true
				telemetry.recordSalvaged()
			}
			if (options?.passiveInvestigation && isPassiveNoReply(reply)) {
				return {
					reply: "",
					memory: null,
					connect: null,
					silentConclusion: true,
				}
			}
			return {
				reply,
				memory: capture.memory,
				connect: capture.connect,
			}
		}

		const compactContinuation = (messages: ModelMessage[]): ModelMessage[] =>
			compactMessagesAtBoundary(messages, {
				activeDiscoveryApps: Object.keys(state.apps.discovered),
			})

		let sourceMessages = initialMessages
		let attempt: ComputeTurnAttempt = "initial"
		let output: Awaited<ReturnType<typeof readTurnOutput>> | undefined
		const finalizationAdapter: TurnFinalizationAdapter<
			ReturnType<typeof runTurnModel>,
			Awaited<ReturnType<typeof readTurnOutput>>
		> = {
			reply: {
				read: readTurnOutput,
			},
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
		while (!output) {
			throwIfAborted(abortSignal)
			currentRunLiveUpdateMessages = []
			const result = runTurnModel(sourceMessages, attempt)
			const approval = await suspendedApprovalResult(result, sourceMessages)
			if (approval && approval !== "retry_live_updates") return approval
			if (approval === "retry_live_updates") {
				const pendingMessages = consumeLiveUpdateMessages()
				if (!pendingMessages.length) {
					throwIfAborted(abortSignal)
					throw new Error("approval claim failed without a pending update")
				}
				const response = await result.response
				sourceMessages = compactContinuation([
					...sourceMessages,
					...currentRunLiveUpdateMessages,
					...response.messages,
					...pendingMessages,
				])
				attempt = "live_update"
				capture.memory = null
				capture.connect = null
				continue
			}

			const settlement = await settleTurn({
				run: { result, messages: sourceMessages },
				adapter: finalizationAdapter,
				activeDiscoveryApps: Object.keys(state.apps.discovered),
				coordination: options?.turnControl
					? {
							agent,
							control: options.turnControl,
							traceId,
							origin: "initial",
						}
					: undefined,
				abortSignal,
			})
			if (settlement.status === "publish") {
				output = settlement.candidate
				break
			}
			sourceMessages = settlement.messages
			attempt = "live_update"
			capture.memory = null
			capture.connect = null
		}

		let { reply, memory, connect } = output
		throwIfAborted(abortSignal)
		if (output.silentConclusion) {
			console.log(
				`[company-brain][${traceId}] passive investigation concluded silently`,
			)
			telemetry.finishTurn({
				outputChoices: [{ role: "assistant", content: PASSIVE_NO_REPLY }],
				turnStatus: "completed_silent",
				inputTokens: totalInputTokens || undefined,
				outputTokens: totalOutputTokens || undefined,
				turnState: state,
			})
			return {
				status: "completed",
				reply: "",
				memory: null,
				connect: null,
				toolTrace,
				salvaged,
				silentConclusion: true,
			}
		}
		if (options?.passiveInvestigation) {
			memory = null
			connect = null
		}
		if (!reply.trim()) {
			telemetry.recordCannedAnswer()
			reply = EMPTY_REPLY
		}
		if (!options?.passiveInvestigation && !ephemeral) {
			try {
				const checkpoint = buildThreadInvestigationCheckpoint({
					state,
					answer: reply,
				})
				if (checkpoint) {
					state.checkpoint = saveThreadInvestigation({
						agent,
						threadKey: state.request.threadKey,
						principalKey: investigationPrincipal,
						checkpoint,
					})
					touchTurnState(state)
				}
			} catch (error) {
				console.warn(
					`[company-brain][${traceId}] thread investigation checkpoint unavailable: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
		console.log(
			`[company-brain][${traceId}] final output replyChars=${reply.length} memoryCount=${memoryDocsFromWriteback(memory).length} connect=${connect ?? "-"}`,
		)
		failurePhase = "completion"
		telemetry.finishTurn({
			outputChoices: [{ role: "assistant", content: reply }],
			turnStatus: salvaged ? "completed_salvaged" : "completed",
			inputTokens: totalInputTokens || undefined,
			outputTokens: totalOutputTokens || undefined,
			turnState: state,
		})
		return {
			status: "completed",
			reply,
			memory,
			connect,
			toolTrace,
			salvaged,
			narrated: state.surfacedUpdates.length > 0,
			nativeCallCount: state.nativeCalls.length,
		}
	}

	const turn = runTurn()
	let turnSettled = false
	const settled = () => {
		turnSettled = true
	}
	turn.then(settled, settled)
	let abandoned = false
	try {
		return await raceWithAbortSignal(turn, abortSignal)
	} catch (error) {
		abandoned = !turnSettled
		finishFailedTurn(error)
		throw error
	} finally {
		let chargedOps = 0
		const charge = async (): Promise<void> => {
			chargedOps += await scheduleChargeBrainLlmCost({
				orgId: org.id,
				ledger: costLedger,
				source: skipBilling ? "compute_turn_internal" : "compute_turn",
				traceId,
				env,
				chargedOps,
				skipBilling,
			})
		}
		// Bill now: an abandoned turn may never settle, and usage must not be lost.
		brainAgent(agent).waitUntil(
			abandoned ? charge().then(() => turn.then(charge, charge)) : charge(),
		)
		await assembled.mcpClose?.()
	}
}
