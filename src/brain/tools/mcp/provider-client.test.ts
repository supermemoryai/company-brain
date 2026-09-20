import { describe, expect, it, vi } from "vitest"
import type { ToolProviderHandle } from "./provider"
import { createProviderMcpClient } from "./provider-client"

describe("createProviderMcpClient", () => {
	it("forwards Code Mode calls through the provider abstraction", async () => {
		const callTool = vi.fn(async () => ({ messages: [{ id: "message-1" }] }))
		const handle: ToolProviderHandle = {
			listTools: async () => [],
			callTool,
			close: async () => {},
		}
		const client = createProviderMcpClient(handle)

		const result = await client.callTool({
			name: "search_messages",
			arguments: { query: "from:alice@example.com" },
		})

		expect(callTool).toHaveBeenCalledWith("search_messages", {
			query: "from:alice@example.com",
		})
		expect(result).toEqual({ messages: [{ id: "message-1" }] })
	})
})
