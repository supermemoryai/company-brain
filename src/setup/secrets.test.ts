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
})
