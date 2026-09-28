import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createSlackStreamSession } from "./stream"

// Characterizes the Slack API traffic a stream session produces by recording
// what reaches fetch, so the seam can move without changing the wire behavior.
type Call = { method: string; body: Record<string, unknown> }

let calls: Call[]
let counter: number
const realFetch = globalThis.fetch

beforeEach(() => {
	calls = []
	counter = 0
	globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
		const url = String(input)
		const method = url.slice(url.lastIndexOf("/") + 1)
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<
			string,
			unknown
		>
		calls.push({ method, body })
		counter += 1
		return new Response(
			JSON.stringify({
				ok: true,
				ts: `100.${counter}`,
				message_ts: `100.${counter}`,
				permalink: "https://slack.test/p1",
			}),
			{ headers: { "content-type": "application/json" } },
		)
	}) as unknown as typeof fetch
})

afterEach(() => {
	globalThis.fetch = realFetch
})

// Strip the only non-deterministic bits: the plan block id and elapsed time.
function normalized(): unknown {
	return JSON.parse(
		JSON.stringify(calls)
			.replace(/plan_[^"]*?_\d{10,}/g, "plan_X")
			.replace(/\((?:\d+m )?\d+[sm]\)/g, "(T)"),
	)
}

const base = {
	botToken: "xoxb-test",
	channel: "C1",
	threadTs: "99.0",
	teamId: "T1",
	orgId: "org1",
}

describe("createSlackStreamSession", () => {
	it("channel with public progress: plan card, then a fresh reply replaces it", async () => {
		const session = createSlackStreamSession({ ...base, publicProgress: true })
		await session.progress.card("t1", "Searching memory", "in_progress")
		await session.progress.card("t1", "Searching memory", "complete")
		const result = await session.finalize("The answer", false)
		expect(result).toEqual({ streamed: true, messageTs: "100.3" })
		expect(calls.map((c) => c.method)).toEqual([
			"chat.postMessage",
			"chat.update",
			"chat.postMessage",
			"chat.delete",
		])
		const [progress, update, reply, del] = normalized() as Call[]
		expect(progress?.body).toMatchObject({
			channel: "C1",
			thread_ts: "99.0",
			text: "Searching memory",
			blocks: [
				{
					type: "plan",
					block_id: "plan_X",
					title: "Searching memory",
					tasks: [
						{
							type: "task_card",
							task_id: "task-1",
							title: "Searching memory",
							status: "in_progress",
						},
					],
				},
			],
		})
		expect(update?.body).toMatchObject({ channel: "C1", ts: "100.1" })
		expect(reply?.body).toMatchObject({ channel: "C1", thread_ts: "99.0" })
		expect(JSON.stringify(reply?.body)).toContain("The answer")
		expect(del?.body).toEqual({ channel: "C1", ts: "100.1" })
	})

	it("a second finalize is a no-op", async () => {
		const session = createSlackStreamSession({ ...base, publicProgress: true })
		await session.finalize("done", false)
		const before = calls.length
		expect(await session.finalize("again", false)).toEqual({ streamed: false })
		expect(calls.length).toBe(before)
	})

	it("DM: starts a native stream, appends task chunks and the reply, then stops", async () => {
		const session = createSlackStreamSession({
			...base,
			channel: "D1",
			recipientUserId: "U1",
		})
		await session.progress.card("t1", "Searching memory", "in_progress")
		const result = await session.finalize("The answer", false)
		expect(result.streamed).toBe(true)
		expect(calls.map((c) => c.method)).toEqual([
			"chat.startStream",
			"chat.appendStream",
			"chat.appendStream",
			"chat.appendStream",
			"chat.stopStream",
		])
		const [start, task, closing, reply] = normalized() as Call[]
		expect(start?.body).toMatchObject({
			channel: "D1",
			thread_ts: "99.0",
			recipient_user_id: "U1",
			recipient_team_id: "T1",
			task_display_mode: "plan",
		})
		expect(task?.body).toMatchObject({
			chunks: [
				{ type: "plan_update", title: "Working on it" },
				{
					type: "task_update",
					id: "task-1",
					title: "Searching memory",
					status: "in_progress",
				},
			],
		})
		expect(closing?.body).toMatchObject({
			chunks: [
				{
					type: "task_update",
					id: "task-1",
					title: "Searching memory",
					status: "complete",
				},
				{ type: "plan_update", title: "Answer ready (T)" },
			],
		})
		expect(reply?.body).toMatchObject({
			chunks: [{ type: "markdown_text", text: "The answer" }],
		})
	})

	it("postFallback posts a threaded reply and reports checkpoints", async () => {
		const onDeliveryCheckpoint = vi.fn()
		const session = createSlackStreamSession({
			...base,
			onDeliveryCheckpoint,
		})
		expect(await session.postFallback("fallback text")).toBe("100.1")
		expect(calls).toHaveLength(1)
		expect(calls[0]?.method).toBe("chat.postMessage")
		expect(calls[0]?.body).toMatchObject({ channel: "C1", thread_ts: "99.0" })
		expect(JSON.stringify(calls[0]?.body)).toContain("fallback text")
		expect(onDeliveryCheckpoint).toHaveBeenCalledWith({
			replyMessageTs: "100.1",
		})
	})
})
