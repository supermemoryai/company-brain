import { describe, expect, it } from "vitest"
import {
	fetchOrcaCatalogModels,
	filterOrcaModels,
	orcaCatalogFor,
	orcaCatalogCacheKey,
	ORCA_CAPABILITY_QUERIES,
	orcaModelStillCompatible,
	parseOrcaCatalogModel,
	verifiedOrcaSeedModels,
	type OrcaCatalogCache,
	type OrcaCatalogModel,
} from "./orcarouter-models"

/**
 * Shapes taken from `GET https://api.orcarouter.ai/v1/models` on 2026-09-28.
 * Every capability the catalog advertises is represented here.
 */
const FIXTURE = {
	data: [
		{
			id: "openai/gpt-5.5",
			name: "OpenAI: GPT-5.5",
			context_length: 272000,
			max_completion_tokens: 128000,
			supported_endpoint_types: ["openai", "openai-response"],
			architecture: { input_modalities: ["file", "image", "text"] },
		},
		{
			id: "deepseek/deepseek-v4-pro",
			name: "DeepSeek: DeepSeek V4 Pro",
			context_length: 1048576,
			supported_endpoint_types: ["openai", "openai-response"],
			architecture: { input_modalities: ["text"] },
		},
		{
			id: "google/gemini-3.5-flash",
			name: "Google: Gemini 3.5 Flash",
			supported_endpoint_types: ["openai", "gemini"],
			architecture: {
				input_modalities: ["text", "image", "video", "file", "audio"],
			},
		},
		{
			// No architecture block at all: capabilities are unknown, so it must
			// not be offered for a multimodal surface.
			id: "orcarouter/fusion",
			name: "OrcaRouter: Fusion",
			supported_endpoint_types: ["openai", "openai-response", "anthropic", "gemini"],
		},
		{
			id: "openai/gpt-image-1.5",
			name: "OpenAI: GPT Image 1.5",
			supported_endpoint_types: ["image-generation"],
			architecture: { input_modalities: ["text", "image"] },
		},
		{
			id: "kling/kling-v3",
			name: "Kling: v3",
			supported_endpoint_types: ["openai-video"],
		},
		{
			id: "openai/text-embedding-3-large",
			name: "OpenAI: Text Embedding 3 Large",
			supported_endpoint_types: ["embeddings"],
			architecture: { input_modalities: ["text"] },
		},
		{
			id: "jina/jina-reranker-v3",
			name: "Jina: Reranker v3",
			supported_endpoint_types: ["jina-rerank"],
		},
	],
}

function parsed(): OrcaCatalogModel[] {
	return (FIXTURE.data as unknown[])
		.map((entry) => parseOrcaCatalogModel(entry))
		.filter((model): model is OrcaCatalogModel => model !== null)
}

describe("catalog parsing", () => {
	it("keeps the vendor/model namespace exactly as returned", () => {
		const ids = parsed().map((model) => model.id)
		expect(ids).toContain("openai/gpt-5.5")
		expect(ids).toContain("deepseek/deepseek-v4-pro")
		expect(ids.every((id) => id.includes("/"))).toBe(true)
	})

	it("keeps context and input modalities", () => {
		const gpt = parsed().find((model) => model.id === "openai/gpt-5.5")
		expect(gpt?.contextLength).toBe(272000)
		expect(gpt?.maxCompletionTokens).toBe(128000)
		expect(gpt?.inputModalities).toEqual(["file", "image", "text"])
	})

	it("drops records it cannot represent rather than throwing", () => {
		expect(parseOrcaCatalogModel(null)).toBeNull()
		expect(parseOrcaCatalogModel({})).toBeNull()
		expect(parseOrcaCatalogModel({ id: "   " })).toBeNull()
		expect(parseOrcaCatalogModel({ id: "x/y" })).toMatchObject({
			id: "x/y",
			name: "x/y",
			endpointTypes: [],
			inputModalities: [],
		})
	})
})

describe("capability filtering", () => {
	it("offers only chat endpoints for text chat, excluding non-text models", () => {
		const ids = filterOrcaModels(parsed(), ORCA_CAPABILITY_QUERIES.chat).map(
			(model) => model.id,
		)
		expect(ids).toContain("deepseek/deepseek-v4-pro")
		expect(ids).toContain("openai/gpt-5.5")
		// Image generation, video, embeddings and rerank records are not chat.
		expect(ids).not.toContain("openai/gpt-image-1.5")
		expect(ids).not.toContain("kling/kling-v3")
		expect(ids).not.toContain("openai/text-embedding-3-large")
		expect(ids).not.toContain("jina/jina-reranker-v3")
	})

	it("fails closed on multimodal: only models declaring image input", () => {
		const ids = filterOrcaModels(
			parsed(),
			ORCA_CAPABILITY_QUERIES["chat-multimodal"],
		).map((model) => model.id)
		expect(ids).toContain("openai/gpt-5.5")
		expect(ids).toContain("google/gemini-3.5-flash")
		// Text-only chat models are gone.
		expect(ids).not.toContain("deepseek/deepseek-v4-pro")
		// And so is a chat model that declares no modalities at all.
		expect(ids).not.toContain("orcarouter/fusion")
		// A non-chat model that happens to declare image input stays out.
		expect(ids).not.toContain("openai/gpt-image-1.5")
	})

	it("matches each remaining capability to its own endpoint", () => {
		expect(
			filterOrcaModels(parsed(), ORCA_CAPABILITY_QUERIES.embedding).map((m) => m.id),
		).toEqual(["openai/text-embedding-3-large"])
		expect(
			filterOrcaModels(parsed(), ORCA_CAPABILITY_QUERIES.image).map((m) => m.id),
		).toEqual(["openai/gpt-image-1.5"])
		expect(
			filterOrcaModels(parsed(), ORCA_CAPABILITY_QUERIES.video).map((m) => m.id),
		).toEqual(["kling/kling-v3"])
		expect(
			filterOrcaModels(parsed(), ORCA_CAPABILITY_QUERIES.rerank).map((m) => m.id),
		).toEqual(["jina/jina-reranker-v3"])
	})

	it("does not read capability from a model's name", () => {
		// A record named like an embedding model but advertising a chat endpoint
		// is a chat model; the filter never guesses from the id.
		const decoy: OrcaCatalogModel = {
			id: "acme/text-embedding-9",
			name: "Acme Embedding",
			endpointTypes: ["openai"],
			inputModalities: ["text"],
		}
		expect(filterOrcaModels([decoy], ORCA_CAPABILITY_QUERIES.chat)).toHaveLength(1)
		expect(
			filterOrcaModels([decoy], ORCA_CAPABILITY_QUERIES.embedding),
		).toHaveLength(0)
	})

	it("knows when a saved model is no longer compatible", () => {
		const models = parsed()
		expect(
			orcaModelStillCompatible(
				models,
				"openai/gpt-5.5",
				ORCA_CAPABILITY_QUERIES["chat-multimodal"],
			),
		).toBe(true)
		expect(
			orcaModelStillCompatible(
				models,
				"deepseek/deepseek-v4-pro",
				ORCA_CAPABILITY_QUERIES["chat-multimodal"],
			),
		).toBe(false)
	})
})

describe("bounded fetch", () => {
	const env = {}

	it("asks the inference origin's catalog with the credential", async () => {
		let seen: { url: string; auth: string | null } | null = null
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			seen = {
				url: String(input),
				auth: new Headers(init?.headers).get("Authorization"),
			}
			return new Response(JSON.stringify(FIXTURE), { status: 200 })
		}) as typeof fetch
		const result = await fetchOrcaCatalogModels(
			env,
			"sk-orca-testonly",
			"chat",
			fetchImpl,
		)
		expect(result.ok).toBe(true)
		expect(seen!.url).toBe("https://api.orcarouter.ai/v1/models?capability=chat")
		expect(seen!.auth).toBe("Bearer sk-orca-testonly")
	})

	it("classifies auth, rate limit, malformed and network failures", async () => {
		const respond = (status: number, body: string) =>
			(async () => new Response(body, { status })) as typeof fetch
		expect(await fetchOrcaCatalogModels(env, "k", "chat", respond(401, ""))).toEqual({
			ok: false,
			reason: "auth",
			status: 401,
		})
		expect(await fetchOrcaCatalogModels(env, "k", "chat", respond(429, ""))).toEqual({
			ok: false,
			reason: "rate_limited",
			status: 429,
		})
		expect(
			await fetchOrcaCatalogModels(env, "k", "chat", respond(200, "not json")),
		).toMatchObject({ ok: false, reason: "malformed" })
		expect(
			await fetchOrcaCatalogModels(env, "k", "chat", respond(200, '{"nope":1}')),
		).toMatchObject({ ok: false, reason: "malformed" })
		const boom = (async () => {
			throw new TypeError("fetch failed")
		}) as typeof fetch
		expect(await fetchOrcaCatalogModels(env, "k", "chat", boom)).toEqual({
			ok: false,
			reason: "network",
		})
	})

	it("drops unusable records instead of failing the whole catalog", async () => {
		const fetchImpl = (async () =>
			new Response(
				JSON.stringify({
					data: [null, 7, { id: "" }, FIXTURE.data[0]],
				}),
				{ status: 200 },
			)) as typeof fetch
		const result = await fetchOrcaCatalogModels(env, "k", "chat", fetchImpl)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.models.map((m) => m.id)).toEqual(["openai/gpt-5.5"])
	})

	it("bounds the item count", async () => {
		const many = Array.from({ length: 2_500 }, (_, index) => ({
			id: `vendor/model-${index}`,
			supported_endpoint_types: ["openai"],
			architecture: { input_modalities: ["text"] },
		}))
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ data: many }), { status: 200 })) as typeof fetch
		const result = await fetchOrcaCatalogModels(env, "k", "chat", fetchImpl)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.models.length).toBe(2_000)
	})
})

describe("live catalog with a fallback", () => {
	const env = {}

	it("treats a successful live list as authoritative and excludes the seed", async () => {
		const fetchImpl = (async () =>
			new Response(JSON.stringify(FIXTURE), { status: 200 })) as typeof fetch
		const catalog = await orcaCatalogFor(env, "chat", {
			apiKey: "sk-orca-testonly",
			fetchImpl,
		})
		expect(catalog.source).toBe("live")
		expect(catalog.degradedReason).toBeUndefined()
		const ids = catalog.models.map((model) => model.id)
		expect(ids).toContain("openai/gpt-5.5")
		// A seed model the live list did not return must not be mixed in.
		expect(ids).not.toContain("anthropic/claude-opus-4.8")
		expect(ids).not.toContain("orcarouter/auto")
	})

	it("falls back to the verified seed when discovery fails, never to free text", async () => {
		const boom = (async () => {
			throw new TypeError("fetch failed")
		}) as typeof fetch
		const catalog = await orcaCatalogFor(env, "chat", {
			apiKey: "sk-orca-testonly",
			fetchImpl: boom,
		})
		expect(catalog.source).toBe("seed")
		expect(catalog.degradedReason).toBe("network")
		const ids = catalog.models.map((model) => model.id)
		expect(ids).toEqual([
			"openai/gpt-5.5",
			"anthropic/claude-opus-4.8",
			"google/gemini-3.5-flash",
			"deepseek/deepseek-v4-pro",
			"orcarouter/auto",
		])
	})

	it("keeps verified reasoning metadata on the seed", () => {
		const gpt = verifiedOrcaSeedModels("chat").find(
			(model) => model.id === "openai/gpt-5.5",
		)
		expect(gpt?.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh"])
		expect(gpt?.contextLength).toBe(272_000)
		expect(gpt?.inputModalities).toContain("image")
	})

	it("replays the last known-good live list before the seed", async () => {
		const store = new Map<string, string>()
		const cache: OrcaCatalogCache = {
			async get(key) {
				return store.get(key) ?? null
			},
			async put(key, value) {
				store.set(key, value)
			},
		}
		const live = (async () =>
			new Response(JSON.stringify(FIXTURE), { status: 200 })) as typeof fetch
		await orcaCatalogFor(env, "chat", { apiKey: "sk-orca-testonly", fetchImpl: live, cache })
		expect(store.has(orcaCatalogCacheKey(env, "chat"))).toBe(true)

		const boom = (async () => {
			throw new TypeError("fetch failed")
		}) as typeof fetch
		const catalog = await orcaCatalogFor(env, "chat", {
			apiKey: "sk-orca-testonly",
			fetchImpl: boom,
			cache,
		})
		// The live list, not the seed, and it is flagged as degraded.
		expect(catalog.source).toBe("live")
		expect(catalog.degradedReason).toBe("network")
		expect(catalog.models.map((m) => m.id)).toContain("openai/gpt-5.5")
	})

	it("scopes the cache key to the origin so origins cannot cross-contaminate", () => {
		const a = orcaCatalogCacheKey({}, "chat")
		const b = orcaCatalogCacheKey(
			{ ORCA_API_BASE_URL: "https://self-hosted.example/v1" },
			"chat",
		)
		expect(a).not.toBe(b)
		expect(a).toContain("https://api.orcarouter.ai/v1")
	})

	it("serves the seed without a credential, since the catalog needs one", async () => {
		const catalog = await orcaCatalogFor({}, "chat")
		expect(catalog.source).toBe("seed")
		expect(catalog.models.length).toBeGreaterThan(0)
	})
})
