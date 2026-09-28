/**
 * OrcaRouter model discovery.
 *
 * The single source of truth for the model list is `GET /v1/models` on the
 * configured inference origin (`https://api.orcarouter.ai/v1` by default),
 * asked with one of the `?capability=` values the relay understands. Model ids
 * keep their `vendor/model` namespace exactly as returned.
 *
 * The dropdowns a user picks from are built from the live catalog. A small
 * verified seed keeps a fresh install usable while the catalog is unreachable,
 * is only ever used when discovery failed, and never mixes into a successful
 * live result.
 */

import {
	orcaApiBaseUrl,
	orcaModelsUrl,
	type OrcaBaseUrlEnv,
} from "./orca-base-url"

/** Endpoint types this client can actually speak for a text chat request. */
const CHAT_ENDPOINT_TYPES = [
	"openai",
	"anthropic",
	"gemini",
	"openai-response",
] as const

/**
 * Endpoint types that mean the record is for something other than chat.
 * `GET /v1/models` closing the boolean indeed keeps these out of today's
 * catalog, but a record advertising one alongside a chat endpoint is still
 * not a text-chat model, so the filter is explicit rather than incidental.
 */
const NON_CHAT_ENDPOINT_TYPES = [
	"image-generation",
	"openai-video",
	"jina-rerank",
	"embeddings",
	"audio",
	"transcription",
] as const

export const ORCA_CATALOG_TIMEOUT_MS = 10_000
export const ORCA_CATALOG_MAX_BYTES = 2 * 1024 * 1024
export const ORCA_CATALOG_MAX_ITEMS = 2_000
/** Bounds a stored catalog replayed from cache. */
export const ORCA_CACHE_TTL_SECONDS = 300

export type OrcaCatalogCapability =
	| "chat"
	| "embedding"
	| "image"
	| "video"
	| "rerank"

/** Input modalities Company Brain can actually upload. */
export type OrcaInputModality = "text" | "image" | "file" | "audio" | "video"

export type OrcaCatalogModel = {
	id: string
	name: string
	contextLength?: number
	maxCompletionTokens?: number
	endpointTypes: string[]
	inputModalities: OrcaInputModality[]
}

export type OrcaCatalog = {
	/** Capability the catalog was fetched for. */
	capability: OrcaCatalogCapability
	/** Where the list came from, so the UI can say if it is degraded. */
	source: "live" | "seed"
	models: OrcaCatalogModel[]
	/** Populated when the live fetch failed and a seed was used. */
	degradedReason?: "auth" | "network" | "timeout" | "malformed" | "rate_limited"
	/** Upstream HTTP status when the failure was an HTTP one. */
	status?: number
}

/** What each surface asks the catalog for, and what it then accepts. */
export type OrcaCapabilityQuery = {
	capability: OrcaCatalogCapability
	/** Endpoint types the client can speak, or null for no requirement. */
	endpointTypes: readonly string[] | null
	/** Input modalities that must be declared, or null for no requirement. */
	inputModalities: readonly OrcaInputModality[] | null
}

export const ORCA_CAPABILITY_QUERIES: Record<
	"chat" | "chat-multimodal" | "embedding" | "image" | "video" | "rerank",
	OrcaCapabilityQuery
> = {
	// Text chat and agent: a chat endpoint, and nothing non-text in the record.
	chat: {
		capability: "chat",
		endpointTypes: CHAT_ENDPOINT_TYPES,
		inputModalities: null,
	},
	// Chat that must accept an image the user uploaded. Fail closed: a record
	// that does not declare image input is not offered.
	"chat-multimodal": {
		capability: "chat",
		endpointTypes: CHAT_ENDPOINT_TYPES,
		inputModalities: ["image"],
	},
	embedding: {
		capability: "embedding",
		endpointTypes: ["embeddings"],
		inputModalities: null,
	},
	image: {
		capability: "image",
		endpointTypes: ["image-generation"],
		inputModalities: null,
	},
	video: {
		capability: "video",
		endpointTypes: ["openai-video"],
		inputModalities: null,
	},
	rerank: {
		capability: "rerank",
		endpointTypes: ["jina-rerank"],
		inputModalities: null,
	},
}

function readStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return []
	return value.filter((item): item is string => typeof item === "string")
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: undefined
}

/**
 * One catalog record. Returns null for anything the client cannot represent,
 * so a malformed entry narrows the list instead of throwing.
 */
export function parseOrcaCatalogModel(raw: unknown): OrcaCatalogModel | null {
	if (typeof raw !== "object" || raw === null) return null
	const record = raw as Record<string, unknown>
	const id = typeof record.id === "string" ? record.id.trim() : ""
	if (!id) return null
	// Keep the vendor/model namespace exactly as the relay returned it.
	const architecture =
		typeof record.architecture === "object" && record.architecture !== null
			? (record.architecture as Record<string, unknown>)
			: {}
	const name =
		typeof record.name === "string" && record.name.trim()
			? record.name.trim()
			: id
	const topProvider =
		typeof record.top_provider === "object" && record.top_provider !== null
			? (record.top_provider as Record<string, unknown>)
			: {}
	return {
		id,
		name,
		contextLength: positiveInt(record.context_length),
		maxCompletionTokens: positiveInt(
			record.max_completion_tokens ?? topProvider.max_completion_tokens,
		),
		// Accept the normalized names too, so a catalog this module cached can be
		// read back without losing the fields the filters depend on.
		endpointTypes: readStringArray(
			record.supported_endpoint_types ?? record.endpointTypes,
		),
		inputModalities: readStringArray(
			architecture.input_modalities ?? record.inputModalities,
		) as OrcaInputModality[],
	}
}

/**
 * Does this record satisfy the surface's capability query? Everything is
 * fail-closed: a record that does not declare the endpoint or the input
 * modality is left out rather than offered on the strength of its name.
 */
export function orcaModelMatches(
	model: OrcaCatalogModel,
	query: OrcaCapabilityQuery,
): boolean {
	if (query.endpointTypes) {
		const endpoints = new Set(model.endpointTypes)
		const speaksOne = query.endpointTypes.some((type) => endpoints.has(type))
		if (!speaksOne) return false
		// A record that also declares a non-chat endpoint is not a chat model.
		if (query.capability === "chat") {
			if (NON_CHAT_ENDPOINT_TYPES.some((type) => endpoints.has(type))) {
				return false
			}
		}
	}
	if (query.inputModalities) {
		const declared = new Set(model.inputModalities)
		if (!query.inputModalities.every((modality) => declared.has(modality))) {
			return false
		}
	}
	return true
}

export function filterOrcaModels(
	models: readonly OrcaCatalogModel[],
	query: OrcaCapabilityQuery,
): OrcaCatalogModel[] {
	return models.filter((model) => orcaModelMatches(model, query))
}

/**
 * Is a previously chosen model still offered by the current list? Used before
 * restoring a saved id, so a model that lost the capability is cleared instead
 * of silently kept.
 */
export function orcaModelStillCompatible(
	models: readonly OrcaCatalogModel[],
	id: string,
	query: OrcaCapabilityQuery,
): boolean {
	return filterOrcaModels(models, query).some((model) => model.id === id)
}

export type OrcaCatalogFetchResult =
	| { ok: true; models: OrcaCatalogModel[] }
	| {
			ok: false
			reason: OrcaCatalog["degradedReason"]
			status?: number
	  }

function failureReason(status: number): OrcaCatalog["degradedReason"] {
	if (status === 401 || status === 403) return "auth"
	if (status === 429) return "rate_limited"
	return "network"
}

/**
 * Fetch one capability's catalog. Bounded in time, bytes and item count so a
 * hostile or broken response cannot exhaust the worker.
 */
export async function fetchOrcaCatalogModels(
	env: OrcaBaseUrlEnv,
	apiKey: string,
	capability: OrcaCatalogCapability,
	fetchImpl: typeof fetch = fetch,
): Promise<OrcaCatalogFetchResult> {
	let response: Response
	try {
		response = await fetchImpl(orcaModelsUrl(env, capability), {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(ORCA_CATALOG_TIMEOUT_MS),
		})
	} catch (error) {
		const name =
			error instanceof Error ? error.name : ""
		const aborted =
			name === "TimeoutError" || name === "AbortError"
		return { ok: false, reason: aborted ? "timeout" : "network" }
	}
	if (!response.ok) {
		return { ok: false, reason: failureReason(response.status), status: response.status }
	}
	let text: string
	try {
		text = await response.text()
	} catch {
		return { ok: false, reason: "network", status: response.status }
	}
	if (text.length > ORCA_CATALOG_MAX_BYTES) {
		return { ok: false, reason: "malformed", status: response.status }
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return { ok: false, reason: "malformed", status: response.status }
	}
	const data =
		typeof parsed === "object" && parsed !== null && "data" in parsed
			? (parsed as { data: unknown }).data
			: undefined
	if (!Array.isArray(data)) {
		return { ok: false, reason: "malformed", status: response.status }
	}
	const models: OrcaCatalogModel[] = []
	for (const entry of data.slice(0, ORCA_CATALOG_MAX_ITEMS)) {
		const model = parseOrcaCatalogModel(entry)
		if (model) models.push(model)
	}
	return { ok: true, models }
}

/** Cache key for one capability's live catalog on the configured origins. */
export function orcaCatalogCacheKey(
	env: OrcaBaseUrlEnv,
	capability: OrcaCatalogCapability,
): string {
	// Origin-scoped so flipping a test or self-hosted origin cannot serve
	// another deployment's catalog.
	return `orca:catalog:${orcaApiBaseUrl(env)}:${capability}`
}

export type OrcaCatalogOptions = {
	/** Credential to read the catalog with, when the deployment has one. */
	apiKey?: string
	fetchImpl?: typeof fetch
	/** Read/write hook for the last known-good catalog. */
	cache?: OrcaCatalogCache
}

export type OrcaCatalogCache = {
	get(key: string): Promise<string | null>
	put(key: string, value: string, ttlSeconds: number): Promise<void>
}

/**
 * Catalog for a surface, preferring live discovery. On success the live list
 * is authoritative and the seed is not consulted. On failure the last known
 * good live list is used if one was cached, then the verified seed.
 */
export async function orcaCatalogFor(
	env: OrcaBaseUrlEnv,
	surface: keyof typeof ORCA_CAPABILITY_QUERIES,
	options: OrcaCatalogOptions = {},
): Promise<OrcaCatalog> {
	const query = ORCA_CAPABILITY_QUERIES[surface]
	const apiKey = options.apiKey?.trim()
	if (apiKey) {
		const result = await fetchOrcaCatalogModels(
			env,
			apiKey,
			query.capability,
			options.fetchImpl ?? fetch,
		)
		if (result.ok) {
			const models = filterOrcaModels(result.models, query)
			await cacheCatalog(env, query.capability, models, options.cache)
			return { capability: query.capability, source: "live", models }
		}
		const cached = await readCachedCatalog(env, query.capability, options.cache)
		if (cached) {
			return {
				capability: query.capability,
				source: "live",
				models: filterOrcaModels(cached, query),
				degradedReason: result.reason,
				status: result.status,
			}
		}
		return {
			capability: query.capability,
			source: "seed",
			models: filterOrcaModels(
				verifiedOrcaSeedModels(query.capability),
				query,
			),
			degradedReason: result.reason,
			status: result.status,
		}
	}
	// No credential: the relay's catalog needs one, so serve the verified seed,
	// or the last known-good list when this deployment cached one. Either way it
	// cannot be refreshed right now, so a cached list stays flagged as degraded.
	const cached = await readCachedCatalog(env, query.capability, options.cache)
	return {
		capability: query.capability,
		source: cached ? "live" : "seed",
		models: filterOrcaModels(
			cached ?? verifiedOrcaSeedModels(query.capability),
			query,
		),
		degradedReason: cached ? "auth" : undefined,
	}
}

async function cacheCatalog(
	env: OrcaBaseUrlEnv,
	capability: OrcaCatalogCapability,
	models: readonly OrcaCatalogModel[],
	cache: OrcaCatalogCache | undefined,
): Promise<void> {
	if (!cache) return
	try {
		await cache.put(
			orcaCatalogCacheKey(env, capability),
			JSON.stringify(models.slice(0, ORCA_CATALOG_MAX_ITEMS)),
			ORCA_CACHE_TTL_SECONDS,
		)
	} catch {
		// A cache write must never fail the catalog read.
	}
}

async function readCachedCatalog(
	env: OrcaBaseUrlEnv,
	capability: OrcaCatalogCapability,
	cache: OrcaCatalogCache | undefined,
): Promise<OrcaCatalogModel[] | null> {
	if (!cache) return null
	try {
		const raw = await cache.get(orcaCatalogCacheKey(env, capability))
		if (!raw) return null
		const parsed: unknown = JSON.parse(raw)
		if (!Array.isArray(parsed)) return null
		const models: OrcaCatalogModel[] = []
		for (const entry of parsed.slice(0, ORCA_CATALOG_MAX_ITEMS)) {
			const model = parseOrcaCatalogModel(entry)
			if (model) models.push(model)
		}
		return models.length ? models : null
	} catch {
		return null
	}
}

/**
 * Verified cold-start seed, checked against `GET https://api.orcarouter.ai/v1/models`
 * on 2026-09-28. It exists so a fresh deployment whose catalog call failed still
 * has a usable list; it is never merged into a successful live result.
 *
 * Every entry was observed in the relay's own catalog. `orcarouter/auto` is the
 * exception: it is workspace-scoped, so it is absent from the unauthenticated
 * catalog and only appears once a key is presented. It is kept because the
 * authenticated listing is what this deployment actually calls.
 *
 * Reasoning metadata lives here because the relay's catalog does not carry it:
 * `openai/gpt-5.5` is advertised with reasoning, so the verified low/medium/
 * high/xhigh ladder is preserved.
 */
export const ORCA_VERIFIED_SEED_TIMESTAMP = "2026-09-28"

export type OrcaSeedModel = OrcaCatalogModel & {
	reasoningEfforts?: readonly string[]
}

const SEED_MODELS: readonly OrcaSeedModel[] = [
	{
		id: "openai/gpt-5.5",
		name: "OpenAI: GPT-5.5",
		contextLength: 272_000,
		maxCompletionTokens: 128_000,
		endpointTypes: ["openai", "openai-response"],
		inputModalities: ["text", "image", "file"],
		reasoningEfforts: ["low", "medium", "high", "xhigh"],
	},
	{
		id: "anthropic/claude-opus-4.8",
		name: "Anthropic: Claude Opus 4.8",
		contextLength: 1_000_000,
		maxCompletionTokens: 128_000,
		endpointTypes: ["openai", "anthropic", "openai-response"],
		inputModalities: ["text", "image", "file"],
		reasoningEfforts: ["low", "medium", "high", "xhigh"],
	},
	{
		id: "google/gemini-3.5-flash",
		name: "Google: Gemini 3.5 Flash",
		contextLength: 1_048_576,
		maxCompletionTokens: 65_536,
		endpointTypes: ["openai", "gemini"],
		inputModalities: ["text", "image", "video", "file", "audio"],
		reasoningEfforts: ["low", "medium", "high"],
	},
	{
		id: "deepseek/deepseek-v4-pro",
		name: "DeepSeek: DeepSeek V4 Pro",
		contextLength: 1_048_576,
		maxCompletionTokens: 384_000,
		endpointTypes: ["openai", "openai-response"],
		inputModalities: ["text"],
		reasoningEfforts: ["low", "medium", "high"],
	},
	{
		id: "orcarouter/auto",
		name: "OrcaRouter: Auto",
		endpointTypes: ["openai", "openai-response", "anthropic", "gemini"],
		inputModalities: ["text"],
	},
]

/** The verified seed, optionally narrowed to one capability. */
export function verifiedOrcaSeedModels(
	capability?: OrcaCatalogCapability,
): OrcaSeedModel[] {
	if (!capability) return [...SEED_MODELS]
	return SEED_MODELS.filter((model) =>
		capability === "chat"
			? model.endpointTypes.some((type) =>
					(CHAT_ENDPOINT_TYPES as readonly string[]).includes(type),
				) &&
				!NON_CHAT_ENDPOINT_TYPES.some((type) =>
					model.endpointTypes.includes(type),
				)
			: model.endpointTypes.includes(
					capability === "embedding"
						? "embeddings"
						: capability === "image"
							? "image-generation"
							: capability === "video"
								? "openai-video"
								: "jina-rerank",
				),
	)
}

export function orcaSeedReasoningEfforts(
	id: string,
): readonly string[] | undefined {
	return SEED_MODELS.find((model) => model.id === id)?.reasoningEfforts
}
