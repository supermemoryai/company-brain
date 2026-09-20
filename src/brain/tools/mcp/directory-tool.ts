import type { ToolSet } from "ai"
import type { TurnDeps } from "../../turn/deps"
import { AGENT_MCP_DIRECTORY, searchMcpDirectory } from "./directory"

// Always registered: "can you reach X?" must answer before anything is connected.
export function createMcpDirectoryTool(args: {
	deps: TurnDeps
	traceId: string
}): ToolSet {
	const { deps, traceId } = args

	return {
		search_mcp_directory: deps.tool({
			description: `Search the directory of ${AGENT_MCP_DIRECTORY.length} MCP apps this workspace can connect, beyond the ones already connected. Use it when someone asks whether you can reach a specific app, or what could be connected. Every result can actually be connected: pass its slug to connect_app. A connectMode of "oauth" means connect_app posts a Connect button; "apikey" means it returns a setup link, because only the requester can enter their own key. Finding an app here means it can be connected, not that it is connected now. Results are the top matches only. totalMatches is the full match count including the ones returned, so when truncated is true there are totalMatches minus the returned count still unseen: say there are more and offer to narrow, rather than implying the list is complete. Only conclude an app is unavailable after searching its actual name and getting no match.`,
			inputSchema: deps.z.object({
				query: deps.z
					.string()
					.describe("App name or capability, e.g. 'figma' or 'design'."),
			}),
			execute: async ({ query }: { query: string }) => {
				const result = searchMcpDirectory(query)
				console.log(
					`[company-brain][${traceId}] search_mcp_directory hits=${result.apps.length}/${result.totalMatches}`,
				)
				return result
			},
		}),
	}
}
