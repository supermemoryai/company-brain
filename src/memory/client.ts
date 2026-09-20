import Supermemory from "supermemory"

const clients = new WeakMap<object, Supermemory>()

/**
 * The brain's memory lives in supermemory, reached through the public API.
 * One client per Env so connections and config are reused across a request.
 */
export function memoryClient(env: Env): Supermemory {
	const existing = clients.get(env as unknown as object)
	if (existing) return existing
	if (!env.SUPERMEMORY_API_KEY) {
		throw new Error(
			"SUPERMEMORY_API_KEY is not set — the brain has nowhere to read or write memory.",
		)
	}
	const client = new Supermemory({ apiKey: env.SUPERMEMORY_API_KEY })
	clients.set(env as unknown as object, client)
	return client
}
