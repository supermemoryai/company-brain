/**
 * Whether the container sandbox is set up. Containers and the Worker Loader
 * both need Workers Paid and are enabled together by one block in
 * wrangler.jsonc, so a loader binding means the container is there too. The
 * Sandbox Durable Object is always bound; it just can't start a container on
 * the free plan.
 */
export function containerSandboxEnabled(env: Env): boolean {
	return Boolean(env.Sandbox && env.LOADER)
}

/**
 * Setting DAYTONA_API_KEY picks Daytona on any plan. Otherwise the tools run
 * on a Cloudflare Sandbox container when the paid block is enabled, and stay
 * hidden when neither is available.
 */
export function sandboxToolsConfigured(env: Env): boolean {
	return Boolean(env.DAYTONA_API_KEY) || containerSandboxEnabled(env)
}

/** Which backend the sandbox tools run on, or null when they're off. */
export function sandboxBackend(env: Env): "daytona" | "container" | null {
	if (env.DAYTONA_API_KEY) return "daytona"
	return containerSandboxEnabled(env) ? "container" : null
}
