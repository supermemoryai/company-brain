const ENCRYPTION_SECRET_KV_KEY = "deployment:encryption-secret"

/**
 * The key that encrypts stored secrets. A deployment generates its own on
 * first use and keeps it in KV, so nobody has to invent one to get started;
 * setting ENCRYPTION_SECRET as a Workers secret overrides it.
 */
export async function encryptionSecret(env: Env): Promise<string> {
	const configured = env.ENCRYPTION_SECRET?.trim()
	if (configured) return configured
	const stored = await env.BRAIN_KV.get(ENCRYPTION_SECRET_KV_KEY)
	if (stored) return stored
	const generated = [...crypto.getRandomValues(new Uint8Array(32))]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")
	await env.BRAIN_KV.put(ENCRYPTION_SECRET_KV_KEY, generated)
	return generated
}

/**
 * Put the generated secret on `env` so the ~30 call sites that encrypt tokens
 * can stay synchronous. Runs once per isolate, before any handler.
 */
export async function hydrateSecrets(env: Env): Promise<void> {
	if (env.ENCRYPTION_SECRET?.trim()) return
	env.ENCRYPTION_SECRET = await encryptionSecret(env)
}
