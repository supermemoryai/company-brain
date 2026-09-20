import {
	getModelInfo,
	isSupportedModel,
	SUPPORTED_MODELS,
	type SupportedModel,
} from "@/lib/model-registry"

/**
 * USD per 1M tokens for estimate path (when the response has no $).
 * Prefer provider-reported cost (e.g. xAI cost_in_usd_ticks) first.
 *
 * Sources (standard / short-context list rates, USD / 1M tokens):
 * - xAI: https://docs.x.ai/developers/models  (prompt < 200k tier)
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 * - OpenAI: https://developers.openai.com/api/docs/pricing  (standard short context)
 * - Google: https://ai.google.dev/gemini-api/docs/pricing  (paid standard, prompts ≤ 200k)
 *
 * Last verified: 2026-07-20. Re-check when models or list prices change.
 */
export type ModelTokenPrices = {
	inputPerMTok: number
	outputPerMTok: number
	cacheReadPerMTok?: number
	/** 5-minute cache write when billed separately (Anthropic 1.25× input). */
	cacheWritePerMTok?: number
}

const MODEL_USD_PRICES: Record<SupportedModel, ModelTokenPrices> = {
	// xAI — short-context tier (< 200k prompt); long-context is 2×
	"grok-4.3": {
		inputPerMTok: 1.25,
		outputPerMTok: 2.5,
		cacheReadPerMTok: 0.2,
	},
	"grok-4.5": {
		inputPerMTok: 2,
		outputPerMTok: 6,
		cacheReadPerMTok: 0.3,
	},

	// OpenAI — standard short-context; gpt-5.6 maps to flagship Sol-class list
	"gpt-5.1": {
		inputPerMTok: 1.25,
		outputPerMTok: 10,
		cacheReadPerMTok: 0.125,
	},
	"gpt-5.5": {
		inputPerMTok: 5,
		outputPerMTok: 30,
		cacheReadPerMTok: 0.5,
	},
	"gpt-5.6": {
		inputPerMTok: 5,
		outputPerMTok: 30,
		cacheReadPerMTok: 0.5,
	},
	"gpt-5.6-terra": {
		inputPerMTok: 2,
		outputPerMTok: 12,
		cacheReadPerMTok: 0.2,
	},

	// Anthropic — base + cache hit (0.1×); cache write 5m = 1.25× input
	// Sonnet 5: introductory $2/$10 through 2026-08-31 (then $3/$15)
	"claude-opus-4.8": {
		inputPerMTok: 5,
		outputPerMTok: 25,
		cacheReadPerMTok: 0.5,
		cacheWritePerMTok: 6.25,
	},
	"claude-sonnet-5": {
		inputPerMTok: 2,
		outputPerMTok: 10,
		cacheReadPerMTok: 0.2,
		cacheWritePerMTok: 2.5,
	},
	"claude-sonnet-4.6": {
		inputPerMTok: 3,
		outputPerMTok: 15,
		cacheReadPerMTok: 0.3,
		cacheWritePerMTok: 3.75,
	},
	"claude-haiku-4.5": {
		inputPerMTok: 1,
		outputPerMTok: 5,
		cacheReadPerMTok: 0.1,
		cacheWritePerMTok: 1.25,
	},

	// Google AI Studio paid — prompts ≤ 200k (higher tier if longer)
	"gemini-3.1-pro-preview": {
		inputPerMTok: 2,
		outputPerMTok: 12,
		cacheReadPerMTok: 0.2,
	},
	"gemini-2.5-pro": {
		inputPerMTok: 1.25,
		outputPerMTok: 10,
		cacheReadPerMTok: 0.125,
	},
}

/** Not user-selectable, so absent from SUPPORTED_MODELS. Groq list rates, verified 2026-08-26: https://groq.com/pricing */
const UTILITY_MODEL_USD_PRICES: Record<string, ModelTokenPrices> = {
	"openai/gpt-oss-20b": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
}

export const FAST_MODEL_BILLING_NAME = "openai/gpt-oss-20b"

/** Map provider modelId or SupportedModel name → SupportedModel for pricing. */
export function resolveBillableModel(
	modelIdOrName: string | undefined,
	fallback: string,
): string {
	if (modelIdOrName && isSupportedModel(modelIdOrName)) return modelIdOrName
	if (modelIdOrName) {
		for (const name of SUPPORTED_MODELS) {
			const info = getModelInfo(name)
			if (info.modelId === modelIdOrName) {
				return info.canonicalName ?? name
			}
		}
	}
	if (isSupportedModel(fallback)) return fallback
	return fallback
}

export function getModelTokenPrices(model: string): ModelTokenPrices | null {
	const utility = UTILITY_MODEL_USD_PRICES[model]
	if (utility) return utility
	const key = resolveBillableModel(model, model)
	if (!isSupportedModel(key)) return null
	return MODEL_USD_PRICES[key] ?? null
}

export function usdFromTokenUsage(
	model: string,
	usage: {
		inputTokens: number
		outputTokens: number
		cacheReadTokens: number
		cacheWriteTokens: number
	},
): number | null {
	const prices = getModelTokenPrices(model)
	if (!prices) return null
	// AI SDK inputTokens is total input; cache* are a subset (not additive).
	const uncachedInput = Math.max(
		0,
		usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens,
	)
	return (
		(uncachedInput / 1e6) * prices.inputPerMTok +
		(usage.outputTokens / 1e6) * prices.outputPerMTok +
		(usage.cacheReadTokens / 1e6) * (prices.cacheReadPerMTok ?? 0) +
		(usage.cacheWriteTokens / 1e6) * (prices.cacheWritePerMTok ?? 0)
	)
}
