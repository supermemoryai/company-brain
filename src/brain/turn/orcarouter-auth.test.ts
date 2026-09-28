/**
 * The two credential adapters, end to end.
 *
 * Flow B (out-of-band code) is driven through the real adapter against a local
 * fake auth server, so the test covers authorize URL -> pasted code -> exchange
 * -> persist, not just the hash helpers. Every key and code here is fake.
 */

import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	createOrcaApiKeyAdapter,
	createOrcaPkceAdapter,
	markOrcaCredentialNeedsReauth,
	OrcaCredentialInputError,
	ORCA_APP_NAME,
	type OrcaCredentialReadResult,
	type OrcaCredentialStore,
} from "./orcarouter-auth"
import {
	maskOrcaKey,
	type OrcaCredential,
	type OrcaExchangeError,
} from "./orcarouter-credentials"
import { fetchOrcaCatalogModels } from "./orcarouter-models"
import type { OrcaBaseUrlEnv } from "./orca-base-url"

const FAKE_KEY = "sk-orca-testonly-000000000000000000000000"
const FAKE_MINTED_KEY = "sk-orca-mintedforthisworkspace0000000000"
const FAKE_CODE = "fake-auth-code-not-real"

/** In-memory stand-in for the deployment store. Never a real secret. */
function fakeStore(initial: OrcaCredential | null = null): OrcaCredentialStore & {
	current(): OrcaCredential | null
	markers: string[]
} {
	let stored = initial
	let marker: string | null = null
	return {
		markers: [],
		current: () => stored,
		async read(): Promise<OrcaCredentialReadResult> {
			if (!stored) return { status: "missing" }
			if (marker === stored.generation) {
				return { status: "needs_reauth", credential: stored }
			}
			return { status: "ok", credential: stored }
		},
		async save(credential) {
			stored = credential
		},
		async clear() {
			stored = null
			marker = null
		},
		async markNeedsReauth(generation) {
			marker = generation
			this.markers.push(generation)
		},
	}
}

type Handler = (
	req: IncomingMessage,
	body: string,
) => { status: number; json: unknown }

async function serve(handler: Handler): Promise<{
	origin: string
	requests: { url: string; method: string; body: string }[]
	close(): Promise<void>
}> {
	const requests: { url: string; method: string; body: string }[] = []
	const server: Server = createServer((req, res) => {
		let body = ""
		req.on("data", (chunk) => {
			body += String(chunk)
		})
		req.on("end", () => {
			requests.push({ url: req.url ?? "", method: req.method ?? "", body })
			const result = handler(req, body)
			res.writeHead(result.status, { "Content-Type": "application/json" })
			res.end(JSON.stringify(result.json))
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address() as AddressInfo
	return {
		origin: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve())
			}),
	}
}

const servers: { close(): Promise<void> }[] = []

/** `noUncheckedIndexedAccess` is on, so index deliberately and loudly. */
function nth<T>(items: readonly T[], index: number): T {
	const item = items[index]
	if (item === undefined) throw new Error(`expected an item at index ${index}`)
	return item
}

afterEach(async () => {
	while (servers.length) await servers.pop()?.close()
})

/** A loopback origin may use plain HTTP; the adapter must accept it. */
function envFor(origin: string): OrcaBaseUrlEnv {
	return { ORCA_BASE_URL: origin }
}

describe("API key adapter", () => {
	it("stores a pasted key and never renders it whole", async () => {
		const store = fakeStore()
		const adapter = createOrcaApiKeyAdapter(store)
		const credential = await adapter.connect({ key: `  ${FAKE_KEY}  ` })
		expect(credential.key).toBe(FAKE_KEY)
		expect(credential.source).toBe("orcarouter")
		expect(credential.scope).toBe("api")
		expect(store.current()?.key).toBe(FAKE_KEY)
		expect(maskOrcaKey(credential.key)).not.toContain("testonly")
	})

	it("refuses empty and mis-prefixed input without storing anything", async () => {
		const store = fakeStore()
		const adapter = createOrcaApiKeyAdapter(store)
		await expect(adapter.connect({ key: "   " })).rejects.toBeInstanceOf(
			OrcaCredentialInputError,
		)
		await expect(adapter.connect({ key: "sk-or-abc" })).rejects.toMatchObject({
			code: "prefix",
		})
		expect(store.current()).toBeNull()
	})
})

describe("PKCE adapter over a local auth server", () => {
	it("walks Flow B: authorize URL, pasted code, exchange, persist", async () => {
		const auth = await serve(() => ({
			status: 200,
			json: { key: FAKE_MINTED_KEY, scope: "api", user_id: "user-testonly" },
		}))
		servers.push(auth)
		const store = fakeStore()
		const adapter = createOrcaPkceAdapter({ store, env: envFor(auth.origin) })

		const started = await adapter.start("oob")
		const url = new URL(started.url)
		// The consent request goes to the auth origin's fixed /auth path.
		expect(url.origin).toBe(auth.origin)
		expect(url.pathname).toBe("/auth")
		expect(url.searchParams.get("callback_url")).toBe("oob")
		expect(url.searchParams.get("code_challenge_method")).toBe("S256")
		expect(url.searchParams.get("app_name")).toBe(ORCA_APP_NAME)
		expect(url.searchParams.get("state")).toBe(started.attempt.state)
		// The verifier is never in the URL; only its S256 digest is.
		expect(started.url).not.toContain(started.attempt.codeVerifier)
		expect(started.url).toContain(started.attempt.codeChallenge)

		const result = await adapter.complete({
			attempt: started.attempt,
			code: FAKE_CODE,
			returnedState: started.attempt.state,
		})
		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error("expected the exchange to succeed")
		expect(result.credential.key).toBe(FAKE_MINTED_KEY)
		// Both adapters produce the same shape, differing only in the source.
		expect(result.credential.source).toBe("orcarouter-oauth")
		expect(store.current()?.key).toBe(FAKE_MINTED_KEY)
		expect(store.current()?.userId).toBe("user-testonly")

		// The exchange hit the fixed /api/v1/auth/keys path on the auth origin,
		// as a JSON POST carrying the verifier and S256.
		expect(auth.requests).toHaveLength(1)
		const exchange = nth(auth.requests, 0)
		expect(exchange.method).toBe("POST")
		expect(exchange.url).toBe("/api/v1/auth/keys")
		const body = JSON.parse(exchange.body) as Record<string, string>
		expect(body.code).toBe(FAKE_CODE)
		expect(body.code_verifier).toBe(started.attempt.codeVerifier)
		expect(body.code_challenge_method).toBe("S256")
		expect(Object.keys(body).sort()).toEqual([
			"code",
			"code_challenge_method",
			"code_verifier",
		])
	})

	it("never uses a different origin for inference than for auth", async () => {
		const api = await serve(() => ({
			status: 200,
			json: { data: [{ id: "openai/gpt-5.5", supported_endpoint_types: ["openai"] }] },
		}))
		servers.push(api)
		const auth = await serve(() => ({
			status: 403,
			json: { error: "Invalid code or code_verifier" },
		}))
		servers.push(auth)
		const store = fakeStore()
		const adapter = createOrcaPkceAdapter({
			store,
			env: { ORCA_BASE_URL: auth.origin, ORCA_API_BASE_URL: api.origin },
		})
		const started = await adapter.start("oob")
		await adapter.complete({ attempt: started.attempt, code: FAKE_CODE })
		expect(auth.requests).toHaveLength(1)
		expect(api.requests).toHaveLength(0)
	})

	it("rejects a mismatched state before the code is ever sent", async () => {
		const auth = await serve(() => ({ status: 200, json: { key: FAKE_KEY } }))
		servers.push(auth)
		const adapter = createOrcaPkceAdapter({
			store: fakeStore(),
			env: envFor(auth.origin),
		})
		const started = await adapter.start("oob")
		const result = await adapter.complete({
			attempt: started.attempt,
			code: FAKE_CODE,
			returnedState: "someone-elses-state",
		})
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error("unreachable")
		expect(result.error).toBe<OrcaExchangeError>("state_mismatch")
		// Nothing left the process: the code was never presented.
		expect(auth.requests).toHaveLength(0)
	})

	it("treats a redeemed or expired code as terminal", async () => {
		const auth = await serve(() => ({
			status: 403,
			json: { error: "Invalid code or code_verifier" },
		}))
		servers.push(auth)
		const store = fakeStore()
		const adapter = createOrcaPkceAdapter({ store, env: envFor(auth.origin) })
		const started = await adapter.start("oob")
		for (const attempt of [started.attempt, started.attempt]) {
			const result = await adapter.complete({ attempt, code: FAKE_CODE })
			expect(result.ok).toBe(false)
			if (result.ok) throw new Error("unreachable")
			expect(result.error).toBe<OrcaExchangeError>("code_used")
			expect(result.status).toBe(403)
		}
		expect(store.current()).toBeNull()
	})

	it("refuses a downgraded scope instead of storing the key", async () => {
		const auth = await serve(() => ({
			status: 200,
			json: { key: FAKE_MINTED_KEY, scope: "read" },
		}))
		servers.push(auth)
		const store = fakeStore()
		const adapter = createOrcaPkceAdapter({ store, env: envFor(auth.origin) })
		const started = await adapter.start("oob")
		const result = await adapter.complete({
			attempt: started.attempt,
			code: FAKE_CODE,
		})
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error("unreachable")
		expect(result.error).toBe<OrcaExchangeError>("scope")
		expect(result.message).toBe("read")
		expect(store.current()).toBeNull()
	})

	it("classifies 429 and transport failures without leaking the response", async () => {
		const limited = await serve(() => ({
			status: 429,
			json: { error: "slow down", key: FAKE_MINTED_KEY },
		}))
		servers.push(limited)
		const adapter = createOrcaPkceAdapter({
			store: fakeStore(),
			env: envFor(limited.origin),
		})
		const started = await adapter.start("oob")
		const throttled = await adapter.complete({
			attempt: started.attempt,
			code: FAKE_CODE,
		})
		expect(throttled).toMatchObject({ ok: false, error: "rate_limited", status: 429 })
		// A body that echoes a key must not surface in the result.
		expect(JSON.stringify(throttled)).not.toContain(FAKE_MINTED_KEY)

		const offline = createOrcaPkceAdapter({
			store: fakeStore(),
			fetchImpl: (async () => {
				throw new TypeError("fetch failed")
			}) as typeof fetch,
			env: envFor("https://www.orcarouter.ai"),
		})
		const attempt = await offline.start("oob")
		const down = await offline.complete({ attempt: attempt.attempt, code: FAKE_CODE })
		expect(down).toMatchObject({ ok: false, error: "network" })
	})

	it("keeps the verifier out of every error a caller can observe", async () => {
		const auth = await serve(() => ({
			status: 403,
			json: { error: "Invalid code or code_verifier" },
		}))
		servers.push(auth)
		const adapter = createOrcaPkceAdapter({
			store: fakeStore(),
			env: envFor(auth.origin),
		})
		const started = await adapter.start("oob")
		const verifier = started.attempt.codeVerifier
		const logged: unknown[] = []
		const spy = vi.spyOn(console, "warn").mockImplementation((...args) => {
			logged.push(args)
		})
		try {
			const result = await adapter.complete({
				attempt: started.attempt,
				code: FAKE_CODE,
			})
			expect(JSON.stringify(result)).not.toContain(verifier)
			expect(JSON.stringify(logged)).not.toContain(verifier)
			expect(JSON.stringify(result)).not.toContain("code_verifier\"")
		} finally {
			spy.mockRestore()
		}
	})

	it("mints a fresh verifier and state for every attempt", async () => {
		const auth = await serve(() => ({ status: 200, json: { key: FAKE_KEY } }))
		servers.push(auth)
		const adapter = createOrcaPkceAdapter({
			store: fakeStore(),
			env: envFor(auth.origin),
		})
		const first = await adapter.start("oob")
		const second = await adapter.start("oob")
		expect(first.attempt.codeVerifier).not.toBe(second.attempt.codeVerifier)
		expect(first.attempt.state).not.toBe(second.attempt.state)
		expect(first.attempt.codeChallenge).not.toBe(second.attempt.codeChallenge)
		expect(first.attempt.generation).not.toBe(second.attempt.generation)
	})

	it("drives Flow C without hot-looping and stops on denial", async () => {
		let polls = 0
		const auth = await serve((req) => {
			if (req.url === "/api/v1/auth/device/code") {
				return {
					status: 200,
					json: {
						device_code: "fake-device-code",
						user_code: "ABCD-1234",
						verification_uri: "http://example.test/device",
						expires_in: 600,
						interval: 5,
					},
				}
			}
			polls += 1
			if (polls === 1) return { status: 400, json: { error: "authorization_pending" } }
			return { status: 400, json: { error: "access_denied" } }
		})
		servers.push(auth)
		const store = fakeStore()
		const slept: number[] = []
		const adapter = createOrcaPkceAdapter({
			store,
			env: envFor(auth.origin),
			sleep: async (ms) => {
				slept.push(ms)
			},
		})
		const started = await adapter.start("device")
		expect(started.flow).toBe("device")
		const result = await adapter.poll({
			attempt: started.attempt,
			deviceCode: "fake-device-code",
			expiresInSeconds: 600,
			intervalSeconds: 5,
		})
		expect(result).toMatchObject({ ok: false, error: "denied" })
		expect(polls).toBe(2)
		// Never busy-waits: every poll waits at least the advertised interval.
		expect(slept.length).toBe(2)
		expect(Math.min(...slept)).toBeGreaterThanOrEqual(1000)
		expect(store.current()).toBeNull()
	})

	it("reads the device code from the auth origin, not the relay", async () => {
		const auth = await serve((req) => ({
			status: 200,
			json:
				req.url === "/api/v1/auth/device/code"
					? {
							device_code: "fake-device-code",
							user_code: "ABCD-1234",
							verification_uri: `http://example.test/device`,
							verification_uri_complete: `http://example.test/device?code=ABCD-1234`,
							expires_in: 600,
							interval: 5,
						}
					: { error: "authorization_pending" },
		}))
		servers.push(auth)
		const adapter = createOrcaPkceAdapter({
			store: fakeStore(),
			env: envFor(auth.origin),
			sleep: async () => {},
		})
		const started = await adapter.start("device")
		expect(started.userCode).toBe("ABCD-1234")
		expect(started.url).toBe("http://example.test/device")
		expect(started.verificationUriComplete).toContain("code=ABCD-1234")
		expect(auth.requests[0]?.url).toBe("/api/v1/auth/device/code")
	})
})

describe("one credential, two adapters", () => {
	it("hands the downstream catalog the same request either way", async () => {
		const auth = await serve(() => ({
			status: 200,
			json: { key: FAKE_MINTED_KEY, scope: "api" },
		}))
		servers.push(auth)
		const store = fakeStore()
		const pasted = await createOrcaApiKeyAdapter(store).connect({ key: FAKE_KEY })
		const adapter = createOrcaPkceAdapter({ store, env: envFor(auth.origin) })
		const started = await adapter.start("oob")
		const authorized = await adapter.complete({
			attempt: started.attempt,
			code: FAKE_CODE,
		})
		if (!authorized.ok) throw new Error("expected the exchange to succeed")
		expect(authorized.credential.source).toBe("orcarouter-oauth")

		// The provider only ever sees `credential.key`; model discovery is called
		// with the key and nothing else, so the source cannot change its behaviour.
		const seen: { url: string; auth: string; body: unknown }[] = []
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			seen.push({
				url: String(input),
				auth: String(new Headers(init?.headers).get("Authorization")),
				body: init?.body ?? null,
			})
			return new Response(JSON.stringify({ data: [] }), { status: 200 })
		}) as typeof fetch
		for (const credential of [pasted, authorized.credential]) {
			await fetchOrcaCatalogModels(
				{ ORCA_API_BASE_URL: "https://api.orcarouter.ai/v1" },
				credential.key,
				"chat",
				fetchImpl,
			)
		}
		expect(seen).toHaveLength(2)
		const first = nth(seen, 0)
		const second = nth(seen, 1)
		expect(second.url).toBe(first.url)
		// Nothing about the source is transmitted.
		expect(first.url).not.toContain("oauth")
		expect(first.url).not.toContain("source")
		expect(first.body).toBeNull()
		// Only the key differs, and only because the two adapters minted different
		// keys. A shared key would send byte-identical requests.
		expect(first.auth).toBe(`Bearer ${pasted.key}`)
		expect(second.auth).toBe(`Bearer ${authorized.credential.key}`)
	})
})

describe("terminal reauthentication", () => {
	it("marks only the exact rejected generation", async () => {
		const store = fakeStore()
		const adapter = createOrcaApiKeyAdapter(store)
		const first = await adapter.connect({ key: FAKE_KEY })
		expect(
			await markOrcaCredentialNeedsReauth(store, first.generation),
		).toBe(true)
		expect((await store.read()).status).toBe("needs_reauth")

		// Reconnecting replaces the credential; the stale marker must not follow.
		const second = await adapter.connect({ key: FAKE_MINTED_KEY })
		expect(second.generation).not.toBe(first.generation)
		expect((await store.read()).status).toBe("ok")

		// A late 401 from the request that used the *old* key is a no-op.
		expect(
			await markOrcaCredentialNeedsReauth(store, first.generation),
		).toBe(false)
		expect((await store.read()).status).toBe("ok")
		expect(store.current()?.key).toBe(FAKE_MINTED_KEY)
	})

	it("does not touch a credential that was cleared in the meantime", async () => {
		const store = fakeStore()
		const adapter = createOrcaApiKeyAdapter(store)
		const credential = await adapter.connect({ key: FAKE_KEY })
		await store.clear()
		expect(
			await markOrcaCredentialNeedsReauth(store, credential.generation),
		).toBe(false)
		expect((await store.read()).status).toBe("missing")
	})
})
