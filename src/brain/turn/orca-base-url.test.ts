import { describe, expect, it } from "vitest"
import {
	DEFAULT_ORCA_API_BASE_URL,
	DEFAULT_ORCA_AUTH_BASE_URL,
	isSecureOrcaOrigin,
	OrcaOriginError,
	orcaApiBaseUrl,
	orcaAuthBaseUrl,
	orcaAuthorizeUrl,
	orcaDeviceCodeUrl,
	orcaDeviceTokenUrl,
	orcaExchangeUrl,
	orcaModelsUrl,
} from "./orca-base-url"

describe("OrcaRouter origins", () => {
	it("defaults auth and inference to different public origins", () => {
		expect(orcaAuthBaseUrl()).toBe(DEFAULT_ORCA_AUTH_BASE_URL)
		expect(orcaApiBaseUrl()).toBe(DEFAULT_ORCA_API_BASE_URL)
		expect(orcaAuthorizeUrl()).toBe("https://www.orcarouter.ai/auth")
		// The relay is at /v1; the auth endpoints are not.
		expect(orcaExchangeUrl()).toBe("https://www.orcarouter.ai/api/v1/auth/keys")
		expect(orcaDeviceCodeUrl()).toBe(
			"https://www.orcarouter.ai/api/v1/auth/device/code",
		)
		expect(orcaDeviceTokenUrl()).toBe(
			"https://www.orcarouter.ai/api/v1/auth/device/token",
		)
	})

	it("never derives one origin from the other", () => {
		// The classic mistake: the exchange path hung off the inference origin.
		expect(orcaExchangeUrl()).not.toContain("api.orcarouter.ai")
		expect(orcaModelsUrl()).toContain("api.orcarouter.ai")
		expect(orcaModelsUrl()).not.toContain("www.orcarouter.ai")
		expect(orcaModelsUrl()).not.toContain("/v1/auth")
	})

	it("takes an explicit override over the shared base", () => {
		const env = {
			ORCA_BASE_URL: "https://self-hosted.example",
			ORCA_AUTH_BASE_URL: "https://auth.example",
			ORCA_API_BASE_URL: "https://relay.example/v1",
		}
		expect(orcaAuthBaseUrl(env)).toBe("https://auth.example")
		expect(orcaApiBaseUrl(env)).toBe("https://relay.example/v1")
	})

	it("falls back to the shared self-hosted base for both", () => {
		const env = { ORCA_BASE_URL: "https://one-origin.example" }
		expect(orcaAuthBaseUrl(env)).toBe("https://one-origin.example")
		// A bare host still gets the relay prefix; it is not already under /v1.
		expect(orcaApiBaseUrl(env)).toBe("https://one-origin.example/v1")
	})

	it("trims trailing slashes and ignores blank overrides", () => {
		expect(orcaAuthBaseUrl({ ORCA_AUTH_BASE_URL: "https://a.example///" })).toBe(
			"https://a.example",
		)
		expect(orcaApiBaseUrl({ ORCA_API_BASE_URL: "   " })).toBe(
			DEFAULT_ORCA_API_BASE_URL,
		)
		expect(orcaApiBaseUrl({ ORCA_API_BASE_URL: "https://relay.example/v1//" })).toBe(
			"https://relay.example/v1",
		)
	})

	it("refuses plain HTTP except on loopback", () => {
		expect(isSecureOrcaOrigin("https://www.orcarouter.ai")).toBe(true)
		expect(isSecureOrcaOrigin("http://127.0.0.1:8787")).toBe(true)
		expect(isSecureOrcaOrigin("http://localhost:8787")).toBe(true)
		expect(isSecureOrcaOrigin("http://www.orcarouter.ai")).toBe(false)
		expect(isSecureOrcaOrigin("http://10.0.0.4")).toBe(false)
		expect(isSecureOrcaOrigin("not a url")).toBe(false)
		expect(() => orcaAuthBaseUrl({ ORCA_AUTH_BASE_URL: "http://evil.example" })).toThrow(
			OrcaOriginError,
		)
	})

	it("asks the catalog for one capability at a time on the inference origin", () => {
		expect(orcaModelsUrl(undefined, "chat")).toBe(
			"https://api.orcarouter.ai/v1/models?capability=chat",
		)
		expect(orcaModelsUrl(undefined, "embedding")).toBe(
			"https://api.orcarouter.ai/v1/models?capability=embedding",
		)
		expect(orcaModelsUrl()).toBe("https://api.orcarouter.ai/v1/models")
	})
})
