import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js"
import type { McpConnectionRow } from "./store"

export type ProviderTool = {
	name: string
	description?: string
	inputSchema: McpTool["inputSchema"]
	annotations?: McpTool["annotations"]
	normalizeInput?: (args: Record<string, unknown>) => Record<string, unknown>
}

export type ProviderCallOptions = { retryOnTimeout?: boolean }

export interface ToolProviderHandle {
	listTools(): Promise<ProviderTool[]>
	callTool(
		name: string,
		args: Record<string, unknown>,
		options?: ProviderCallOptions,
	): Promise<unknown>
	close(): Promise<void>
}

type ProviderConnectors = {
	remote: (
		env: Env,
		connection: McpConnectionRow,
		callbackUrl: string,
	) => Promise<ToolProviderHandle>
	embedded: (
		env: Env,
		connection: McpConnectionRow,
	) => Promise<ToolProviderHandle>
}

const defaultConnectors: ProviderConnectors = {
	remote: async (env, connection, callbackUrl) => {
		const { connectRemoteMcpProvider } = await import("./client")
		return connectRemoteMcpProvider(env, connection, callbackUrl)
	},
	embedded: async (env, connection) => {
		if (connection.serverSlug === "gmail") {
			const { connectGmailProvider } = await import("./google/gmail")
			return connectGmailProvider(env, connection)
		}
		throw new Error(`unsupported embedded provider '${connection.serverSlug}'`)
	},
}

export async function connectToolProvider(
	env: Env,
	connection: McpConnectionRow,
	callbackUrl: string,
	connectors: ProviderConnectors = defaultConnectors,
): Promise<ToolProviderHandle> {
	if (connection.runtime === "embedded") {
		return connectors.embedded(env, connection)
	}
	return connectors.remote(env, connection, callbackUrl)
}
