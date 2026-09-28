/**
 * OrcaRouter credential acquisition: two adapters over one seam.
 *
 * `apiKeyAdapter` and `pkceAdapter` both produce an {@link OrcaCredential}, so
 * the provider, model discovery and every AI surface only ever see a key.
 * This module also owns the terminal `401` transition: only the exact
 * credential generation that made the rejected request is marked
 * `needsReauth`, and a durable OrcaRouter key is reused until then — there is
 * no refresh grant and nothing here ever pretends to be one.
 */

import {
	orcaAuthorizeUrl,
	orcaDeviceCodeUrl,
	orcaDeviceTokenUrl,
	orcaExchangeUrl,
	type OrcaBaseUrlEnv,
} from "./orca-base-url"
import {
	newOrcaGeneration,
	orcaExchangeBody,
	readOrcaExchangeResult,
	startOrcaPkceAttempt,
	statesMatch,
	validateOrcaApiKeyInput,
	type OrcaCredential,
	type OrcaExchangeError,
	type OrcaPkceAttempt,
} from "./orcarouter-credentials"

export const ORCA_APP_NAME = "Company Brain"

/** Where an operator manages and revokes the keys this app holds. */
export const ORCA_KEYS_DASHBOARD_URL =
	"https://www.orcarouter.ai/console/authorized-apps"

export type OrcaCredentialReadResult =
	| { status: "ok"; credential: OrcaCredential }
	| { status: "missing" }
	| { status: "needs_reauth"; credential: OrcaCredential }

/**
 * What the provider reads. Storage is the repository's own deployment
 * credential store; this interface only names the operations the adapters and
 * the terminal-`401` path need.
 */
export type OrcaCredentialStore = {
	read(): Promise<OrcaCredentialReadResult>
	save(credential: OrcaCredential): Promise<void>
	/** Forget the stored credential. */
	clear(): Promise<void>
	/**
	 * Mark exactly one generation unusable. A `401` from an older request must
	 * not mark a credential that has since been replaced.
	 */
	markNeedsReauth(generation: string): Promise<void>
}

export class OrcaCredentialInputError extends Error {
	readonly code: "empty" | "prefix"

	constructor(code: "empty" | "prefix") {
		super(
			code === "empty"
				? "Paste your OrcaRouter API key."
				: "That doesn't look like an OrcaRouter key — it should start with sk-orca-.",
		)
		this.name = "OrcaCredentialInputError"
		this.code = code
	}
}

/** Adapter 1: the operator already holds a key. */
export type OrcaApiKeyAdapter = {
	source: "orcarouter"
	connect(input: { key: string }): Promise<OrcaCredential>
}

export function createOrcaApiKeyAdapter(
	store: OrcaCredentialStore,
	now: () => number = Date.now,
): OrcaApiKeyAdapter {
	return {
		source: "orcarouter",
		async connect(input) {
			const validated = validateOrcaApiKeyInput(input.key)
			if (!validated.ok) throw new OrcaCredentialInputError(validated.error)
			const credential: OrcaCredential = {
				key: validated.key,
				source: "orcarouter",
				scope: "api",
				generation: newOrcaGeneration(),
				createdAt: new Date(now()).toISOString(),
			}
			await store.save(credential)
			return credential
		},
	}
}

/** Flows the PKCE adapter can run. B is the primary; C is the headless extra. */
export type OrcaPkceFlow = "oob" | "device"

export type OrcaPkceStart = {
	flow: OrcaPkceFlow
	attempt: OrcaPkceAttempt
	/** Consent URL to open, or the device verification URL. */
	url: string
	/** Device flow only: the code the human reads on another device. */
	userCode?: string
	/** Device flow only: redeems the key, so it stays server-side. */
	deviceCode?: string
	/** Device flow only: print this verbatim; never rebuild it ourselves. */
	verificationUriComplete?: string
	expiresInSeconds?: number
	intervalSeconds?: number
}

export type OrcaPkceExchangeResult =
	| { ok: true; credential: OrcaCredential }
	| {
			ok: false
			error: OrcaExchangeError
			status?: number
			message?: string
	  }

/** Adapter 2: the operator has no key and authorizes with their account. */
export type OrcaPkceAdapter = {
	source: "orcarouter-oauth"
	/**
	 * Begin an attempt. Callers must bound how long an unconsumed attempt lives:
	 * the server caps simultaneous pending authorizations per IP address.
	 */
	start(flow: OrcaPkceFlow): Promise<OrcaPkceStart>
	/** Finish Flow B: bind the pasted code to the attempt and exchange it. */
	complete(input: {
		attempt: OrcaPkceAttempt
		code: string
		returnedState?: string
	}): Promise<OrcaPkceExchangeResult>
	/** Poll Flow C until the operator approves elsewhere, or the window closes. */
	poll(input: {
		attempt: OrcaPkceAttempt
		deviceCode: string
		expiresInSeconds: number
		intervalSeconds: number
		signal?: AbortSignal
	}): Promise<OrcaPkceExchangeResult>
}

export type OrcaPkceAdapterDeps = {
	store: OrcaCredentialStore
	env: OrcaBaseUrlEnv
	fetchImpl?: typeof fetch
	/** Injected so tests never wait on a real clock. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
	now?: () => number
}

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"))
			return
		}
		const onAbort = () => {
			clearTimeout(timer)
			reject(new Error("aborted"))
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort)
			resolve()
		}, ms)
		signal?.addEventListener("abort", onAbort, { once: true })
	})
}

export class OrcaDeviceStartError extends Error {
	readonly status: number

	constructor(status: number) {
		super(
			`Could not start the OrcaRouter device authorization (HTTP ${status}).`,
		)
		this.name = "OrcaDeviceStartError"
		this.status = status
	}
}

export function createOrcaPkceAdapter(deps: OrcaPkceAdapterDeps): OrcaPkceAdapter {
	const fetchImpl = deps.fetchImpl ?? fetch
	const sleep = deps.sleep ?? defaultSleep
	const now = deps.now ?? Date.now

	async function exchange(
		attempt: OrcaPkceAttempt,
		code: string,
	): Promise<OrcaPkceExchangeResult> {
		let response: Response
		try {
			response = await fetchImpl(orcaExchangeUrl(deps.env), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(orcaExchangeBody(attempt, code)),
				signal: AbortSignal.timeout(30_000),
			})
		} catch {
			return { ok: false, error: "network" }
		}
		let body: unknown = null
		try {
			body = await response.json()
		} catch {
			body = null
		}
		const outcome = readOrcaExchangeResult(response.status, body)
		if (!outcome.ok) {
			return {
				ok: false,
				error: outcome.error,
				status: outcome.status,
				message: outcome.message,
			}
		}
		// Persist before returning. A key that is not stored would have to be
		// minted again on the next boot, and the cap is 10 keys per user / 24h.
		await deps.store.save(outcome.credential)
		return { ok: true, credential: outcome.credential }
	}

	return {
		source: "orcarouter-oauth",

		async start(flow) {
			const attempt = startOrcaPkceAttempt(now())
			if (flow === "device") {
				let response: Response
				try {
					response = await fetchImpl(orcaDeviceCodeUrl(deps.env), {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ app_name: ORCA_APP_NAME, scope: "api" }),
						signal: AbortSignal.timeout(30_000),
					})
				} catch {
					throw new OrcaDeviceStartError(0)
				}
				if (!response.ok) throw new OrcaDeviceStartError(response.status)
				const body = (await response.json().catch(() => ({}))) as Record<
					string,
					unknown
				>
				const deviceCode =
					typeof body.device_code === "string" ? body.device_code : ""
				const verificationUri =
					typeof body.verification_uri === "string" ? body.verification_uri : ""
				if (!deviceCode || !verificationUri) {
					throw new OrcaDeviceStartError(response.status)
				}
				return {
					flow,
					attempt,
					url: verificationUri,
					userCode:
						typeof body.user_code === "string" ? body.user_code : undefined,
					deviceCode,
					// Print what we were handed; do not compose our own.
					verificationUriComplete:
						typeof body.verification_uri_complete === "string"
							? body.verification_uri_complete
							: undefined,
					expiresInSeconds:
						typeof body.expires_in === "number" ? body.expires_in : 600,
					intervalSeconds:
						typeof body.interval === "number" ? body.interval : 5,
				}
			}
			return {
				flow,
				attempt,
				url: orcaAuthorizeUrlWithAttempt(deps.env, attempt),
			}
		},

		async complete({ attempt, code, returnedState }) {
			// The state check runs before the code is looked at.
			if (returnedState !== undefined && !statesMatch(attempt.state, returnedState)) {
				return { ok: false, error: "state_mismatch" }
			}
			const trimmed = code.trim()
			if (!trimmed) return { ok: false, error: "malformed" }
			return exchange(attempt, trimmed)
		},

		async poll({ attempt, deviceCode, expiresInSeconds, intervalSeconds, signal }) {
			// Honour the server's interval, back off on slow_down, never hot-loop.
			let interval = Math.max(1, intervalSeconds)
			const deadline = now() + expiresInSeconds * 1000
			for (;;) {
				if (now() >= deadline) return { ok: false, error: "expired" }
				await sleep(interval * 1000, signal)
				let response: Response
				try {
					response = await fetchImpl(orcaDeviceTokenUrl(deps.env), {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							device_code: deviceCode,
							grant_type: DEVICE_GRANT_TYPE,
						}),
						signal: AbortSignal.timeout(30_000),
					})
				} catch {
					// A transport failure is fatal: retrying hot would hammer the
					// endpoint, and pending authorizations are capped per IP.
					return { ok: false, error: "network" }
				}
				const body: unknown = await response.json().catch(() => null)
				const record =
					typeof body === "object" && body !== null
						? (body as Record<string, unknown>)
						: {}
				// Branch on `error` and nothing else.
				const errorField = typeof record.error === "string" ? record.error : ""
				if (errorField === "authorization_pending") continue
				if (errorField === "slow_down") {
					interval += 5
					continue
				}
				if (errorField === "access_denied") {
					return { ok: false, error: "denied", status: response.status }
				}
				if (errorField === "expired_token") {
					return { ok: false, error: "expired", status: response.status }
				}
				if (errorField) {
					// unsupported_grant_type and anything else: stop.
					return { ok: false, error: "unexpected", status: response.status }
				}
				const outcome = readOrcaExchangeResult(response.status, body)
				if (!outcome.ok) {
					return {
						ok: false,
						error: outcome.error,
						status: outcome.status,
						message: outcome.message,
					}
				}
				await deps.store.save(outcome.credential)
				return { ok: true, credential: outcome.credential }
			}
		},
	}
}

/**
 * Mark the credential a rejected request used as requiring reauthentication.
 * Returns true when the rejected generation was still the current one, so a
 * late `401` from an old request is a no-op. There is no refresh to attempt:
 * a revoked durable key needs a new authorization.
 */
export async function markOrcaCredentialNeedsReauth(
	store: OrcaCredentialStore,
	rejectedGeneration: string | undefined,
): Promise<boolean> {
	if (!rejectedGeneration) return false
	const current = await store.read()
	if (current.status === "missing") return false
	if (current.credential.generation !== rejectedGeneration) return false
	await store.markNeedsReauth(rejectedGeneration)
	return true
}

/**
 * The authorize URL. Flow B asks for `callback_url=oob` explicitly and always
 * sends S256, which is mandatory for a code a human can read off a screen.
 */
export function orcaAuthorizeUrlWithAttempt(
	env: OrcaBaseUrlEnv,
	attempt: OrcaPkceAttempt,
	callbackUrl: string = "oob",
): string {
	const url = new URL(orcaAuthorizeUrl(env))
	url.searchParams.set("callback_url", callbackUrl)
	url.searchParams.set("code_challenge", attempt.codeChallenge)
	url.searchParams.set("code_challenge_method", attempt.codeChallengeMethod)
	url.searchParams.set("state", attempt.state)
	url.searchParams.set("app_name", ORCA_APP_NAME)
	url.searchParams.set("scope", "api")
	return url.toString()
}
