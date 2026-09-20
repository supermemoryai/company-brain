import {
	BrainCostLedger,
	responseBodyFromResult,
	scheduleChargeBrainLlmCost,
} from "../billing/cost"

const ACTIVE_TURN_GATE_MODEL = "claude-haiku-4.5" as const

export type ActiveTurnGateResult = "ignore" | "append" | "replace"

export type ActiveTurnAction = "ignore" | "queue" | "restart"

export type ActiveTurnGateDecision = {
	outcome: ActiveTurnGateResult
}

type ActiveTurnGateInput = {
	activeQuestion: string
	currentInstructions?: string[]
	message: string
	authorName?: string
	authorOwnsTurn: boolean
	obs?: {
		orgId: string
		distinctId: string
		traceId: string
		sessionId?: string
		channel?: string
		messageTs?: string
		threadTs?: string
		revision: number
	}
}

type ActiveTurnGateDeps = {
	generate?: (system: string, prompt: string, env: Env) => Promise<string>
	waitUntil?: (promise: Promise<void>) => void
}

const ACTIVE_TURN_GATE_PROMPT = `You classify the semantic effect of a new Slack message received while Company Brain is already working on a task. Classify the message the same way regardless of who authored it; authorization is enforced separately.

Return exactly one token:
- IGNORE: the message does not change the active task, such as commentary, encouragement, acknowledgements, or side conversation.
- APPEND: the message adds compatible scope or requirements that can be completed alongside the active task.
- REPLACE: the message explicitly contradicts, negates, or redirects away from the active task so both cannot be satisfied together.

Prefer IGNORE when there is no actionable instruction. Prefer APPEND whenever both requests can be satisfied in one coherent result. Additional research dimensions, comparisons, pricing, implications, recommendations, or strategy for the same subject are APPEND, even when they introduce a new desired outcome. Never choose REPLACE merely because the new message broadens the goal. Use REPLACE only for a real incompatibility, such as "instead", "stop doing that", "forget the earlier request", or requirements that cannot both be true. Short, conversational correction fragments are still actionable: for example, "actually no, Sreeram" or "not Dhravya, Mahesh" must be REPLACE rather than IGNORE. When uncertain, choose APPEND.`

function parseActiveTurnGateResult(text: string): ActiveTurnGateResult {
	const token = text.trim().split(/\s+/, 1)[0]?.toUpperCase()
	if (token === "IGNORE") return "ignore"
	if (token === "REPLACE") return "replace"
	return "append"
}

function hasExplicitCorrectionCue(message: string): boolean {
	const normalized = message.trim().toLowerCase()
	if (!normalized) return false
	return (
		/\b(?:instead|rather than|correction)\b/.test(normalized) ||
		/\bactually[\s,:-]+(?:no|not|instead)\b/.test(normalized) ||
		/^\s*(?:no|not)\s+(?!(?:problem|problems|worries|rush|needed|necessary|now)\b)\S+/.test(
			normalized,
		)
	)
}

function preserveExplicitCorrections(
	outcome: ActiveTurnGateResult,
	message: string,
): ActiveTurnGateResult {
	return outcome === "ignore" && hasExplicitCorrectionCue(message)
		? "replace"
		: outcome
}

export function applyActiveTurnPolicy(args: {
	outcome: ActiveTurnGateResult
	authorOwnsTurn: boolean
	turnStatus: "running" | "waiting_approval"
}): ActiveTurnAction {
	if (args.outcome === "ignore") return "ignore"
	if (args.outcome === "replace") {
		return args.authorOwnsTurn ? "restart" : "queue"
	}
	// Only the requester can restart a turn awaiting approval.
	if (args.authorOwnsTurn && args.turnStatus === "waiting_approval") {
		return "restart"
	}
	return "queue"
}

function buildActiveTurnGatePrompt(input: ActiveTurnGateInput): string {
	return [
		`<active_task>\n${input.activeQuestion}\n</active_task>`,
		input.currentInstructions?.length
			? `<current_instructions>\n${input.currentInstructions.join("\n")}\n</current_instructions>`
			: "",
		`<new_message author="${input.authorName ?? "unknown"}" author_owns_turn="${input.authorOwnsTurn}">\n${input.message}\n</new_message>`,
	]
		.filter(Boolean)
		.join("\n\n")
}

async function generateGateDecision(
	system: string,
	prompt: string,
	env: Env,
	billing?: {
		orgId: string
		traceId?: string
		waitUntil?: (promise: Promise<void>) => void
	},
): Promise<string> {
	const [{ generateText }, { getBrainModel }] = await Promise.all([
		import("ai"),
		import("../turn/brain-model"),
	])
	const result = await generateText({
		model: getBrainModel(ACTIVE_TURN_GATE_MODEL, env),
		system,
		prompt,
		maxRetries: 1,
		experimental_telemetry: {
			isEnabled: true,
			functionId: "company-brain-active-turn-gate",
		},
	})
	if (billing?.orgId) {
		const ledger = new BrainCostLedger()
		ledger.recordFromGeneration({
			model: result.response?.modelId ?? ACTIVE_TURN_GATE_MODEL,
			usage: result.usage,
			providerMetadata: result.providerMetadata,
			responseBody: responseBodyFromResult(result),
		})
		const charge = scheduleChargeBrainLlmCost({
			orgId: billing.orgId,
			ledger,
			source: "active_turn_gate",
			traceId: billing.traceId,
			env,
		})
		if (billing.waitUntil) billing.waitUntil(charge.then(() => {}))
		else void charge
	}
	return result.text
}

export async function triageActiveTurnMessage(
	env: Env,
	input: ActiveTurnGateInput,
	deps: ActiveTurnGateDeps = {},
): Promise<ActiveTurnGateDecision> {
	const prompt = buildActiveTurnGatePrompt(input)
	const startedAt = Date.now()
	try {
		const raw = deps.generate
			? await deps.generate(ACTIVE_TURN_GATE_PROMPT, prompt, env)
			: await generateGateDecision(
					ACTIVE_TURN_GATE_PROMPT,
					prompt,
					env,
					input.obs
						? {
								orgId: input.obs.orgId,
								traceId: input.obs.traceId,
								waitUntil: deps.waitUntil,
							}
						: undefined,
				)
		const outcome = preserveExplicitCorrections(
			parseActiveTurnGateResult(raw),
			input.message,
		)
		if (input.obs) {
			const { captureBrainActiveTurnGateGeneration } = await import(
				"../observability"
			)
			captureBrainActiveTurnGateGeneration({
				...input.obs,
				system: ACTIVE_TURN_GATE_PROMPT,
				prompt,
				rawOutput: raw,
				outcome,
				authorOwnsTurn: input.authorOwnsTurn,
				latencyMs: Date.now() - startedAt,
			})
		}
		return { outcome }
	} catch (error) {
		console.warn(
			"[company-brain] active-turn gate failed, defaulting to append:",
			error,
		)
		if (input.obs) {
			const { captureBrainActiveTurnGateGeneration } = await import(
				"../observability"
			)
			captureBrainActiveTurnGateGeneration({
				...input.obs,
				system: ACTIVE_TURN_GATE_PROMPT,
				prompt,
				rawOutput: "APPEND",
				outcome: "append",
				authorOwnsTurn: input.authorOwnsTurn,
				latencyMs: Date.now() - startedAt,
				isError: true,
			})
		}
		return { outcome: "append" }
	}
}
