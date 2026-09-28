/**
 * Where an OrcaRouter credential lives.
 *
 * The key belongs to the operator, not to this deployment. It is stored
 * through the repository's own deployment credential store — the encrypted
 * `deployment_config` table used for Slack credentials — so no new secret
 * store is introduced. An `ORCA_API_KEY` Workers secret takes precedence when
 * set, and is never overwritten; the setup wizard only ever writes the stored
 * row.
 *
 * A PKCE-issued OrcaRouter key is durable, not a refresh token: it is reused
 * until OrcaRouter revokes it. A `401` therefore marks the exact credential
 * generation that was rejected and stops there — there is nothing to refresh.
 */

import {
	deleteDeploymentConfig,
	readDeploymentConfig,
	writeDeploymentConfig,
} from "../../setup/config-store"
import type { OrcaCredentialStore, OrcaCredentialReadResult } from "./orcarouter-auth"
import {
	orcaKeyHint,
	type OrcaCredential,
	type OrcaCredentialSource,
} from "./orcarouter-credentials"
import type { OrcaCatalogCache } from "./orcarouter-models"

const CREDENTIAL_KEY = "orca_credential"
const REAUTH_KEY = "orca_credential_reauth"

type StoredCredential = {
	key: string
	source: OrcaCredentialSource
	scope: string
	generation: string
	userId?: string
	createdAt: string
}

function parseCredential(raw: string | undefined): OrcaCredential | null {
	if (!raw) return null
	try {
		const parsed: unknown = JSON.parse(raw)
		if (typeof parsed !== "object" || parsed === null) return null
		const record = parsed as Record<string, unknown>
		const key = typeof record.key === "string" ? record.key.trim() : ""
		const generation =
			typeof record.generation === "string" ? record.generation : ""
		if (!key || !generation) return null
		const source: OrcaCredentialSource =
			record.source === "orcarouter-oauth" ? "orcarouter-oauth" : "orcarouter"
		return {
			key,
			source,
			scope: typeof record.scope === "string" ? record.scope : "api",
			generation,
			userId: typeof record.userId === "string" ? record.userId : undefined,
			createdAt:
				typeof record.createdAt === "string"
					? record.createdAt
					: new Date(0).toISOString(),
		}
	} catch {
		return null
	}
}

function serializeCredential(credential: OrcaCredential): string {
	const stored: StoredCredential = {
		key: credential.key,
		source: credential.source,
		scope: credential.scope,
		generation: credential.generation,
		...(credential.userId ? { userId: credential.userId } : {}),
		createdAt: credential.createdAt,
	}
	return JSON.stringify(stored)
}

function markerGeneration(raw: string | undefined): string | null {
	if (!raw) return null
	try {
		const parsed: unknown = JSON.parse(raw)
		if (typeof parsed !== "object" || parsed === null) return null
		const generation = (parsed as Record<string, unknown>).generation
		return typeof generation === "string" ? generation : null
	} catch {
		return null
	}
}

/** An `ORCA_API_KEY` Workers secret, if the deployment sets one. */
function envCredential(env: Env): OrcaCredential | null {
	const key = env.ORCA_API_KEY?.trim()
	if (!key) return null
	return {
		key,
		source: "orcarouter",
		scope: "api",
		// The generation is the key itself, so a `401` marker cannot outlive a
		// rotation of the Workers secret.
		generation: `env:${keyHintOf(key)}`,
		createdAt: new Date(0).toISOString(),
	}
}

function keyHintOf(key: string): string {
	return orcaKeyHint(key)
}

export function createOrcaCredentialStore(env: Env): OrcaCredentialStore {
	return {
		async read(): Promise<OrcaCredentialReadResult> {
			const fromEnv = envCredential(env)
			if (fromEnv) return { status: "ok", credential: fromEnv }
			const rows = await readDeploymentConfig(env, [
				CREDENTIAL_KEY,
				REAUTH_KEY,
			])
			const credential = parseCredential(rows.get(CREDENTIAL_KEY))
			if (!credential) return { status: "missing" }
			// Only the exact rejected generation is unusable. A marker left by an
			// older request never poisons a credential that replaced it.
			if (markerGeneration(rows.get(REAUTH_KEY)) === credential.generation) {
				return { status: "needs_reauth", credential }
			}
			return { status: "ok", credential }
		},

		async save(credential) {
			// Write the replacement first. The previous secret is never deleted
			// before a new one is in place — a failed login must not cost the
			// operator the credential they already had.
			const rows = await readDeploymentConfig(env, [REAUTH_KEY])
			const pending = markerGeneration(rows.get(REAUTH_KEY))
			await writeDeploymentConfig(env, [
				{
					key: CREDENTIAL_KEY,
					value: serializeCredential(credential),
					encrypted: true,
				},
			])
			if (pending && pending !== credential.generation) {
				await deleteDeploymentConfig(env, [REAUTH_KEY])
			}
		},

		async clear() {
			await deleteDeploymentConfig(env, [CREDENTIAL_KEY, REAUTH_KEY])
		},

		async markNeedsReauth(generation) {
			await writeDeploymentConfig(env, [
				{
					key: REAUTH_KEY,
					value: JSON.stringify({ generation }),
				},
			])
		},
	}
}

/**
 * Mark the credential a rejected request used as requiring reauthentication.
 * Returns true when the rejected generation was still the current one, so a
 * late failure from an old request is a no-op.
 */
export { markOrcaCredentialNeedsReauth } from "./orcarouter-auth"

/** Can this deployment reach OrcaRouter at all? */
export async function hasOrcaCredential(env: Env): Promise<boolean> {
	const read = await createOrcaCredentialStore(env).read()
	return read.status === "ok"
}

/**
 * What the setup page may show about a stored credential. The key itself never
 * crosses into HTML.
 */
export async function orcaCredentialSummary(env: Env): Promise<{
	configured: boolean
	needsReauth: boolean
	source: OrcaCredentialSource | null
	hint: string
}> {
	const read = await createOrcaCredentialStore(env).read()
	if (read.status === "missing") {
		return { configured: false, needsReauth: false, source: null, hint: "" }
	}
	return {
		configured: true,
		needsReauth: read.status === "needs_reauth",
		source: read.credential.source,
		hint: orcaKeyHint(read.credential.key),
	}
}

/** Last-known-good catalog storage, bounded per capability and origin. */
export function envOrcaCatalogCache(env: Env): OrcaCatalogCache {
	return {
		async get(key) {
			return (await env.BRAIN_KV?.get(key)) ?? null
		},
		async put(key, value, ttlSeconds) {
			await env.BRAIN_KV?.put(key, value, { expirationTtl: ttlSeconds })
		},
	}
}

