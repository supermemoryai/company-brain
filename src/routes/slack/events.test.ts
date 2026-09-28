// @ts-expect-error bun:test types are not part of the worker tsconfig
import { mock } from "bun:test"
import { createHmac } from "node:crypto"
import { Hono } from "hono"
import { describe, expect, it, vi } from "vitest"
import type { AppContext } from "@/types"

// Importing the router pulls in the Durable Object client from "agents", which
// needs the Workers runtime; the events route only calls getAgentByName.
const getAgentByName = vi.fn()
mock.module("agents", () => ({ getAgentByName }))
const { slackRoutes } = await import("./index")

// Tests the /slack sub-router rather than the full worker app: the full app
// needs D1/Durable Object bindings and session middleware that don't exist
// outside workerd. Credentials come from env, so no database is touched.
const SECRET = "signing-secret"
const app = new Hono<AppContext>().route("/slack", slackRoutes)

function kvFake(seen: string[] = []) {
	return {
		get: vi.fn(async (key: string) => (seen.includes(key) ? "1" : null)),
		put: vi.fn(async () => {}),
	}
}

async function post(
	body: unknown,
	opts: { kv?: ReturnType<typeof kvFake>; signature?: string } = {},
) {
	const raw = JSON.stringify(body)
	const ts = Math.floor(Date.now() / 1000)
	const signature =
		opts.signature ??
		`v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${raw}`).digest("hex")}`
	const waiting: Promise<unknown>[] = []
	const res = await app.request(
		"/slack/events",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-slack-signature": signature,
				"x-slack-request-timestamp": String(ts),
			},
			body: raw,
		},
		{
			SLACK_CLIENT_ID: "cid",
			SLACK_CLIENT_SECRET: "csecret",
			SLACK_SIGNING_SECRET: SECRET,
			BRAIN_KV: opts.kv,
		},
		{
			waitUntil: (p: Promise<unknown>) => waiting.push(p),
			passThroughOnException: () => {},
			props: {},
		} as unknown as ExecutionContext,
	)
	await Promise.all(waiting)
	return res
}

describe("POST /slack/events", () => {
	it("answers a signed url_verification with the challenge", async () => {
		const res = await post({ type: "url_verification", challenge: "abc" })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ challenge: "abc" })
	})

	it("rejects an invalid signature with 401", async () => {
		const res = await post(
			{ type: "url_verification", challenge: "abc" },
			{ signature: "v0=deadbeef" },
		)
		expect(res.status).toBe(401)
		expect(await res.json()).toEqual({ error: "invalid signature" })
	})

	it("acknowledges an already-seen event_id without touching the agent", async () => {
		const kv = kvFake(["slack:evt:Ev1"])
		const res = await post(
			{
				type: "event_callback",
				team_id: "T1",
				event_id: "Ev1",
				event: { type: "app_home_opened", user: "U1" },
			},
			{ kv },
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true })
		expect(kv.get).toHaveBeenCalledWith("slack:evt:Ev1")
		expect(kv.put).not.toHaveBeenCalled()
		expect(getAgentByName).not.toHaveBeenCalled()
	})

	it("marks a new event_id as seen after acknowledging it", async () => {
		const kv = kvFake()
		const res = await post(
			{
				type: "event_callback",
				team_id: "T1",
				event_id: "Ev2",
				event: { type: "app_home_opened", user: "U1" },
			},
			{ kv },
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true })
		expect(kv.put).toHaveBeenCalledWith("slack:evt:Ev2", "1", {
			expirationTtl: expect.any(Number),
		})
		expect(getAgentByName).not.toHaveBeenCalled()
	})
})
