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

/**
 * Pull a stored OrcaRouter credential — pasted key or a PKCE-minted one — into
 * the environment, so both the HTTP worker and the Durable Object see it as
 * `ORCA_API_KEY`. An explicit Workers secret always wins, and a credential the
 * user revoked is not hydrated: it has to be reconnected first.
 */
async function hydrateOrcaCredential(env: Env): Promise<void> {
	if (env.ORCA_API_KEY?.trim()) return
	try {
		const { createOrcaCredentialStore } = await import(
			"@/lib/brain/turn/orcarouter-store"
		)
		const read = await createOrcaCredentialStore(env).read()
		if (read.status === "ok") env.ORCA_API_KEY = read.credential.key
	} catch (error) {
		console.warn(
			"[setup] could not read the stored OrcaRouter credential:",
			error instanceof Error ? error.message : "unknown error",
		)
	}
}

// Whether PUBLIC_URL came from the deployment's own vars, recorded before
// hydration fills it in from KV. A configured value always wins.
const configuredPublicUrl = new WeakMap<object, boolean>()

export function providerForModelKey(
	key: string,
): "anthropic" | "openai" | "google" | "xai" | "openrouter" | "orcarouter" | null {
	if (key.startsWith("sk-ant-")) return "anthropic"
	// Checked before the bare `sk-` rule: an OrcaRouter key must not be read as
	// an OpenAI key.
	if (key.startsWith("sk-orca-")) return "orcarouter"
	if (key.startsWith("sk-or-")) return "openrouter"
	if (key.startsWith("xai-")) return "xai"
	if (key.startsWith("AIza")) return "google"
	if (key.startsWith("sk-")) return "openai"
	return null
}

function applyModelApiKey(env: Env): void {
	const key = env.MODEL_API_KEY?.trim()
	if (!key) return
	switch (providerForModelKey(key)) {
		case "anthropic":
			env.ANTHROPIC_API_KEY ||= key
			return
		case "openai":
			env.OPENAI_API_KEY ||= key
			return
		case "google":
			env.GOOGLE_GENERATIVE_AI_API_KEY ||= key
			return
		case "xai":
			env.XAI_API_KEY ||= key
			return
		case "openrouter":
			env.OPENROUTER_API_KEY ||= key
			return
		case "orcarouter":
			env.ORCA_API_KEY ||= key
			return
		default:
			console.warn(
				"[setup] MODEL_API_KEY doesn't look like an Anthropic, OpenAI, Google, xAI, OpenRouter or OrcaRouter key; set the provider's own variable instead.",
			)
	}
}

export async function hydrateSecrets(env: Env): Promise<void> {
	applyModelApiKey(env)
	await hydrateOrcaCredential(env)
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
