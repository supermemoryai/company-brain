/**
 * The `/setup` OrcaRouter connect flow.
 *
 * Flow B (out-of-band code) is the primary: Company Brain is self-hosted on an
 * origin that differs per deployment (a tunnel, a LAN box, a moved port), so
 * there is no predictable address for a redirect to come back to. The consent
 * screen shows a code and the operator pastes it back here. S256 is always
 * sent, which Flow B requires and which a displayed code needs regardless.
 *
 * The PKCE verifier never leaves this process: it is kept in the deployment's
 * KV under an opaque handle and only presented at exchange time. What the
 * browser carries is the handle, in an httpOnly cookie, and the authorize URL
 * — which holds the challenge and state, both public by design.
 */

import { randomUUID } from "node:crypto"
import type {
	OrcaCredentialStore,
	OrcaPkceAdapter,
	OrcaPkceFlow,
	OrcaPkceStart,
} from "@/lib/brain/turn/orcarouter-auth"
import {
	createOrcaApiKeyAdapter,
	createOrcaPkceAdapter,
	OrcaCredentialInputError,
	type OrcaApiKeyAdapter,
} from "@/lib/brain/turn/orcarouter-auth"
import { createOrcaCredentialStore } from "@/lib/brain/turn/orcarouter-store"
import type { OrcaPkceAttempt } from "@/lib/brain/turn/orcarouter-credentials"

export const ORCA_PENDING_COOKIE = "orca_pkce"
export const ORCA_PENDING_TTL_SECONDS = 600

type PendingAuthorization = {
	handle: string
	flow: OrcaPkceFlow
	attempt: OrcaPkceAttempt
	/** Present for the device flow; a secret, so it stays server-side too. */
	deviceCode?: string
	expiresInSeconds?: number
	intervalSeconds?: number
}

function pendingKey(handle: string): string {
	return `orca:pending:${handle}`
}

/**
 * Bellek store for in-flight authorizations. Returns null when the deployment
 * has no KV binding, so the caller can say so instead of hanging.
 */
function kv(env: Env): KVNamespace | null {
	return env.BRAIN_KV ?? null
}

async function putPending(
	env: Env,
	pending: PendingAuthorization,
): Promise<boolean> {
	const namespace = kv(env)
	if (!namespace) return false
	await namespace.put(pendingKey(pending.handle), JSON.stringify(pending), {
		expirationTtl: ORCA_PENDING_TTL_SECONDS,
	})
	return true
}

async function readPending(
	env: Env,
	handle: string,
): Promise<PendingAuthorization | null> {
	const namespace = kv(env)
	if (!namespace || !handle) return null
	const raw = await namespace.get(pendingKey(handle))
	if (!raw) return null
	try {
		const parsed: unknown = JSON.parse(raw)
		if (typeof parsed !== "object" || parsed === null) return null
		return parsed as PendingAuthorization
	} catch {
		return null
	}
}

async function clearPending(env: Env, handle: string): Promise<void> {
	await kv(env)?.delete(pendingKey(handle))
}

export type OrcaSetupContext = {
	env: Env
	store: OrcaCredentialStore
	apiKey: OrcaApiKeyAdapter
	pkce: OrcaPkceAdapter
}

export function orcaSetupContext(env: Env): OrcaSetupContext {
	const store = createOrcaCredentialStore(env)
	return {
		env,
		store,
		apiKey: createOrcaApiKeyAdapter(store),
		pkce: createOrcaPkceAdapter({ store, env }),
	}
}

export type OrcaStartOutcome =
	| { ok: true; handle: string; start: OrcaPkceStart }
	| { ok: false; message: string }

async function begin(
	env: Env,
	flow: OrcaPkceFlow,
): Promise<OrcaStartOutcome> {
	const context = orcaSetupContext(env)
	let start: OrcaPkceStart
	try {
		start = await context.pkce.start(flow)
	} catch (error) {
		return { ok: false, message: deviceStartCopy(error) }
	}
	const handle = randomUUID()
	const stored = await putPending(env, {
		handle,
		flow,
		attempt: start.attempt,
		deviceCode: start.deviceCode,
		expiresInSeconds: start.expiresInSeconds,
		intervalSeconds: start.intervalSeconds,
	})
	if (!stored) {
		return {
			ok: false,
			message:
				"This deployment has no KV namespace, so an authorization cannot be held. Add the BRAIN_KV binding and reload.",
		}
	}
	return { ok: true, handle, start }
}

export function startOrcaOob(env: Env): Promise<OrcaStartOutcome> {
	return begin(env, "oob")
}

export function startOrcaDevice(env: Env): Promise<OrcaStartOutcome> {
	return begin(env, "device")
}

export type OrcaCompleteOutcome =
	| { ok: true; message: string }
	| { ok: false; message: string }

/** Finish Flow B with the code the consent screen showed. */
export async function completeOrcaOob(
	env: Env,
	handle: string,
	code: string,
): Promise<OrcaCompleteOutcome> {
	const pending = await readPending(env, handle)
	if (!pending || pending.flow !== "oob") {
		return {
			ok: false,
			message:
				"This authorization expired. Start a new one — a code is only good for 10 minutes.",
		}
	}
	const context = orcaSetupContext(env)
	const result = await context.pkce.complete({
		attempt: pending.attempt,
		code,
	})
	if (result.ok) {
		await clearPending(env, handle)
		return {
			ok: true,
			message: `Connected with OrcaRouter. The key belongs to your account and is stored on this deployment (…${result.credential.key.slice(-4)}).`,
		}
	}
	if (result.error === "rate_limited") {
		return {
			ok: false,
			message:
				"OrcaRouter is rate-limiting key creation (10 keys per account per 24 hours). Reuse the existing connection, or try again later.",
		}
	}
	if (result.error === "network") {
		return {
			ok: false,
			message: "Couldn't reach OrcaRouter. Check this worker's network and try again.",
		}
	}
	// Code unknown, expired or already used, or the verifier did not match.
	await clearPending(env, handle)
	return {
		ok: false,
		message:
			"That code was rejected or already used. Start a new authorization and paste the fresh code.",
	}
}

/** Poll the device grant once. The caller re-renders with the result. */
export async function pollOrcaDevice(
	env: Env,
	handle: string,
): Promise<OrcaCompleteOutcome & { pending?: boolean }> {
	const pending = await readPending(env, handle)
	if (!pending || pending.flow !== "device" || !pending.deviceCode) {
		return {
			ok: false,
			message: "This device authorization expired. Start a new one.",
		}
	}
	const context = orcaSetupContext(env)
	const result = await context.pkce.poll({
		attempt: pending.attempt,
		deviceCode: pending.deviceCode,
		expiresInSeconds: pending.expiresInSeconds ?? 600,
		intervalSeconds: pending.intervalSeconds ?? 5,
	})
	if (result.ok) {
		await clearPending(env, handle)
		return { ok: true, message: "Connected with OrcaRouter on your other device." }
	}
	if (result.error === "denied") {
		await clearPending(env, handle)
		return { ok: false, message: "Authorization was declined. Nothing was stored." }
	}
	if (result.error === "network") {
		return { ok: false, message: "Couldn't reach OrcaRouter. Try again." }
	}
	await clearPending(env, handle)
	return {
		ok: false,
		message: "That device authorization ended. Start a new one.",
	}
}

/**
 * Flow C needs the device code before it can poll. `start()` already returned
 * it, so it was stored with the attempt and the poll path needs no second
 * request. The browser only ever sees the handle.
 */
export async function connectOrcaApiKey(
	env: Env,
	key: string,
): Promise<OrcaCompleteOutcome> {
	const context = orcaSetupContext(env)
	try {
		const credential = await context.apiKey.connect({ key })
		return {
			ok: true,
			message: `Saved your OrcaRouter key (…${credential.key.slice(-4)}). It is stored encrypted on this deployment and never shown again.`,
		}
	} catch (error) {
		if (error instanceof OrcaCredentialInputError) {
			return { ok: false, message: error.message }
		}
		return {
			ok: false,
			message: "Could not store that key. Check the deployment's database and try again.",
		}
	}
}

export async function disconnectOrca(env: Env): Promise<void> {
	const context = orcaSetupContext(env)
	await context.store.clear()
	// Drop the in-memory copy so nothing keeps using the removed key.
	if (env.ORCA_API_KEY?.trim()) env.ORCA_API_KEY = undefined
}

function deviceStartCopy(error: unknown): string {
	const status =
		typeof error === "object" && error !== null && "status" in error
			? Number((error as { status: unknown }).status)
			: 0
	if (status === 429) {
		return "Too many pending authorizations from this address. Wait a moment and try again."
	}
	return "Couldn't start the authorization. Check that this worker can reach www.orcarouter.ai."
}

/** How a stored credential is described on the setup page. */
export function orcaCredentialLabel(source: string): string {
	return source === "orcarouter-oauth"
		? "Connect with OrcaRouter"
		: "an API key you pasted"
}
