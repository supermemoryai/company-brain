import { describe, expect, it } from "vitest"
import { hydrateSecrets, providerForModelKey } from "./secrets"

describe("providerForModelKey", () => {
	it("tells providers apart by key prefix", () => {
		expect(providerForModelKey("sk-ant-api03-abc")).toBe("anthropic")
		expect(providerForModelKey("sk-proj-abc")).toBe("openai")
		expect(providerForModelKey("sk-abc")).toBe("openai")
		expect(providerForModelKey("AIzaSyAbc")).toBe("google")
		expect(providerForModelKey("xai-abc")).toBe("xai")
		expect(providerForModelKey("sk-or-v1-abc")).toBe("openrouter")
		expect(providerForModelKey("something-else")).toBeNull()
	})
})

describe("hydrateSecrets", () => {
	const kv = {
		get: async () => "stored",
		put: async () => {},
	} as unknown as KVNamespace

	it("puts an OpenRouter MODEL_API_KEY on OPENROUTER_API_KEY, not OpenAI", async () => {
		const env = { MODEL_API_KEY: "sk-or-v1-abc", BRAIN_KV: kv } as unknown as Env
		await hydrateSecrets(env)
		expect(env.OPENROUTER_API_KEY).toBe("sk-or-v1-abc")
		expect(env.OPENAI_API_KEY).toBeUndefined()
	})

	it("keeps an explicitly set OPENROUTER_API_KEY", async () => {
		const env = {
			MODEL_API_KEY: "sk-or-v1-abc",
			OPENROUTER_API_KEY: "sk-or-v1-explicit",
			BRAIN_KV: kv,
		} as unknown as Env
		await hydrateSecrets(env)
		expect(env.OPENROUTER_API_KEY).toBe("sk-or-v1-explicit")
	})
})
