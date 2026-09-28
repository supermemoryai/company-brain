import { describe, expect, it } from "vitest"
import { DEFAULT_OPENROUTER_BASE_URL, openRouterBaseUrl } from "./openrouter-base-url"

describe("openRouterBaseUrl", () => {
	it("defaults to OpenRouter", () => {
		expect(openRouterBaseUrl()).toBe("https://openrouter.ai/api/v1")
		expect(openRouterBaseUrl({})).toBe(DEFAULT_OPENROUTER_BASE_URL)
	})

	it("honours overrides and trims trailing slashes", () => {
		expect(openRouterBaseUrl({ OPENROUTER_BASE_URL: "https://api.freerouter.com/v1" })).toBe(
			"https://api.freerouter.com/v1",
		)
		expect(openRouterBaseUrl({ OPENROUTER_BASE_URL: "https://api.freerouter.com/v1///" })).toBe(
			"https://api.freerouter.com/v1",
		)
	})

	it("ignores blank overrides", () => {
		expect(openRouterBaseUrl({ OPENROUTER_BASE_URL: "   " })).toBe(DEFAULT_OPENROUTER_BASE_URL)
	})
})
