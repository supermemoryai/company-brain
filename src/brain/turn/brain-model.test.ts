import { afterEach, describe, expect, it } from "vitest"
import {
	availableProviders,
	brainProviderModel,
	getBrainModel,
	openRouterModelId,
} from "./brain-model"

function envWith(keys: Partial<Env>): Env {
	return keys as Env
}

type ModelShape = { provider: string; modelId: string }

const realFetch = globalThis.fetch
afterEach(() => {
	globalThis.fetch = realFetch
})

describe("OpenRouter routing", () => {
	it("names models the way OpenRouter does", () => {
		expect(openRouterModelId("claude-sonnet-5")).toBe(
			"anthropic/claude-sonnet-5",
		)
		expect(openRouterModelId("gpt-5.6")).toBe("openai/gpt-5.6")
		expect(openRouterModelId("grok-4.5")).toBe("x-ai/grok-4.5")
		expect(openRouterModelId("gemini-3.1-pro-preview")).toBe(
			"google/gemini-3.1-pro-preview",
		)
		// Compatibility aliases resolve to the model they stand for.
		expect(openRouterModelId("gemini-2.5-pro")).toBe(
			"google/gemini-3.1-pro-preview",
		)
	})

	it("reaches every provider with only an OpenRouter key", () => {
		const env = envWith({ OPENROUTER_API_KEY: "sk-or-v1-abc" })
		expect(availableProviders(env)).toEqual([
			"anthropic",
			"openai",
			"google",
			"xai",
		])
	})

	it("reaches nothing without any key", () => {
		expect(availableProviders(envWith({}))).toEqual([])
		expect(() => getBrainModel("grok-4.5", envWith({}))).toThrow(
			/OpenRouter/,
		)
	})

	it("sends a model through OpenRouter when its provider has no key", () => {
		const env = envWith({ OPENROUTER_API_KEY: "sk-or-v1-abc" })
		const model = getBrainModel("grok-4.5", env) as unknown as ModelShape
		expect(model.provider).toMatch(/^openrouter/)
		expect(model.modelId).toBe("x-ai/grok-4.5")
	})

	it("keeps the requested model instead of falling back to another provider", () => {
		const env = envWith({
			ANTHROPIC_API_KEY: "sk-ant-abc",
			OPENROUTER_API_KEY: "sk-or-v1-abc",
		})
		const model = getBrainModel("gpt-5.6", env) as unknown as ModelShape
		expect(model.modelId).toBe("openai/gpt-5.6")
	})

	it("prefers a provider's own key over OpenRouter", () => {
		const env = envWith({
			ANTHROPIC_API_KEY: "sk-ant-abc",
			OPENROUTER_API_KEY: "sk-or-v1-abc",
		})
		const model = brainProviderModel(
			"claude-sonnet-5",
			env,
		) as unknown as ModelShape
		expect(model.provider).toMatch(/^anthropic/)
		expect(model.modelId).toBe("claude-sonnet-5")
	})

	it("calls OpenRouter's chat completions API with the OpenRouter key", async () => {
		const requests: { url: string; headers: Headers; body: unknown }[] = []
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({
				url: String(input),
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)),
			})
			return new Response(
				JSON.stringify({
					id: "gen-1",
					created: 0,
					model: "x-ai/grok-4.5",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "hi" },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}),
				{ headers: { "content-type": "application/json" } },
			)
		}) as typeof fetch
		const env = envWith({ OPENROUTER_API_KEY: "sk-or-v1-abc" })
		const model = getBrainModel("grok-4.5", env) as unknown as {
			doGenerate: (options: unknown) => Promise<unknown>
		}
		await model.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
		})
		expect(requests).toHaveLength(1)
		const [request] = requests
		expect(request?.url).toBe("https://openrouter.ai/api/v1/chat/completions")
		expect(request?.headers.get("authorization")).toBe("Bearer sk-or-v1-abc")
		expect(request?.headers.get("x-title")).toBe("Company Brain")
		expect((request?.body as { model: string }).model).toBe("x-ai/grok-4.5")
	})

	it("leaves AI Gateway calls on the provider's own API", () => {
		const env = envWith({ OPENROUTER_API_KEY: "sk-or-v1-abc" })
		const model = brainProviderModel(
			"claude-sonnet-5",
			env,
			"CF_TEMP_TOKEN",
		) as unknown as ModelShape
		expect(model.provider).toMatch(/^anthropic/)
	})
})
