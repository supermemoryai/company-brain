/**
 * Whether the container sandbox is set up. Containers need Workers Paid, so a
 * deployment turns this on with CONTAINER_SANDBOX="on" alongside the container
 * block in wrangler.jsonc. The Sandbox Durable Object is always bound; without
 * a container it just can't start one.
 */
export function containerSandboxEnabled(env: Env): boolean {
	return env.CONTAINER_SANDBOX === "on" && Boolean(env.Sandbox)
}

/**
 * Setting DAYTONA_API_KEY picks Daytona on any plan. Otherwise the tools run
 * on a Cloudflare Sandbox container when it's enabled, and stay hidden when
 * neither is available.
 */
export function sandboxToolsConfigured(env: Env): boolean {
	return Boolean(env.DAYTONA_API_KEY) || containerSandboxEnabled(env)
}

/** Which backend the sandbox tools run on, or null when they're off. */
export function sandboxBackend(env: Env): "daytona" | "container" | null {
	if (env.DAYTONA_API_KEY) return "daytona"
	return containerSandboxEnabled(env) ? "container" : null
}
