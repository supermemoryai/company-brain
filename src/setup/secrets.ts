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

const PUBLIC_URL_KV_KEY = "deployment:public-url"

// Whether PUBLIC_URL came from the deployment's own vars, recorded before
// hydration fills it in from KV. A configured value always wins.
const configuredPublicUrl = new WeakMap<object, boolean>()

/**
 * Put the generated secret and the deployment's own origin on `env`, so the
 * call sites that encrypt tokens or build callback URLs can stay synchronous.
 * Runs before any handler, and inside the agent, which has no request to read
 * an origin from.
 */
export async function hydrateSecrets(env: Env): Promise<void> {
	if (!env.ENCRYPTION_SECRET?.trim()) {
		env.ENCRYPTION_SECRET = await encryptionSecret(env)
	}
	if (!configuredPublicUrl.has(env)) {
		configuredPublicUrl.set(env, Boolean(env.PUBLIC_URL?.trim()))
	}
	if (!env.PUBLIC_URL?.trim()) {
		env.PUBLIC_URL = (await env.BRAIN_KV.get(PUBLIC_URL_KV_KEY)) ?? ""
	}
}

/** Remember the origin this deployment is served from, for the agent's sake. */
export async function rememberPublicUrl(
	env: Env,
	origin: string,
): Promise<void> {
	if (configuredPublicUrl.get(env)) return
	const normalized = origin.replace(/\/$/, "")
	if (!normalized || env.PUBLIC_URL === normalized) return
	// Opening the dev server directly must not repoint OAuth callbacks away
	// from the tunnel Slack actually reaches.
	if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalized)) return
	env.PUBLIC_URL = normalized
	await env.BRAIN_KV.put(PUBLIC_URL_KV_KEY, normalized)
}
