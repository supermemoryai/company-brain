import { resolveBillableModel, usdFromTokenUsage } from "./model-prices"

/** xAI: 1 USD = 10^10 ticks (docs.x.ai cost tracking). */
const XAI_USD_TICKS_PER_DOLLAR = 10_000_000_000

export type ModelUsageTokens = {
	inputTokens?: number | null
	outputTokens?: number | null
	cacheReadTokens?: number | null
	cacheWriteTokens?: number | null
}

export type BrainCostEntry = {
	model: string
	usage: Required<ModelUsageTokens>
	usd: number
	/** provider = response $; estimate = token × list rates; missing = no $; vendor = non-LLM API */
	source: "provider" | "estimate" | "missing" | "vendor"
}

function n(value: number | null | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null
	return value as Record<string, unknown>
}

function numField(
	obj: Record<string, unknown> | null,
	key: string,
): number | null {
	if (!obj) return null
	const v = obj[key]
	return typeof v === "number" && Number.isFinite(v) ? v : null
}

function usdFromTicks(ticks: number | null): number | null {
	if (ticks == null || ticks < 0) return null
	return ticks / XAI_USD_TICKS_PER_DOLLAR
}

function usdFromDollarKeys(obj: Record<string, unknown> | null): number | null {
	if (!obj) return null
	for (const key of [
		"cost_usd",
		"costUsd",
		"total_cost",
		"totalCost",
		"cost",
	]) {
		const dollars = numField(obj, key)
		if (dollars != null && dollars >= 0) return dollars
	}
	return null
}

function usdFromUsageLike(usageLike: unknown): number | null {
	const usage = asRecord(usageLike)
	if (!usage) return null
	const raw = asRecord(usage.raw)
	const ticks =
		numField(raw, "cost_in_usd_ticks") ??
		numField(raw, "costInUsdTicks") ??
		numField(usage, "cost_in_usd_ticks") ??
		numField(usage, "costInUsdTicks")
	const fromTicks = usdFromTicks(ticks)
	if (fromTicks != null) return fromTicks
	return usdFromDollarKeys(raw) ?? usdFromDollarKeys(usage)
}

/**
 * Prefer provider-reported USD on usage.raw / providerMetadata / response.body.
 * @ai-sdk/xai puts cost_in_usd_ticks on response.body.usage for non-stream generateText.
 */
export function usdFromProviderResponse(args: {
	usage?: unknown
	providerMetadata?: unknown
	/** Raw HTTP/SDK response body (e.g. generateText().response.body). */
	responseBody?: unknown
}): number | null {
	const fromUsage = usdFromUsageLike(args.usage)
	if (fromUsage != null) return fromUsage

	const body = asRecord(args.responseBody)
	if (body) {
		const fromBodyUsage = usdFromUsageLike(body.usage)
		if (fromBodyUsage != null) return fromBodyUsage
		const bodyTicks =
			numField(body, "cost_in_usd_ticks") ?? numField(body, "costInUsdTicks")
		const fromBodyTicks = usdFromTicks(bodyTicks)
		if (fromBodyTicks != null) return fromBodyTicks
		const nested = asRecord(body.response)
		if (nested) {
			const nestedUsage = usdFromUsageLike(nested.usage)
			if (nestedUsage != null) return nestedUsage
		}
	}

	const meta = asRecord(args.providerMetadata)
	if (meta) {
		for (const provider of Object.values(meta)) {
			const p = asRecord(provider)
			const metaTicks =
				numField(p, "costInUsdTicks") ?? numField(p, "cost_in_usd_ticks")
			const fromMeta = usdFromTicks(metaTicks)
			if (fromMeta != null) return fromMeta
			const dollars = usdFromDollarKeys(p)
			if (dollars != null) return dollars
		}
	}

	return null
}

/** Pull response.body from generateText/streamText result shapes. */
export function responseBodyFromResult(result: {
	response?: { body?: unknown } | unknown
}): unknown {
	const response = result.response
	if (!response || typeof response !== "object") return undefined
	if ("body" in response) return (response as { body?: unknown }).body
	return response
}

export class BrainCostLedger {
	private readonly entries: BrainCostEntry[] = []

	/**
	 * Record cost from one generation.
	 * 1) Provider-reported $ when present (e.g. xAI ticks)
	 * 2) Else token × list rates for the configured model (Claude/GPT/etc.)
	 */
	recordFromGeneration(args: {
		model: string
		usage?: unknown
		providerMetadata?: unknown
		responseBody?: unknown
	}): void {
		const model = resolveBillableModel(args.model, args.model)
		const usage = asRecord(args.usage)
		const details = asRecord(usage?.inputTokenDetails)
		const outDetails = asRecord(usage?.outputTokenDetails)
		const tokens = {
			inputTokens: n(
				typeof usage?.inputTokens === "number" ? usage.inputTokens : null,
			),
			outputTokens: n(
				typeof usage?.outputTokens === "number" ? usage.outputTokens : null,
			),
			cacheReadTokens: n(
				typeof details?.cacheReadTokens === "number"
					? details.cacheReadTokens
					: null,
			),
			cacheWriteTokens: n(
				typeof outDetails?.cacheWriteTokens === "number"
					? outDetails.cacheWriteTokens
					: typeof details?.cacheWriteTokens === "number"
						? details.cacheWriteTokens
						: null,
			),
		}

		const fromProvider = usdFromProviderResponse({
			usage: args.usage,
			providerMetadata: args.providerMetadata,
			responseBody: args.responseBody,
		})

		const hasTokens =
			tokens.inputTokens > 0 ||
			tokens.outputTokens > 0 ||
			tokens.cacheReadTokens > 0 ||
			tokens.cacheWriteTokens > 0
		// Provider $ alone is enough (xAI may report cost without token fields).
		if (!hasTokens && (fromProvider == null || fromProvider <= 0)) return

		if (fromProvider != null && fromProvider >= 0) {
			this.entries.push({
				model,
				usage: tokens,
				usd: fromProvider,
				source: "provider",
			})
			return
		}

		const estimated = usdFromTokenUsage(model, tokens)
		if (estimated != null && estimated > 0) {
			this.entries.push({
				model,
				usage: tokens,
				usd: estimated,
				source: "estimate",
			})
			return
		}

		console.warn(
			`[company-brain-billing] no cost for model=${model} (tokens in=${tokens.inputTokens} out=${tokens.outputTokens})`,
		)
		this.entries.push({
			model,
			usage: tokens,
			usd: 0,
			source: "missing",
		})
	}

	/** Non-LLM vendor spend (per-request APIs) on the same ledger as model cost. */
	recordVendorUsd(label: string, usd: number): void {
		if (!(usd > 0) || !Number.isFinite(usd)) return
		this.entries.push({
			model: label,
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
			usd,
			source: "vendor",
		})
	}

	totalUsd(): number {
		return this.entries.reduce((sum, e) => sum + e.usd, 0)
	}

	breakdown(): BrainCostEntry[] {
		return this.entries.slice()
	}

	isEmpty(): boolean {
		return this.entries.length === 0
	}
}

/** Sum provider costs from streamText/generateText onFinish (prefer per-step). */
export function recordFinishEvent(
	ledger: BrainCostLedger,
	event: {
		steps?: Array<{
			model?: { modelId?: string; provider?: string }
			usage?: unknown
			providerMetadata?: unknown
			response?: { body?: unknown } | unknown
		}>
		usage?: unknown
		totalUsage?: unknown
		providerMetadata?: unknown
		response?: { body?: unknown } | unknown
	},
	fallbackModel: string,
): void {
	const steps = event.steps
	if (Array.isArray(steps) && steps.length > 0) {
		for (const step of steps) {
			ledger.recordFromGeneration({
				model: resolveBillableModel(step.model?.modelId, fallbackModel),
				usage: step.usage,
				providerMetadata: step.providerMetadata,
				responseBody: responseBodyFromResult(step),
			})
		}
		return
	}
	ledger.recordFromGeneration({
		model: resolveBillableModel(undefined, fallbackModel),
		usage: event.totalUsage ?? event.usage,
		providerMetadata: event.providerMetadata,
		responseBody: responseBodyFromResult(event),
	})
}

/**
 * Report what a turn cost. The hosted brain billed the org here; a self-hosted
 * one pays its provider directly, so the spend is only measured and logged.
 */
export async function chargeBrainLlmCost(params: {
	orgId: string
	ledger: BrainCostLedger
	source: string
	traceId?: string
	env?: Env
	chargedOps?: number
	skipBilling?: boolean
}): Promise<{ usd: number; ops: number; tracked: number; skipped?: string }> {
	const usd = params.ledger.totalUsd()
	if (!(usd > 0)) return { usd: 0, ops: 0, tracked: 0 }

	const breakdown = params.ledger
		.breakdown()
		.map(
			(e) =>
				`${e.model}:$${e.usd.toFixed(6)}[${e.source}](in=${e.usage.inputTokens},out=${e.usage.outputTokens})`,
		)
		.join(" ")
	console.log(
		`[company-brain-cost] source=${params.source} org=${params.orgId} trace=${params.traceId ?? "-"} usd=${usd.toFixed(6)} ${breakdown}`,
	)
	return { usd, ops: 0, tracked: 0 }
}

/**
 * Fire-and-forget charge for DO/Worker waitUntil.
 * Returns the real charge promise (with catch) so the isolate stays alive until
 * Autumn finishes. A separate timer only logs slowness — it does not settle
 * waitUntil early.
 */
export function scheduleChargeBrainLlmCost(params: {
	orgId: string
	ledger: BrainCostLedger
	source: string
	traceId?: string
	env?: Env
	chargedOps?: number
	skipBilling?: boolean
}): Promise<number> {
	return chargeBrainLlmCost(params)
		.then((result) => result.ops)
		.catch((err) => {
			console.warn(
				`[company-brain-cost] source=${params.source} org=${params.orgId} trace=${params.traceId ?? "-"} cost report failed:`,
				err instanceof Error ? err.message : err,
			)
			return 0
		})
}
