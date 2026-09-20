import { generateText, type LanguageModel } from "ai"
import { captureException } from "@/lib/capture"
import {
	brainProviderModel,
	brainXai,
	hasBrainGateway,
	wrapBrainGateway,
} from "./turn/brain-model"
import { BRAIN_FALLBACK_MODEL, BRAIN_MODEL } from "./turn/model-profile"

const TIMEOUT_MS = 10_000
const CACHE_TTL_SECONDS = 60

export type BrainHealthCheck = {
	ok: boolean
	latencyMs: number
	servedBy?: string
	error?: string
}

export type BrainGatewayHealth = {
	status: "ok" | "degraded" | "down"
	gateway: string | null
	checks: Partial<Record<"primary" | "fallback" | "pair", BrainHealthCheck>>
	error?: string
	checkedAt: string
	cached?: boolean
}

async function probeModel(model: LanguageModel): Promise<BrainHealthCheck> {
	const startedAt = Date.now()
	try {
		const result = await generateText({
			model,
			prompt: "Reply with exactly: ok",
			maxOutputTokens: 16,
			maxRetries: 0,
			abortSignal: AbortSignal.timeout(TIMEOUT_MS),
			experimental_telemetry: {
				isEnabled: true,
				functionId: "company-brain-health",
			},
		})
		const ok = Boolean(result.text.trim())
		return {
			ok,
			latencyMs: Date.now() - startedAt,
			servedBy: result.response?.modelId,
			...(ok ? {} : { error: "model returned empty response" }),
		}
	} catch (error) {
		return {
			ok: false,
			latencyMs: Date.now() - startedAt,
			error:
				error instanceof Error ? error.message.slice(0, 300) : String(error),
		}
	}
}

function statusOf(
	checks: BrainGatewayHealth["checks"],
): BrainGatewayHealth["status"] {
	const { primary, fallback, pair } = checks
	if (!primary?.ok && !fallback?.ok) return "down"
	if (!primary?.ok || !fallback?.ok || pair?.ok === false) return "degraded"
	return "ok"
}

function reportFailures(health: BrainGatewayHealth): void {
	const failures = Object.entries(health.checks).filter(([, c]) => !c.ok)
	if (health.status === "down") {
		failures.push([
			"all",
			{ ok: false, latencyMs: 0, error: health.error ?? "all probes failed" },
		])
	}
	for (const [name, check] of failures) {
		captureException(
			new Error(`[company-brain] health probe ${name} failed: ${check.error}`),
			{
				tags: { feature: "company_brain" },
				fingerprint: [`brain-health-${name}-failed`],
			},
		)
	}
}

export async function runBrainGatewayHealth(
	env: Env,
	options?: { deep?: boolean; fresh?: boolean },
): Promise<BrainGatewayHealth> {
	const cacheKey = `brain:gateway-health:v1:${options?.deep ? "deep" : "base"}`
	if (!options?.fresh) {
		const cached = await env.BRAIN_KV?.get<BrainGatewayHealth>(
			cacheKey,
			"json",
		).catch(() => null)
		if (cached) return { ...cached, cached: true }
	}

	const gateway = env.AI_GATEWAY_NAME?.trim() || null
	const checkedAt = new Date().toISOString()
	let health: BrainGatewayHealth
	if (!hasBrainGateway(env)) {
		health = {
			status: "down",
			gateway,
			checks: {},
			error: "gateway env not configured",
			checkedAt,
		}
	} else {
		const probes: Record<string, LanguageModel> = {
			primary: wrapBrainGateway(env, [brainProviderModel(BRAIN_MODEL, env)]),
			fallback: wrapBrainGateway(env, [
				brainProviderModel(BRAIN_FALLBACK_MODEL, env),
			]),
			...(options?.deep
				? {
						// Dead primary on purpose: proves the gateway advances to the fallback step.
						pair: wrapBrainGateway(env, [
							brainXai(env).responses("grok-health-nonexistent"),
							brainProviderModel(BRAIN_FALLBACK_MODEL, env),
						]),
					}
				: {}),
		}
		const checks = Object.fromEntries(
			await Promise.all(
				Object.entries(probes).map(
					async ([name, model]) => [name, await probeModel(model)] as const,
				),
			),
		)
		health = { status: statusOf(checks), gateway, checks, checkedAt }
	}

	reportFailures(health)
	await env.BRAIN_KV?.put(cacheKey, JSON.stringify(health), {
		expirationTtl: CACHE_TTL_SECONDS,
	}).catch(() => {})
	return health
}
