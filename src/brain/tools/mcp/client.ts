import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker"
import { decryptToken } from "@/lib/crypto"
import { getCatalogEntry } from "./catalog"
import { createCustomMcpFetch } from "./custom-url"
import { withMcpFetchTimeout } from "./fetch"
import { McpRuntimeProvider } from "./oauth-provider"
import type { ToolProviderHandle } from "./provider"
import type { McpConnectionRow } from "./store"

export type McpClientHandle = {
	client: Client
	close: () => Promise<void>
}

// Build an authenticated MCP client for a stored connection. OAuth connections
// get an authProvider (auto-refresh + write-back); static use a header.
export async function connectMcpClient(
	env: Env,
	connection: McpConnectionRow,
	callbackUrl: string,
): Promise<McpClientHandle> {
	if (!connection.serverUrl) {
		throw new Error(
			`remote MCP connection '${connection.serverSlug}' has no URL`,
		)
	}
	const url = new URL(connection.serverUrl)

	// Only custom URLs need SSRF validation, but every server needs the timeout.
	const mcpFetch = getCatalogEntry(connection.serverSlug)
		? withMcpFetchTimeout()
		: withMcpFetchTimeout(createCustomMcpFetch(env))

	let transport: StreamableHTTPClientTransport
	if (connection.authType === "oauth") {
		transport = new StreamableHTTPClientTransport(url, {
			authProvider: new McpRuntimeProvider(env, connection, callbackUrl),
			fetch: mcpFetch,
		})
	} else if (connection.authType === "static" && connection.accessToken) {
		const token = await decryptToken(
			connection.accessToken,
			env.ENCRYPTION_SECRET,
		)
		const headerName = connection.metadata?.headerName ?? "Authorization"
		const value = headerName === "Authorization" ? `Bearer ${token}` : token
		// Drop case-variant duplicates, else Headers joins them into one value.
		const extras = Object.entries(
			connection.metadata?.extraHeaders ?? {},
		).filter(([name]) => name.toLowerCase() !== headerName.toLowerCase())
		transport = new StreamableHTTPClientTransport(url, {
			fetch: mcpFetch,
			requestInit: {
				headers: { ...Object.fromEntries(extras), [headerName]: value },
			},
		})
	} else {
		transport = new StreamableHTTPClientTransport(url, { fetch: mcpFetch })
	}

	const client = new Client(
		{
			name: "supermemory-company-brain",
			version: "1.0.0",
		},
		{
			// The SDK's default AJV validator compiles schemas with `new Function`,
			// which Workers disallow. Servers that publish output schemas (including
			// Sentry) therefore fail during listTools unless we use the edge-safe
			// validator shipped by the SDK.
			jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
		},
	)
	await client.connect(transport)

	return {
		client,
		close: async () => {
			await client.close().catch(() => {})
		},
	}
}

export async function connectRemoteMcpProvider(
	env: Env,
	connection: McpConnectionRow,
	callbackUrl: string,
): Promise<ToolProviderHandle> {
	const handle = await connectMcpClient(env, connection, callbackUrl)
	return {
		listTools: () => listMcpTools(handle),
		callTool: (name, args, options) => callMcpTool(handle, name, args, options),
		close: handle.close,
	}
}

export async function listMcpTools(handle: McpClientHandle) {
	const tools: Awaited<
		ReturnType<McpClientHandle["client"]["listTools"]>
	>["tools"] = []
	const seenCursors = new Set<string>()
	let cursor: string | undefined
	do {
		const page = await handle.client.listTools(cursor ? { cursor } : undefined)
		tools.push(...page.tools)
		const next = page.nextCursor?.trim()
		if (!next || seenCursors.has(next)) break
		seenCursors.add(next)
		cursor = next
	} while (cursor)
	return tools
}

const MCP_TOOL_TIMEOUT_MS = 60_000

function isTimeoutError(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false
	if ((err as { code?: unknown }).code === -32001) return true
	const message = (err as { message?: unknown }).message
	return typeof message === "string" && /time(?:d)?\s*out/i.test(message)
}

// retryOnTimeout must stay false for anything that might write: a client-side
// timeout doesn't mean the server didn't run, so retrying a mutation double-writes.
export async function callMcpTool(
	handle: McpClientHandle,
	name: string,
	args: Record<string, unknown>,
	opts?: { retryOnTimeout?: boolean },
) {
	const params = { name, arguments: args }
	const options = { timeout: MCP_TOOL_TIMEOUT_MS }
	try {
		return await handle.client.callTool(params, undefined, options)
	} catch (err) {
		if (!opts?.retryOnTimeout || !isTimeoutError(err)) throw err
		console.warn(`[company-brain] mcp tool ${name} timed out; retrying once`)
		return handle.client.callTool(params, undefined, options)
	}
}
