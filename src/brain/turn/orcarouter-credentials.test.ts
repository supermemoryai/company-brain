import { describe, expect, it } from "vitest"
import {
	base64url,
	describeOrcaCredential,
	looksLikeOrcaKey,
	maskOrcaKey,
	orcaAttemptExpired,
	orcaExchangeBody,
	ORCA_KEY_PREFIX,
	readOrcaExchangeResult,
	startOrcaPkceAttempt,
	statesMatch,
	validateOrcaApiKeyInput,
	type OrcaCredential,
} from "./orcarouter-credentials"

const FAKE_KEY = "sk-orca-testonly-000000000000000000000000"
const FAKE_CODE = "fake-auth-code-not-real"

describe("credential masking", () => {
	it("never renders a whole key", () => {
		const masked = maskOrcaKey(FAKE_KEY)
		expect(masked).toBe(`${ORCA_KEY_PREFIX}…0000`)
		expect(masked).not.toContain("testonly")
		expect(masked.length).toBeLessThan(FAKE_KEY.length)
	})

	it("describes a credential without its secret", () => {
		const credential: OrcaCredential = {
			key: FAKE_KEY,
			source: "orcarouter-oauth",
			scope: "api",
			generation: "gen-1",
			createdAt: "2026-09-28T00:00:00.000Z",
		}
		const described = describeOrcaCredential(credential, "ok")
		expect(described.masked).not.toContain("testonly")
		expect(described.source).toBe("orcarouter-oauth")
		expect(JSON.stringify(described)).not.toContain(FAKE_KEY)
	})

	it("recognises the key prefix only as a shape check", () => {
		expect(looksLikeOrcaKey(FAKE_KEY)).toBe(true)
		expect(looksLikeOrcaKey("sk-orca-")).toBe(false)
		expect(looksLikeOrcaKey("sk-or-abc")).toBe(false)
		expect(validateOrcaApiKeyInput("  ")).toEqual({ ok: false, error: "empty" })
		expect(validateOrcaApiKeyInput("sk-or-abc")).toEqual({
			ok: false,
			error: "prefix",
		})
		expect(validateOrcaApiKeyInput(` ${FAKE_KEY} `)).toEqual({
			ok: true,
			key: FAKE_KEY,
		})
	})
})

describe("PKCE attempt", () => {
	it("makes a fresh verifier and state every attempt", () => {
		const a = startOrcaPkceAttempt()
		const b = startOrcaPkceAttempt()
		expect(a.codeVerifier).not.toBe(b.codeVerifier)
		expect(a.state).not.toBe(b.state)
		expect(a.generation).not.toBe(b.generation)
	})

	it("sends an unpadded base64url S256 challenge, never the verifier", () => {
		const attempt = startOrcaPkceAttempt()
		expect(attempt.codeChallengeMethod).toBe("S256")
		expect(attempt.codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/)
		expect(attempt.codeChallenge).not.toContain("=")
		expect(attempt.codeChallenge).not.toBe(attempt.codeVerifier)
		// 32 random bytes is 43 base64url characters.
		expect(attempt.codeVerifier.length).toBe(43)
		expect(base64url(new Uint8Array([251, 255, 190]))).toBe("-_--")
	})

	it("carries the verifier only in the exchange body", () => {
		const attempt = startOrcaPkceAttempt()
		const body = orcaExchangeBody(attempt, FAKE_CODE)
		expect(body).toEqual({
			code: FAKE_CODE,
			code_verifier: attempt.codeVerifier,
			code_challenge_method: "S256",
		})
	})

	it("expires with the code's 10 minute window", () => {
		const now = Date.parse("2026-09-28T00:00:00.000Z")
		const attempt = startOrcaPkceAttempt(now)
		expect(orcaAttemptExpired(attempt, now + 9 * 60_000)).toBe(false)
		expect(orcaAttemptExpired(attempt, now + 10 * 60_000)).toBe(true)
	})

	it("compares state in constant time and refuses a mismatch", () => {
		expect(statesMatch("abc", "abc")).toBe(true)
		expect(statesMatch("abc", "abd")).toBe(false)
		expect(statesMatch("abc", "ab")).toBe(false)
		expect(statesMatch("", "")).toBe(true)
		expect(statesMatch("abc", "")).toBe(false)
	})
})

describe("exchange response handling", () => {
	it("accepts a granted api scope and keeps the key off the wire view", () => {
		const outcome = readOrcaExchangeResult(200, {
			key: FAKE_KEY,
			user_id: "12345",
			scope: "api",
		})
		expect(outcome.ok).toBe(true)
		if (!outcome.ok) return
		expect(outcome.credential.scope).toBe("api")
		expect(outcome.credential.userId).toBe("12345")
		expect(outcome.credential.generation).toMatch(/[0-9a-f-]{36}/)
	})

	it("treats a granted scope we did not ask for as a refusal to claim it", () => {
		const outcome = readOrcaExchangeResult(200, { key: FAKE_KEY, scope: "connector" })
		expect(outcome).toEqual({ ok: false, error: "scope", status: 200, message: "connector" })
	})

	it("classifies terminal and retryable failures", () => {
		expect(readOrcaExchangeResult(403, { error: "invalid_grant" })).toMatchObject({
			ok: false,
			error: "code_used",
		})
		expect(readOrcaExchangeResult(400, {})).toMatchObject({ error: "malformed" })
		expect(readOrcaExchangeResult(429, {})).toMatchObject({ error: "rate_limited" })
		expect(readOrcaExchangeResult(500, {})).toMatchObject({ error: "unexpected" })
		expect(readOrcaExchangeResult(200, { scope: "api" })).toMatchObject({
			error: "malformed",
		})
		expect(readOrcaExchangeResult(200, null)).toMatchObject({ error: "malformed" })
	})

	it("never echoes the key back in a failure", () => {
		const outcome = readOrcaExchangeResult(200, { key: FAKE_KEY, scope: "nope" })
		expect(JSON.stringify(outcome)).not.toContain(FAKE_KEY)
	})
})
