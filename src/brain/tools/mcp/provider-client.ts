import type { McpConnectionLike } from "@cloudflare/codemode"
import type { ToolProviderHandle } from "./provider"

export function createProviderMcpClient(
	handle: ToolProviderHandle,
): McpConnectionLike["client"] {
	return {
		callTool: ((request: {
			name: string
			arguments?: Record<string, unknown>
		}) =>
			handle.callTool(
				request.name,
				request.arguments ?? {},
			)) as McpConnectionLike["client"]["callTool"],
	}
}
