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
	modelName: SupportedModel,
	effort: ModelReasoningEffort,
): SharedV3ProviderOptions {
	switch (modelName) {
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
	modelName: SupportedModel,
): SharedV3ProviderOptions {
	switch (modelName) {
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
	modelName: SupportedModel,
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
