import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { createXai } from "@ai-sdk/xai"
import type { LanguageModel } from "ai"
import { createAiGateway } from "ai-gateway-provider"
import { captureException } from "@/lib/capture"
import {
	getModelInfo,
	type SupportedModel,
	type SupportedModelProvider,
} from "@/lib/model-registry"
import { brainFallbackModelFor } from "./model-profile"

// Sentinel the gateway swaps for its stored provider key (BYOK).
const GATEWAY_INJECTED_KEY = "CF_TEMP_TOKEN"

import { openRouterBaseUrl } from "./openrouter-base-url"

const OPENROUTER_VENDOR: Record<SupportedModelProvider, string> = {
	anthropic: "anthropic",
	openai: "openai",
	google: "google",
	xai: "x-ai",
}

/** Best model this deployment can reach, per provider. */
const PROVIDER_DEFAULT_MODEL: Record<SupportedModelProvider, SupportedModel> = {
	anthropic: "claude-sonnet-5",
	openai: "gpt-5.6",
	google: "gemini-3.1-pro-preview",
	xai: "grok-4.5",
}

function providerKey(
	provider: SupportedModelProvider,
	env: Env,
): string | undefined {
	switch (provider) {
		case "anthropic":
			return env.ANTHROPIC_API_KEY
		case "openai":
			return env.OPENAI_API_KEY
		case "google":
			return env.GOOGLE_GENERATIVE_AI_API_KEY
		case "xai":
			return env.XAI_API_KEY
	}
}

function openRouterKey(env: Env): string | undefined {
	return env.OPENROUTER_API_KEY?.trim() || undefined
}

function canReach(provider: SupportedModelProvider, env: Env): boolean {
	return Boolean(providerKey(provider, env)?.trim() || openRouterKey(env))
}

export function availableProviders(env: Env): SupportedModelProvider[] {
	const order: SupportedModelProvider[] = [
		"anthropic",
		"openai",
		"google",
		"xai",
	]
	return order.filter((provider) => canReach(provider, env))
}

export function openRouterModelId(modelName: SupportedModel): string {
	const { provider, canonicalName } = getModelInfo(modelName)
	return `${OPENROUTER_VENDOR[provider]}/${canonicalName ?? modelName}`
}

function openRouterModel(modelName: SupportedModel, apiKey: string, env: Env) {
	return createOpenAI({
		name: "openrouter",
		apiKey,
		baseURL: openRouterBaseUrl(env),
		headers: { "X-Title": "Company Brain" },
	}).chat(openRouterModelId(modelName))
}

function resolveModel(modelName: SupportedModel, env: Env): SupportedModel {
	const { provider } = getModelInfo(modelName)
	if (canReach(provider, env)) return modelName
	const fallbackProvider = availableProviders(env)[0]
	if (!fallbackProvider) {
		const error = new Error(
			"No model provider key is set. Set MODEL_API_KEY to an Anthropic, OpenAI, Google, xAI or OpenRouter key.",
		)
		captureException(error, { tags: { feature: "company_brain" } })
		throw error
	}
	return PROVIDER_DEFAULT_MODEL[fallbackProvider]
}

/** xAI client, for the provider-native web-search tool. */
export function brainXai(env: Env, apiKeyOverride?: string) {
	return createXai({
		apiKey: apiKeyOverride ?? env.XAI_API_KEY ?? GATEWAY_INJECTED_KEY,
	})
}

export function hasXai(env: Env): boolean {
	return Boolean(env.XAI_API_KEY?.trim()) || hasBrainGateway(env)
}

export function brainProviderModel(
	modelName: SupportedModel,
	env: Env,
	apiKeyOverride?: string,
): LanguageModel {
	const { modelId, provider } = getModelInfo(modelName)
	const directKey = providerKey(provider, env)?.trim()
	const routerKey = openRouterKey(env)
	if (apiKeyOverride === undefined && !directKey && routerKey) {
		return openRouterModel(modelName, routerKey, env)
	}
	const apiKey = apiKeyOverride ?? providerKey(provider, env) ?? ""
	switch (provider) {
		case "xai":
			return createXai({ apiKey }).responses(modelId)
		case "openai":
			return createOpenAI({ apiKey })(modelId)
		case "anthropic":
			return createAnthropic({ apiKey })(modelId)
		case "google":
			return createGoogleGenerativeAI({ apiKey })(modelId)
	}
}

function brainGatewayConfig(env: Env) {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID
	const gateway = env.AI_GATEWAY_NAME
	const apiKey = env.AI_GATEWAY_TOKEN
	if (!accountId?.trim() || !gateway?.trim() || !apiKey?.trim()) return null
	return { accountId, gateway, apiKey }
}

export function hasBrainGateway(env: Env): boolean {
	return brainGatewayConfig(env) !== null
}

/**
 * Route through a Cloudflare AI Gateway when one is configured: it holds the
 * provider keys and falls through the candidate list on failure. Without a
 * gateway the first candidate is called directly.
 */
export function wrapBrainGateway(
	env: Env,
	models: LanguageModel[],
): LanguageModel {
	const [primary] = models
	if (!primary) {
		throw new Error("[company-brain] no model candidates provided")
	}
	const config = brainGatewayConfig(env)
	if (!config) return primary
	const aigateway = createAiGateway(config)
	// ai-gateway-provider types expect LanguageModelV3[]; our models match at runtime.
	return aigateway(models as never) as LanguageModel
}

export function getBrainModel(modelName: SupportedModel, env: Env) {
	const resolved = resolveModel(modelName, env)
	const gateway = hasBrainGateway(env)
	const key = gateway ? GATEWAY_INJECTED_KEY : undefined
	const candidates = [brainProviderModel(resolved, env, key)]
	const fallback = brainFallbackModelFor(resolved)
	const fallbackReachable = canReach(getModelInfo(fallback).provider, env)
	if (fallback !== resolved && (gateway || fallbackReachable)) {
		candidates.push(brainProviderModel(fallback, env, key))
	}
	return wrapBrainGateway(env, candidates)
}
