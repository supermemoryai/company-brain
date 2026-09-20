import type { SharedV3ProviderOptions } from "@ai-sdk/provider"
import {
	getModelInfo,
	getModelReasoningProviderOptions,
	type ModelReasoningEffort,
	type SupportedModel,
	type SupportedModelProvider,
} from "@/lib/model-registry"

export type Effort = ModelReasoningEffort

export type BrainModelProvider = SupportedModelProvider
export type BrainProfileModel = SupportedModel

export type ModelProfile<ModelName extends BrainProfileModel = SupportedModel> =
	{
		name: ModelName
		provider: BrainModelProvider
		effort: Effort
		providerOptions: (effort: Effort) => SharedV3ProviderOptions
		cacheControl: () => SharedV3ProviderOptions | undefined
		maxSteps: number
	}

export const BRAIN_MODEL = "grok-4.5" as const
export const BRAIN_FALLBACK_MODEL = "claude-sonnet-5" as const
export const BRAIN_FALLBACK_MODEL_FOR_ANTHROPIC = "gpt-5.6" as const
export const TRIAGE_MODEL = "claude-haiku-4.5" as const
export const RESEARCH_MODEL = "grok-4.5" as const
export const BRAIN_MAIN_EFFORT = "high" as const satisfies Effort
export const BRAIN_TRIAGE_EFFORT = "low" as const satisfies Effort
export const MAX_STEPS = 60
export const CONTINUATION_MAX_STEPS = 30
export const LIVE_UPDATE_MAX_STEPS = 12

export const BRAIN_MAIN_MODEL_CHOICES = [
	"claude-sonnet-5",
	"claude-opus-4.8",
	"claude-sonnet-4.6",
	"grok-4.5",
	"gpt-5.6",
	"gpt-5.5",
] as const satisfies readonly SupportedModel[]

export const BRAIN_TRIAGE_MODEL_CHOICES = [
	"claude-haiku-4.5",
	"claude-sonnet-5",
] as const satisfies readonly SupportedModel[]

export const BRAIN_EFFORT_CHOICES = [
	"low",
	"medium",
	"high",
	"xhigh",
] as const satisfies readonly Effort[]

export const BRAIN_MAIN_EFFORT_CHOICES = [
	"auto",
	...BRAIN_EFFORT_CHOICES,
] as const satisfies readonly (Effort | "auto")[]

export type BrainModelConfig = {
	main?: SupportedModel
	mainEffort?: Effort | "auto"
	triage?: SupportedModel
	triageEffort?: Effort
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function readBrainModels(metadata: unknown): BrainModelConfig {
	if (!isRecord(metadata)) return {}
	const brainModels = metadata.brainModels
	return isRecord(brainModels) ? (brainModels as BrainModelConfig) : {}
}

export function resolveBrainMainModel(metadata: unknown): SupportedModel {
	const picked = readBrainModels(metadata).main
	return picked &&
		(BRAIN_MAIN_MODEL_CHOICES as readonly string[]).includes(picked)
		? picked
		: BRAIN_MODEL
}

export function resolveBrainMainEffort(
	metadata: unknown,
	agentMainEffort?: Effort,
	effortOverride?: Effort,
): Effort {
	// Internal turns pin effort outright. `agentMainEffort` only applies to orgs
	// that opted into "auto", so it can't carry a background batch's own posture.
	if (effortOverride) return effortOverride
	const picked = readBrainModels(metadata).mainEffort
	if (picked === "auto") return agentMainEffort ?? BRAIN_MAIN_EFFORT
	return resolveBrainEffort(metadata, "mainEffort", BRAIN_MAIN_EFFORT)
}

function resolveBrainEffort(
	metadata: unknown,
	key: "mainEffort" | "triageEffort",
	fallback: Effort,
): Effort {
	const picked = readBrainModels(metadata)[key]
	return picked && (BRAIN_EFFORT_CHOICES as readonly string[]).includes(picked)
		? (picked as Effort)
		: fallback
}

export function resolveBrainTriageModel(metadata: unknown): SupportedModel {
	const picked = readBrainModels(metadata).triage
	return picked &&
		(BRAIN_TRIAGE_MODEL_CHOICES as readonly string[]).includes(picked)
		? picked
		: TRIAGE_MODEL
}

export function resolveBrainTriageEffort(metadata: unknown): Effort {
	return resolveBrainEffort(metadata, "triageEffort", BRAIN_TRIAGE_EFFORT)
}

export function brainFallbackModelFor(name: BrainProfileModel): SupportedModel {
	return getModelInfo(name).provider === "anthropic"
		? BRAIN_FALLBACK_MODEL_FOR_ANTHROPIC
		: BRAIN_FALLBACK_MODEL
}

export function createModelProfile<ModelName extends BrainProfileModel>(
	name: ModelName,
	effort: Effort = BRAIN_MAIN_EFFORT,
): ModelProfile<ModelName> {
	const provider = getModelInfo(name).provider
	return {
		name,
		provider,
		effort,
		maxSteps: MAX_STEPS,
		providerOptions(requestedEffort): SharedV3ProviderOptions {
			return {
				...getModelReasoningProviderOptions(
					brainFallbackModelFor(name),
					"medium",
				),
				...getModelReasoningProviderOptions(name, requestedEffort),
			}
		},
		cacheControl(): SharedV3ProviderOptions | undefined {
			return provider === "anthropic"
				? { anthropic: { cacheControl: { type: "ephemeral" } } }
				: undefined
		},
	}
}

export function resolveBrainMainProfile(
	metadata: unknown,
	agentMainEffort?: Effort,
	effortOverride?: Effort,
): ModelProfile {
	return createModelProfile(
		resolveBrainMainModel(metadata),
		resolveBrainMainEffort(metadata, agentMainEffort, effortOverride),
	)
}

export function resolveBrainTriageProfile(metadata: unknown): ModelProfile {
	return createModelProfile(
		resolveBrainTriageModel(metadata),
		resolveBrainTriageEffort(metadata),
	)
}
