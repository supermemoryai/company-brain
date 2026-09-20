import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js"

// Above the SDK's 60s per-request timeout so this only catches what it misses:
// the OAuth discovery and token fetches, which carry no signal at all.
const MCP_FETCH_TIMEOUT_MS = 75_000

function acceptHeader(headers: RequestInit["headers"]): string {
	if (!headers) return ""
	if (headers instanceof Headers) return headers.get("accept") ?? ""
	const entries = Array.isArray(headers)
		? (headers as string[][])
		: Object.entries(headers as Record<string, string>)
	for (const [key, value] of entries) {
		if (key?.toLowerCase() === "accept") return value ?? ""
	}
	return ""
}

// The long-lived notification stream is the only GET asking for text/event-stream
// alone; JSON-RPC POSTs accept application/json too. It must not be timed out.
function isNotificationStream(init?: RequestInit): boolean {
	if ((init?.method ?? "GET").toUpperCase() !== "GET") return false
	return acceptHeader(init?.headers).includes("text/event-stream")
}

export function withMcpFetchTimeout(inner?: FetchLike): FetchLike {
	const base: FetchLike = inner ?? ((url, init) => fetch(url, init))
	return (url, init) => {
		if (isNotificationStream(init)) return base(url, init)
		const timeout = AbortSignal.timeout(MCP_FETCH_TIMEOUT_MS)
		return base(url, {
			...init,
			signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
		})
	}
}
