import type { ModelMessage } from "ai"
import { describe, expect, it } from "vitest"
import { compactMessagesAtBoundary } from "./context"
import {
	SUPERCOMPRESS_URL,
	compactMessagesForModel,
	compressContext,
} from "./supercompress"

function toolResult(toolName: string, value: string, id = toolName): ModelMessage {
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: id,
				toolName,
				output: { type: "text", value },
			},
		],
	} as ModelMessage
}

function headOf(messages: ModelMessage[], index: number): Record<string, unknown> {
	const message = messages[index]
	if (!message || message.role !== "tool" || !Array.isArray(message.content)) {
		throw new Error(`no tool message at ${index}`)
	}
	const part = message.content[0] as {
		output?: { value?: Record<string, unknown> }
	}
	return part.output?.value ?? {}
}

describe("compactMessagesAtBoundary", () => {
	it("prefix-cuts an oversized recent tool result", () => {
		const raw = `error: disk full\n${"x".repeat(20_000)}`
		const out = compactMessagesAtBoundary([toolResult("shell", raw)])
		const value = headOf(out, 0)
		expect(value.boundaryBounded).toBe(true)
		expect(String(value.head)).toHaveLength(16_000)
		expect(String(value.head).startsWith("error: disk full")).toBe(true)
		expect(value.queryKept).toBeUndefined()
		expect(value.originalChars).toBe(raw.length)
	})

	it("uses a query-kept override instead of the prefix", () => {
		const raw = `noise\n${"x".repeat(20_000)}\nerror: disk full`
		const out = compactMessagesAtBoundary([toolResult("shell", raw)], {
			headOverrides: new Map([["0:0", "error: disk full"]]),
		})
		const value = headOf(out, 0)
		expect(value.head).toBe("error: disk full")
		expect(value.queryKept).toBe(true)
		expect(value.originalChars).toBe(raw.length)
	})
})

describe("compactMessagesForModel", () => {
	it("does not call out when no key is set", async () => {
		let calls = 0
		const out = await compactMessagesForModel(
			[toolResult("shell", "x".repeat(20_000))],
			{
				query: "why did the deploy fail?",
				fetchImpl: async () => {
					calls += 1
					throw new Error("should not be called")
				},
			},
		)
		expect(calls).toBe(0)
		expect(headOf(out, 0).queryKept).toBeUndefined()
		expect(String(headOf(out, 0).head)).toHaveLength(16_000)
	})

	it("compresses only the largest oversized result", async () => {
		const seen: string[] = []
		const older = `old log ${"a".repeat(5_000)}`
		const recent = `recent ${"b".repeat(20_000)} KEEP disk full`
		const filler = Array.from({ length: 6 }, (_, i) =>
			toolResult("noop", "short", `noop-${i}`),
		)
		const out = await compactMessagesForModel(
			[toolResult("old", older, "old"), ...filler, toolResult("shell", recent, "shell")],
			{
				query: "why is the disk full?",
				supercompressApiKey: "sc_live_test",
				fetchImpl: async (_url, init) => {
					const body = JSON.parse(String(init?.body)) as { context: string; query: string }
					seen.push(body.context.slice(0, 6))
					expect(body.query).toBe("why is the disk full?")
					return new Response(
						JSON.stringify({ compressed_text: "KEEP disk full" }),
						{ status: 200 },
					)
				},
			},
		)
		expect(seen).toEqual(["recent"])
		const shell = headOf(out, out.length - 1)
		expect(shell.head).toBe("KEEP disk full")
		expect(shell.queryKept).toBe(true)
		const old = headOf(out, 0)
		expect(String(old.head)).toHaveLength(400)
		expect(old.queryKept).toBeUndefined()
	})

	it("keeps the prefix cut when the request fails", async () => {
		const out = await compactMessagesForModel(
			[toolResult("shell", `error\n${"x".repeat(20_000)}`)],
			{
				query: "what failed?",
				supercompressApiKey: "sc_live_test",
				fetchImpl: async () => new Response("nope", { status: 503 }),
			},
		)
		const value = headOf(out, 0)
		expect(value.queryKept).toBeUndefined()
		expect(String(value.head).startsWith("error")).toBe(true)
		expect(String(value.head)).toHaveLength(16_000)
	})
})

describe("compressContext", () => {
	it("posts context and query to the public API", async () => {
		let url = ""
		let header = ""
		const text = await compressContext({
			apiKey: "sc_live_test",
			query: "what failed?",
			context: "a".repeat(100),
			fetchImpl: async (input, init) => {
				url = String(input)
				header = new Headers(init?.headers).get("X-API-Key") ?? ""
				return new Response(JSON.stringify({ compressed_text: "kept" }), {
					status: 200,
				})
			},
		})
		expect(text).toBe("kept")
		expect(url).toBe(SUPERCOMPRESS_URL)
		expect(header).toBe("sc_live_test")
	})

	it("rejects a result that is not shorter than the input", async () => {
		const text = await compressContext({
			apiKey: "sc_live_test",
			query: "what failed?",
			context: "short",
			fetchImpl: async () =>
				new Response(JSON.stringify({ compressed_text: "short" }), { status: 200 }),
		})
		expect(text).toBeNull()
	})
})
