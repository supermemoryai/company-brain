import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { createXai } from "@ai-sdk/xai"
import type { LanguageModel } from "ai"
import { createAiGateway } from "ai-gateway-provider"
import { captureException } from "@/lib/capture"
import {
	getModelInfo,
	resolveBrainModelId,
	type SupportedModel,
	type SupportedModelProvider,
} from "@/lib/model-registry"
import { brainFallbackModelFor, type BrainModelId } from "./model-profile"

// Sentinel the gateway swaps for its stored provider key (BYOK).
const GATEWAY_INJECTED_KEY = "CF_TEMP_TOKEN"

import { openRouterBaseUrl } from "./openrouter-base-url"
import { orcaApiBaseUrl } from "./orca-base-url"

const OPENROUTER_VENDOR: Record<SupportedModelProvider, string> = {
	anthropic: "anthropic",
	openai: "openai",
	google: "google",
	xai: "x-ai",
}

/**
 * OrcaRouter keeps its own `vendor/model` namespace, which is not always the
 * one it is asked for: xAI is `grok/*` there, and `openai/gpt-5.6` is not in
 * the catalog at all. Anything not listed keeps the OpenRouter-style vendor.
 */
const ORCAROUTER_VENDOR: Record<SupportedModelProvider, Record<string, string>> = {
	anthropic: { "claude-opus-4.8": "anthropic", "claude-sonnet-5": "anthropic" },
	openai: {},
	google: {},
	xai: { "grok-4.5": "grok" },
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

function orcaKey(env: Env): string | undefined {
	return env.ORCA_API_KEY?.trim() || undefined
}

function canReach(provider: SupportedModelProvider, env: Env): boolean {
	return Boolean(
		providerKey(provider, env)?.trim() || openRouterKey(env) || orcaKey(env),
	)
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

/**
 * Which OpenAI-compatible router, if any, will carry models that have no
 * provider-native key. A provider's own key still takes precedence per model
 * inside {@link brainProviderModel}, so this only names the router in play.
 */
export function preferredRouter(env: Env): "orcarouter" | "openrouter" | null {
	if (orcaKey(env)) return "orcarouter"
	if (openRouterKey(env)) return "openrouter"
	return null
}

export function openRouterModelId(modelName: BrainModelId): string {
	if (modelName.includes("/")) return modelName
	const { provider, canonicalName } = getModelInfo(modelName as SupportedModel)
	return `${OPENROUTER_VENDOR[provider]}/${canonicalName ?? modelName}`
}

function openRouterModel(modelName: BrainModelId, apiKey: string, env: Env) {
	return createOpenAI({
		name: "openrouter",
		apiKey,
		baseURL: openRouterBaseUrl(env),
		headers: { "X-Title": "Company Brain" },
	}).chat(openRouterModelId(modelName))
}

export function orcaModelId(modelName: BrainModelId): string {
	// A catalog id already carries the namespace the gateway wants.
	if (modelName.includes("/")) return modelName
	const { provider, canonicalName } = getModelInfo(modelName as SupportedModel)
	const name = canonicalName ?? modelName
	const vendor = ORCAROUTER_VENDOR[provider][name] ?? OPENROUTER_VENDOR[provider]
	return `${vendor}/${name}`
}

/**
 * OrcaRouter is an OpenAI-compatible gateway, so it rides the same adapter as
 * the other OpenAI-compatible router. Only the base URL and the model
 * namespace differ.
 */
function orcaRouterModel(modelName: BrainModelId, apiKey: string, env: Env) {
	return createOpenAI({
		name: "orcarouter",
		apiKey,
		baseURL: orcaApiBaseUrl(env),
		headers: { "X-Title": "Company Brain" },
	}).chat(orcaModelId(modelName))
}

function resolveModel(modelName: BrainModelId, env: Env): BrainModelId {
	const provider = resolveBrainModelId(modelName)?.provider ?? null
	if (provider && canReach(provider, env)) return modelName
	const fallbackProvider = availableProviders(env)[0]
	if (!fallbackProvider) {
		const error = new Error(
			"No model provider key is set. Set MODEL_API_KEY to an Anthropic, OpenAI, Google, xAI, OpenRouter or OrcaRouter key.",
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
	modelName: BrainModelId,
	env: Env,
	apiKeyOverride?: string,
): LanguageModel {
	const resolved = resolveBrainModelId(modelName)
	const modelId = resolved?.modelId ?? modelName
	const provider = resolved?.provider ?? null
	const directKey = provider ? providerKey(provider, env)?.trim() : undefined
	const routerKey = openRouterKey(env)
	const orca = orcaKey(env)
	if (apiKeyOverride === undefined && !directKey) {
		// A provider's own key still wins; behind it, an OrcaRouter key routes
		// every model through the OrcaRouter gateway, as an OpenRouter key does.
		if (orca) return orcaRouterModel(modelName, orca, env)
		if (routerKey) return openRouterModel(modelName, routerKey, env)
	}
	const apiKey =
		apiKeyOverride ?? (provider ? providerKey(provider, env) : undefined) ?? ""
	switch (provider) {
		case "xai":
			return createXai({ apiKey }).responses(modelId)
		case "openai":
			return createOpenAI({ apiKey })(modelId)
		case "anthropic":
			return createAnthropic({ apiKey })(modelId)
		case "google":
			return createGoogleGenerativeAI({ apiKey })(modelId)
		default:
			// An unrecognised catalog model still has to go somewhere: the
			// configured gateway or router carries it, and if neither is set the
			// caller has no route for it at all.
			if (orca) return orcaRouterModel(modelName, orca, env)
			if (routerKey) return openRouterModel(modelName, routerKey, env)
			throw new Error(
				`No provider is configured for model "${modelName}". Set that provider's key, or an OrcaRouter or OpenRouter key.`,
			)
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

export function getBrainModel(modelName: BrainModelId, env: Env) {
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

/**
 * Is this error OrcaRouter rejecting the credential rather than the request?
 * A duplexed `Response`/fetch failure surfaces as a TypeError in workerd, so
 * that is treated as an authentication signal too.
 */
export function isOrcaAuthFailure(error: unknown): boolean {
	for (const candidate of walkErrorCauses(error)) {
		const record = candidate as Record<string, unknown>
		if (record.status === 401) return true
		if (record.statusCode === 401) return true
		if (record.response !== undefined) {
			const response = record.response as Record<string, unknown>
			if (response.status === 401) return true
		}
		if (candidate instanceof TypeError) {
			const message = candidate.message.toLowerCase()
			if (message.includes("unauthorized") || message.includes("401")) {
				return true
			}
		}
	}
	return false
}

function* walkErrorCauses(error: unknown): Generator<object> {
	let current: unknown = error
	let depth = 0
	while (typeof current === "object" && current !== null && depth < 6) {
		yield current
		current = (current as { cause?: unknown }).cause
		depth += 1
	}
}

/**
 * Record a terminal rejection against the exact credential generation that
 * made the request. A critical property: a late failure from an old request
 * must not mark a credential that has since been replaced, so this only ever
 * writes the marker when the stored generation is still the rejected one.
 * There is no refresh to attempt — a revoked durable key needs a new login.
 */
export async function noteOrcaAuthFailure(
	env: Env,
	rejectedGeneration: string | undefined,
): Promise<boolean> {
	if (!rejectedGeneration) return false
	const { markOrcaCredentialNeedsReauth, createOrcaCredentialStore } =
		await import("./orcarouter-store")
	const marked = await markOrcaCredentialNeedsReauth(
		createOrcaCredentialStore(env),
		rejectedGeneration,
	)
	if (marked) {
		// Drop the in-memory copy so the next request stops using a dead key
		// instead of looping on 401. The stored secret is left in place.
		if (env.ORCA_API_KEY?.trim()) env.ORCA_API_KEY = undefined
	}
	return marked
}
