export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

/**
 * Base URL for OpenRouter-compatible chat requests.
 *
 * Set OPENROUTER_BASE_URL to point at any OpenAI-compatible router instead
 * (e.g. a FreeRouter key at "https://api.freerouter.com/v1"). Model ids stay
 * in `vendor/model` form; a compatible router forwards them upstream.
 */
export function openRouterBaseUrl(env?: Pick<Env, "OPENROUTER_BASE_URL">): string {
	const override = env?.OPENROUTER_BASE_URL?.trim()
	if (override) return override.replace(/\/+$/, "")
	return DEFAULT_OPENROUTER_BASE_URL
}
