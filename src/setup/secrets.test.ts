import { describe, expect, it } from "vitest"
import { providerForModelKey } from "./secrets"

describe("providerForModelKey", () => {
	it("tells providers apart by key prefix", () => {
		expect(providerForModelKey("sk-ant-api03-abc")).toBe("anthropic")
		expect(providerForModelKey("sk-proj-abc")).toBe("openai")
		expect(providerForModelKey("sk-abc")).toBe("openai")
		expect(providerForModelKey("AIzaSyAbc")).toBe("google")
		expect(providerForModelKey("xai-abc")).toBe("xai")
		expect(providerForModelKey("something-else")).toBeNull()
	})

	it("reads an OrcaRouter key as OrcaRouter, never as OpenAI or OpenRouter", () => {
		expect(providerForModelKey("sk-orca-testonly-0000")).toBe("orcarouter")
		// Order matters: `sk-or-` must not swallow `sk-orca-`.
		expect(providerForModelKey("sk-or-v1-abc")).toBe("openrouter")
	})
})
