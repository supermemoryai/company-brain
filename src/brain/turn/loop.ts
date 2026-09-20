import type { ModelMessage, SystemModelMessage, ToolSet } from "ai"
import { replaceTrailingTurnState, type TurnStateRenderCache } from "./context"
import type { TurnDeps } from "./deps"
import {
	CONTINUATION_MAX_STEPS,
	LIVE_UPDATE_MAX_STEPS,
	type ModelProfile,
} from "./model-profile"
import {
	addTurnWarning,
	beginTurnAttempt,
	recordGeneratedStep,
	type TurnState,
	touchTurnState,
} from "./state"

type StreamTextOptions = Parameters<TurnDeps["streamText"]>[0]

export type TurnAttempt = "initial" | "live_update" | "approval_resume"

export type BudgetPolicyDecision = {
	remaining: number
	warned: boolean
	wrapUp: boolean
}

export function applyStepBudgetPolicy(state: TurnState): BudgetPolicyDecision {
	const { limit, used } = state.budget.steps
	const remaining = Math.max(0, limit - used)
	let warned = false
	if (used === limit - 3) {
		const warning = `Budget: ${remaining} steps remain. Consolidate and answer from the evidence you have.`
		const before = state.version
		addTurnWarning(state, warning)
		warned = state.version !== before
	}
	return { remaining, warned, wrapUp: used >= limit - 1 }
}

// The person sees nothing while the model grinds through tool calls; it has no
// clock of its own. When silence runs long, give it the time signal and the
// option to speak — via the same turn_state channel as the budget warning. It's
// permission, not obligation: it posts only if something new is worth sharing.
// Self-clears once an update resets the caller's visibility timer.
export const PROGRESS_NUDGE_AFTER_MS = 10_000

export function applyProgressPacingPolicy(
	state: TurnState,
	elapsedSinceLastVisibleMs: number,
	hasSpoken: boolean,
): void {
	const hadPacing = state.warnings.some((warning) =>
		warning.startsWith("Pacing:"),
	)
	if (hadPacing) {
		state.warnings = state.warnings.filter(
			(warning) => !warning.startsWith("Pacing:"),
		)
	}
	if (elapsedSinceLastVisibleMs >= PROGRESS_NUDGE_AFTER_MS) {
		const seconds = Math.round(elapsedSinceLastVisibleMs / 1000)
		// Never spoken yet → prompt a varied opener. Already spoke → by-need only.
		const guidance = hasSpoken
			? "Only if something genuinely new is worth sharing right now — a fresh finding, or a real change in what's happening — call post_update, phrased however fits. If nothing has changed since your last message, or you're about to answer, stay quiet: do not post just because time passed, and never repeat yourself."
			: "The person still hasn't heard anything. If this will keep taking a while, tell them what you're doing now, phrased however you genuinely would and never a stock line. If you're about to answer, just answer."
		addTurnWarning(
			state,
			`Pacing: ~${seconds}s since the person last heard from you. ${guidance}`,
		)
	} else if (hadPacing) {
		touchTurnState(state)
	}
}

export type RunModelLoopArgs = {
	deps: TurnDeps
	env: Env
	profile: ModelProfile
	system: () => SystemModelMessage[]
	messages: ModelMessage[]
	tools: ToolSet
	activeTools: () => string[]
	/** Protocol tools that remain available during budget wrap-up. */
	alwaysActiveTools?: string[]
	state: TurnState
	attempt: TurnAttempt
	stepLimit?: number
	suspendRequested?: () => boolean
	abortSignal?: AbortSignal
	functionId: string
	prepareMessages?: (messages: ModelMessage[]) => ModelMessage[]
	/** Runs at the top of each step, before turn_state is rendered, so it may mutate state (e.g. pacing nudges). */
	onBeforeStep?: (stepNumber: number) => void
	onPreparedStep?: (args: {
		stepNumber: number
		input: ModelMessage[]
		toolNames: string[]
		startedAt: number
	}) => void
	onStepFinish?: StreamTextOptions["onStepFinish"]
	onFinish?: StreamTextOptions["onFinish"]
	onError?: StreamTextOptions["onError"]
	onToolCallStart?: StreamTextOptions["experimental_onToolCallStart"]
	onToolCallFinish?: StreamTextOptions["experimental_onToolCallFinish"]
}

export function runModelLoop(args: RunModelLoopArgs) {
	const limit =
		args.stepLimit ??
		(args.attempt === "initial"
			? args.profile.maxSteps
			: args.attempt === "live_update"
				? LIVE_UPDATE_MAX_STEPS
				: CONTINUATION_MAX_STEPS)
	beginTurnAttempt(args.state, limit)
	const renderCache: TurnStateRenderCache = {}
	const initialMessages = replaceTrailingTurnState(
		args.messages,
		args.state,
		renderCache,
	)
	const resolveActiveTools = (wrapUp = false): string[] => {
		const alwaysActive = (args.alwaysActiveTools ?? []).filter(
			(name) => name in args.tools,
		)
		const regular = wrapUp ? [] : args.activeTools()
		return [...new Set([...regular, ...alwaysActive])]
	}

	return args.deps.streamText({
		model: args.deps.getModel(args.profile.name, args.env),
		system: args.system(),
		messages: initialMessages,
		tools: args.tools,
		activeTools: resolveActiveTools(),
		abortSignal: args.abortSignal,
		stopWhen: [
			args.deps.stepCountIs(limit),
			() => args.suspendRequested?.() === true,
		],
		prepareStep: ({ messages, stepNumber }) => {
			const budget = applyStepBudgetPolicy(args.state)
			args.onBeforeStep?.(stepNumber)
			const sourceMessages = args.prepareMessages?.(messages) ?? messages
			const preparedMessages = replaceTrailingTurnState(
				sourceMessages,
				args.state,
				renderCache,
			)
			const system = args.system()
			const activeTools = resolveActiveTools(budget.wrapUp)
			args.onPreparedStep?.({
				stepNumber,
				input: [...system, ...preparedMessages],
				toolNames: activeTools,
				startedAt: Date.now(),
			})
			return { messages: preparedMessages, activeTools, system }
		},
		maxRetries: 3,
		providerOptions: args.profile.providerOptions(args.profile.effort),
		experimental_telemetry: {
			isEnabled: true,
			functionId: args.functionId,
		},
		onStepFinish: async (event) => {
			recordGeneratedStep(args.state)
			await args.onStepFinish?.(event)
		},
		onFinish: args.onFinish,
		onError: args.onError,
		experimental_onToolCallStart: args.onToolCallStart,
		experimental_onToolCallFinish: args.onToolCallFinish,
	})
}
