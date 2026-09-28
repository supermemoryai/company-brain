import type { AnthropicProviderOptions } from "@ai-sdk/anthropic"
import type { GoogleGenerativeAIProviderOptions } from "@ai-sdk/google"
import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai"
import type { SharedV3ProviderOptions } from "@ai-sdk/provider"
import type { XaiResponsesProviderOptions } from "@ai-sdk/xai"

export const SUPPORTED_MODELS = [
	"grok-4.3",
	"grok-4.5",
	"gpt-5.1",
	"gpt-5.5",
	"gpt-5.6",
	"gpt-5.6-terra",
	"claude-opus-4.8",
	"claude-sonnet-5",
	"claude-sonnet-4.6",
	"claude-haiku-4.5",
	"gemini-3.1-pro-preview",
	// Compatibility alias for chat/playground settings saved before the 3.1 upgrade.
	"gemini-2.5-pro",
] as const

export type SupportedModel = (typeof SUPPORTED_MODELS)[number]
export type SupportedModelProvider = "anthropic" | "openai" | "xai" | "google"
export type ModelReasoningEffort = "low" | "medium" | "high" | "xhigh"

const SUPPORTED_MODEL_SET = new Set<string>(SUPPORTED_MODELS)

export function isSupportedModel(value: unknown): value is SupportedModel {
	return typeof value === "string" && SUPPORTED_MODEL_SET.has(value)
}

type SupportedModelInfo = {
	modelId: string
	provider: SupportedModelProvider
	canonicalName?: SupportedModel
}

const MODEL_INFO = {
	"grok-4.3": { modelId: "grok-4.3", provider: "xai" },
	"grok-4.5": { modelId: "grok-4.5", provider: "xai" },
	"gpt-5.1": { modelId: "gpt-5.1", provider: "openai" },
	"gpt-5.5": { modelId: "gpt-5.5", provider: "openai" },
	"gpt-5.6": { modelId: "gpt-5.6", provider: "openai" },
	"gpt-5.6-terra": { modelId: "gpt-5.6-terra", provider: "openai" },
	"claude-opus-4.8": {
		modelId: "claude-opus-4-8",
		provider: "anthropic",
	},
	"claude-sonnet-5": {
		modelId: "claude-sonnet-5",
		provider: "anthropic",
	},
	"claude-sonnet-4.6": {
		modelId: "claude-sonnet-4-6",
		provider: "anthropic",
	},
	"claude-haiku-4.5": {
		modelId: "claude-haiku-4-5-20251001",
		provider: "anthropic",
	},
	"gemini-3.1-pro-preview": {
		modelId: "gemini-3.1-pro-preview",
		provider: "google",
	},
	"gemini-2.5-pro": {
		modelId: "gemini-3.1-pro-preview",
		provider: "google",
		canonicalName: "gemini-3.1-pro-preview",
	},
} as const satisfies Record<SupportedModel, SupportedModelInfo>

export function getModelInfo(modelName: SupportedModel): SupportedModelInfo {
	return MODEL_INFO[modelName]
}

/**
 * The OrcaRouter catalog names models `vendor/model`, which is not the same
 * namespace the native registry uses: xAI is `grok/*` there, and the vendor of
 * an Anthropic model is `anthropic`.
 */
const ORCA_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,95}$/

/** A `vendor/model` id that came from the OrcaRouter catalog, not the registry. */
export function isOrcaCatalogModelId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 160 &&
		ORCA_MODEL_ID_PATTERN.test(value)
	)
}

/**
 * Catalog ids that name the same underlying model as a native entry. These are
 * kept so a model picked from the OrcaRouter dropdown keeps the reasoning
 * ladder and price the registry already holds. Each id was checked against
 * `GET https://api.orcarouter.ai/v1/models` on 2026-09-28; an id that is not
 * listed here resolves with no reasoning options rather than a guessed ladder.
 */
const ORCA_CATALOG_TO_NATIVE: Record<string, SupportedModel> = {
	"openai/gpt-5.5": "gpt-5.5",
	"openai/gpt-5.1": "gpt-5.1",
	"anthropic/claude-opus-4.8": "claude-opus-4.8",
	"anthropic/claude-sonnet-5": "claude-sonnet-5",
	"anthropic/claude-sonnet-4.6": "claude-sonnet-4.6",
	"anthropic/claude-haiku-4.5": "claude-haiku-4.5",
	"google/gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
	"grok/grok-4.5": "grok-4.5",
	"grok/grok-4.3": "grok-4.3",
}

/** The native entry for a catalog id, when the two name the same model. */
export function nativeModelForOrcaId(id: string): SupportedModel | null {
	return ORCA_CATALOG_TO_NATIVE[id] ?? null
}

const ORCA_VENDOR_TO_PROVIDER: Record<string, SupportedModelProvider> = {
	anthropic: "anthropic",
	openai: "openai",
	google: "google",
	"x-ai": "xai",
	xai: "xai",
	grok: "xai",
}

/**
 * What a stored model choice resolves to, whether it is a native model or a
 * `vendor/model` id from the OrcaRouter catalog. A catalog id with no native
 * equivalent reports no reasoning ladder rather than a guessed one.
 */
export type BrainModelResolution = {
	/** The id as sent on the wire. */
	modelId: string
	provider: SupportedModelProvider | null
	/** The native entry this is the same model as, when there is one. */
	native: SupportedModel | null
}

export function resolveBrainModelId(name: string): BrainModelResolution | null {
	if (isSupportedModel(name)) {
		const info = getModelInfo(name)
		return { modelId: info.modelId, provider: info.provider, native: name }
	}
	if (!isOrcaCatalogModelId(name)) return null
	const native = nativeModelForOrcaId(name)
	if (native) {
		return {
			modelId: getModelInfo(native).modelId,
			provider: getModelInfo(native).provider,
			native,
		}
	}
	const vendor = name.split("/")[0] ?? ""
	return {
		modelId: name,
		provider: ORCA_VENDOR_TO_PROVIDER[vendor] ?? null,
		native: null,
	}
}

/**
 * Keep Nova requests saved by older web clients on the current model lineup.
 * This is intentionally Nova-specific: other callers can still request the
 * legacy models by their exact supported IDs.
 */
export function resolveNovaModel(modelName: SupportedModel): SupportedModel {
	switch (modelName) {
		case "grok-4.3":
			return "grok-4.5"
		case "gpt-5.1":
			return "gpt-5.6-terra"
		case "claude-sonnet-4.6":
			return "claude-sonnet-5"
		case "gemini-2.5-pro":
			return "gemini-3.1-pro-preview"
		default:
			return modelName
	}
}

function boundedEffort(
	effort: ModelReasoningEffort,
): Exclude<ModelReasoningEffort, "xhigh"> {
	return effort === "xhigh" ? "high" : effort
}

/**
 * Translate the shared effort control into options supported by the exact model.
 * Capability differences inside one provider are intentional and must not be
 * collapsed into a provider-prefix switch.
 */
export function getModelReasoningProviderOptions(
	modelName: string,
	effort: ModelReasoningEffort,
): SharedV3ProviderOptions {
	// A catalog id with a native equivalent keeps that model's verified ladder.
	// Anything else has no checked reasoning support, so nothing is claimed.
	const native = isSupportedModel(modelName)
		? modelName
		: nativeModelForOrcaId(modelName)
	if (!native) return {}
	switch (native) {
		case "grok-4.3":
		case "grok-4.5":
			return {
				xai: {
					reasoningEffort: boundedEffort(effort),
				} satisfies XaiResponsesProviderOptions,
			}
		case "gpt-5.1":
			return {
				openai: {
					reasoningEffort: boundedEffort(effort),
				} satisfies OpenAIResponsesProviderOptions,
			}
		case "gpt-5.5":
		case "gpt-5.6":
		case "gpt-5.6-terra":
			return {
				openai: {
					reasoningEffort: effort,
				} satisfies OpenAIResponsesProviderOptions,
			}
		case "claude-opus-4.8":
		case "claude-sonnet-5":
			return {
				anthropic: {
					thinking: { type: "adaptive" },
					effort,
				} satisfies AnthropicProviderOptions,
			}
		case "claude-sonnet-4.6":
			return {
				anthropic: {
					thinking: { type: "adaptive" },
					effort: effort === "xhigh" ? "max" : effort,
				} satisfies AnthropicProviderOptions,
			}
		case "claude-haiku-4.5":
			// Haiku 4.5 supports manual thinking, but not adaptive thinking or
			// output_config.effort. Brain triage/classification intentionally stays
			// on the fast non-thinking path for this model.
			return {}
		case "gemini-3.1-pro-preview":
		case "gemini-2.5-pro":
			return {
				google: {
					thinkingConfig: {
						thinkingLevel: boundedEffort(effort),
					},
				} satisfies GoogleGenerativeAIProviderOptions,
			}
	}
}

/** Lowest-latency valid request shape for each model. */
export function getModelInstantProviderOptions(
	modelName: string,
): SharedV3ProviderOptions {
	const native = isSupportedModel(modelName)
		? modelName
		: nativeModelForOrcaId(modelName)
	if (!native) return {}
	switch (native) {
		case "grok-4.3":
			return {
				xai: {
					reasoningEffort: "none",
				} satisfies XaiResponsesProviderOptions,
			}
		case "grok-4.5":
			// Grok 4.5 is always a reasoning model and cannot be disabled.
			return {
				xai: {
					reasoningEffort: "low",
				} satisfies XaiResponsesProviderOptions,
			}
		case "gpt-5.1":
		case "gpt-5.5":
		case "gpt-5.6":
		case "gpt-5.6-terra":
			return {
				openai: {
					reasoningEffort: "none",
				} satisfies OpenAIResponsesProviderOptions,
			}
		case "claude-opus-4.8":
		case "claude-sonnet-5":
		case "claude-sonnet-4.6":
		case "claude-haiku-4.5":
			return {
				anthropic: {
					thinking: { type: "disabled" },
				} satisfies AnthropicProviderOptions,
			}
		case "gemini-3.1-pro-preview":
		case "gemini-2.5-pro":
			return {
				google: {
					thinkingConfig: { thinkingLevel: "low" },
				} satisfies GoogleGenerativeAIProviderOptions,
			}
	}
}

/** Explicit user-facing "thinking" mode, independent of Brain effort controls. */
export function getModelThinkingProviderOptions(
	modelName: string,
): SharedV3ProviderOptions {
	if (modelName === "claude-haiku-4.5") {
		return {
			anthropic: {
				thinking: { type: "enabled", budgetTokens: 8_192 },
			} satisfies AnthropicProviderOptions,
		}
	}
	return getModelReasoningProviderOptions(modelName, "high")
}
