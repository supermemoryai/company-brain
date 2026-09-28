/**
 * OrcaRouter credentials.
 *
 * Two credential sources produce the same downstream value — a normal
 * `sk-orca-…` API key belonging to the operator:
 *
 * - `orcarouter`       the operator pastes a key they already have
 * - `orcarouter-oauth` an OAuth 2.0 + PKCE authorization mints one for them
 *
 * Everything after acquisition (inference, model discovery, reasoning options)
 * sees only {@link OrcaCredential}, never which adapter produced it.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto"

export type OrcaCredentialSource = "orcarouter" | "orcarouter-oauth"

export const ORCA_CREDENTIAL_SOURCES: readonly OrcaCredentialSource[] = [
	"orcarouter",
	"orcarouter-oauth",
]

/** The surface each credential source is presented under. */
export const ORCA_CREDENTIAL_LABELS: Record<OrcaCredentialSource, string> = {
	orcarouter: "OrcaRouter - API",
	"orcarouter-oauth": "OrcaRouter - Auth",
}

/**
 * The seam. `generation` is stamped when the credential is written so a late
 * `401` from an older request cannot mark a newer credential broken.
 */
export type OrcaCredential = {
	key: string
	source: OrcaCredentialSource
	/** Granted scope from the exchange, or "api" for a pasted key. */
	scope: string
	/** Opaque per-write id; changes whenever the key is replaced. */
	generation: string
	/** Account the key belongs to, when the exchange told us. */
	userId?: string
	createdAt: string
}

export const ORCA_KEY_PREFIX = "sk-orca-"

/** Lightweight shape check only — a prefix is not proof a key is valid. */
export function looksLikeOrcaKey(value: string): boolean {
	const trimmed = value.trim()
	return (
		trimmed.startsWith(ORCA_KEY_PREFIX) &&
		trimmed.length > ORCA_KEY_PREFIX.length
	)
}

/**
 * Never render a key. Used anywhere a key could otherwise reach a log, an
 * error body, a telemetry event or the browser.
 */
export function maskOrcaKey(key: string): string {
	const trimmed = key.trim()
	if (trimmed.length <= ORCA_KEY_PREFIX.length + 4) return "sk-orca-…"
	return `${ORCA_KEY_PREFIX}…${trimmed.slice(-4)}`
}

/** Worst case a UI may render about a stored key: its last four characters. */
export function orcaKeyHint(key: string): string {
	const trimmed = key.trim()
	return trimmed.length > 4 ? trimmed.slice(-4) : ""
}

export function newOrcaGeneration(): string {
	return randomUUID()
}

export type OrcaKeyValidation =
	| { ok: true; key: string }
	| { ok: false; error: "empty" | "prefix" }

/**
 * Accept a pasted key. Only an obvious input mistake is refused; per the
 * OrcaRouter integration rules we do not send a paid inference request just to
 * make a settings form say "valid", so validity stays unknown until the first
 * real request.
 */
export function validateOrcaApiKeyInput(value: string): OrcaKeyValidation {
	const key = value.trim()
	if (!key) return { ok: false, error: "empty" }
	if (!looksLikeOrcaKey(key)) return { ok: false, error: "prefix" }
	return { ok: true, key }
}

/**
 * A whole OAuth 2.0 + PKCE authorization attempt.
 *
 * The verifier never leaves this object: it is not put in the authorize URL,
 * not logged, and only presented at exchange time.
 */
export type OrcaPkceAttempt = {
	state: string
	/** base64url(sha256(verifier)), no padding. */
	codeChallenge: string
	codeChallengeMethod: "S256"
	/** Not serializable to the browser; used by the exchange only. */
	codeVerifier: string
	/** Monotonic per-login id; stale async work must not overwrite a newer one. */
	generation: string
	createdAt: string
	/** Guards a slow exchange from resurrecting an abandoned attempt. */
	expiresAt: string
}

/** Auth codes are single-use with a 10 minute TTL; match that window. */
export const ORCA_PKCE_TTL_MS = 10 * 60 * 1000

export function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "")
}

export function pkceChallengeFor(verifier: string): string {
	return base64url(createHash("sha256").update(verifier).digest())
}

/**
 * Begin one authorization attempt. Fresh cryptographic randomness every time,
 * never derived from a timestamp, a username or a fixed salt.
 */
export function startOrcaPkceAttempt(now: number = Date.now()): OrcaPkceAttempt {
	const verifier = base64url(randomBytes(32))
	const state = base64url(randomBytes(16))
	return {
		state,
		codeChallenge: pkceChallengeFor(verifier),
		codeChallengeMethod: "S256",
		codeVerifier: verifier,
		generation: newOrcaGeneration(),
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + ORCA_PKCE_TTL_MS).toISOString(),
	}
}

export function orcaAttemptExpired(
	attempt: OrcaPkceAttempt,
	now: number = Date.now(),
): boolean {
	return Date.parse(attempt.expiresAt) <= now
}

/**
 * Compare a returned `state` against the attempt's, in constant time. This is
 * the only thing standing between the callback and a code that somebody else's
 * page dropped on it.
 */
export function statesMatch(expected: string, received: string): boolean {
	const a = Buffer.from(expected, "utf8")
	const b = Buffer.from(received, "utf8")
	let diff = a.length === b.length ? 0 : 1
	const length = Math.max(a.length, b.length)
	for (let i = 0; i < length; i += 1) {
		diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
	}
	return diff === 0
}

/** Exchange parameters. `code_challenge_method` is always S256. */
export function orcaExchangeBody(
	attempt: OrcaPkceAttempt,
	code: string,
): Record<string, string> {
	return {
		code,
		code_verifier: attempt.codeVerifier,
		code_challenge_method: attempt.codeChallengeMethod,
	}
}

export type OrcaExchangeError =
	| "denied"
	| "state_mismatch"
	| "expired"
	| "code_used"
	| "scope"
	| "rate_limited"
	| "network"
	| "malformed"
	| "unexpected"

export type OrcaExchangeOutcome =
	| { ok: true; credential: OrcaCredential }
	| {
			ok: false
			error: OrcaExchangeError
			status?: number
			message?: string
	  }

/**
 * Read an exchange response. `scope` is what was *granted*, not what we asked
 * for, and the returned key is carried straight into the credential — never
 * logged, never echoed back to a browser.
 */
export function readOrcaExchangeResult(
	status: number,
	body: unknown,
): OrcaExchangeOutcome {
	if (status === 429) return { ok: false, error: "rate_limited", status }
	if (status === 403) {
		// Code unknown, expired or already redeemed, or the verifier did not
		// match the stored challenge. Terminal: start a new authorization.
		return { ok: false, error: "code_used", status }
	}
	if (status === 400) return { ok: false, error: "malformed", status }
	if (status < 200 || status >= 300) {
		return { ok: false, error: "unexpected", status }
	}
	if (typeof body !== "object" || body === null) {
		return { ok: false, error: "malformed", status }
	}
	const record = body as Record<string, unknown>
	const key = typeof record.key === "string" ? record.key.trim() : ""
	if (!key) return { ok: false, error: "malformed", status }
	const scope = typeof record.scope === "string" ? record.scope : ""
	if (scope !== "api") {
		// We may have been granted less than we asked for.
		return { ok: false, error: "scope", status, message: scope }
	}
	return {
		ok: true,
		credential: {
			key,
			source: "orcarouter-oauth",
			scope,
			generation: newOrcaGeneration(),
			userId: typeof record.user_id === "string" ? record.user_id : undefined,
			createdAt: new Date().toISOString(),
		},
	}
}

/**
 * How a stored credential may be described. The key itself is never included.
 */
export function describeOrcaCredential(
	credential: OrcaCredential | null,
	state: "ok" | "needs_reauth" | "missing",
): { source: OrcaCredentialSource | null; masked: string; state: string } {
	return {
		source: credential?.source ?? null,
		masked: credential ? maskOrcaKey(credential.key) : "",
		state,
	}
}
