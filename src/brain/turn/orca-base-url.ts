/**
 * Origins for OrcaRouter.
 *
 * Authentication and inference live on different public origins, and neither
 * can be derived from the other:
 *
 * - auth + code exchange: `https://www.orcarouter.ai`
 *   (authorize `/auth`, exchange `/api/v1/auth/keys`)
 * - inference + model discovery: `https://api.orcarouter.ai/v1`
 *
 * `https://api.orcarouter.ai/v1/auth/keys` is a 404 — the relay's `/v1` is not
 * where the auth endpoints live. Self-hosted deployments may serve both from
 * one origin, so ORCA_BASE_URL is a shared fallback and the explicit
 * ORCA_AUTH_BASE_URL / ORCA_API_BASE_URL overrides win over it.
 */

export const DEFAULT_ORCA_AUTH_BASE_URL = "https://www.orcarouter.ai"
export const DEFAULT_ORCA_API_BASE_URL = "https://api.orcarouter.ai/v1"

/** Fixed paths on the auth origin. They are not configurable. */
export const ORCA_AUTHORIZE_PATH = "/auth"
export const ORCA_EXCHANGE_PATH = "/api/v1/auth/keys"
export const ORCA_DEVICE_CODE_PATH = "/api/v1/auth/device/code"
export const ORCA_DEVICE_TOKEN_PATH = "/api/v1/auth/device/token"

export type OrcaBaseUrlEnv = Pick<
	Env,
	"ORCA_BASE_URL" | "ORCA_AUTH_BASE_URL" | "ORCA_API_BASE_URL"
>

/** A loopback origin may use plain HTTP; anything else must be HTTPS. */
export function isSecureOrcaOrigin(raw: string): boolean {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return false
	}
	if (url.protocol === "https:") return true
	if (url.protocol !== "http:") return false
	return (
		url.hostname === "localhost" ||
		url.hostname === "127.0.0.1" ||
		url.hostname === "[::1]" ||
		url.hostname === "::1"
	)
}

export class OrcaOriginError extends Error {
	readonly origin: string

	constructor(origin: string, message: string) {
		super(message)
		this.name = "OrcaOriginError"
		this.origin = origin
	}
}

function normalize(value: string | undefined): string | undefined {
	const trimmed = value?.trim().replace(/\/+$/, "")
	return trimmed ? trimmed : undefined
}

/**
 * Resolve one origin, preferring the specific override, then the shared
 * self-hosted base, then the public default. A non-loopback HTTP origin is
 * refused rather than silently used.
 */
function resolveOrigin(
	explicit: string | undefined,
	shared: string | undefined,
	fallback: string,
	label: string,
): string {
	const chosen = normalize(explicit) ?? normalize(shared) ?? fallback
	if (!isSecureOrcaOrigin(chosen)) {
		throw new OrcaOriginError(
			chosen,
			`${label} must be an absolute https:// origin (http:// is only allowed for loopback). Set ORCA_BASE_URL or the specific override to an https origin.`,
		)
	}
	return chosen
}

/** Where the consent screen and the code exchange live. */
export function orcaAuthBaseUrl(env?: OrcaBaseUrlEnv): string {
	return resolveOrigin(
		env?.ORCA_AUTH_BASE_URL,
		env?.ORCA_BASE_URL,
		DEFAULT_ORCA_AUTH_BASE_URL,
		"ORCA_AUTH_BASE_URL",
	)
}

/** Where inference and model discovery live. Includes the `/v1` relay prefix. */
export function orcaApiBaseUrl(env?: OrcaBaseUrlEnv): string {
	const base = resolveOrigin(
		env?.ORCA_API_BASE_URL,
		env?.ORCA_BASE_URL,
		DEFAULT_ORCA_API_BASE_URL,
		"ORCA_API_BASE_URL",
	)
	// A shared single-origin deployment is configured with the bare host; the
	// relay still lives under /v1.
	return base.endsWith("/v1") ? base : `${base}/v1`
}

export function orcaAuthorizeUrl(env?: OrcaBaseUrlEnv): string {
	return `${orcaAuthBaseUrl(env)}${ORCA_AUTHORIZE_PATH}`
}

export function orcaExchangeUrl(env?: OrcaBaseUrlEnv): string {
	return `${orcaAuthBaseUrl(env)}${ORCA_EXCHANGE_PATH}`
}

export function orcaDeviceCodeUrl(env?: OrcaBaseUrlEnv): string {
	return `${orcaAuthBaseUrl(env)}${ORCA_DEVICE_CODE_PATH}`
}

export function orcaDeviceTokenUrl(env?: OrcaBaseUrlEnv): string {
	return `${orcaAuthBaseUrl(env)}${ORCA_DEVICE_TOKEN_PATH}`
}

export function orcaModelsUrl(env?: OrcaBaseUrlEnv, capability?: string): string {
	const url = new URL(`${orcaApiBaseUrl(env)}/models`)
	if (capability) url.searchParams.set("capability", capability)
	return url.toString()
}
