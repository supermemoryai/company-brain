import { Hono } from "hono"
import { afterEach, describe, expect, it } from "vitest"
import {
	privateContainerTagFor,
	SHARED_TEAM_BRAIN_CONTAINER_TAG,
} from "@/lib/spaces/provisioning"
import type { AppContext, AuthOrganization, AuthUser } from "@/types"
import { brainMemoriesRoutes } from "./memories"

const realFetch = globalThis.fetch
afterEach(() => {
	globalThis.fetch = realFetch
})

const user = { id: "user_1", name: "Alex" } as AuthUser
const org = { id: "org_1", name: "Acme" } as AuthOrganization

function app(signedIn: boolean) {
	return new Hono<AppContext>()
		.use(async (c, next) => {
			c.set("user", signedIn ? user : null)
			c.set("org", signedIn ? org : null)
			await next()
		})
		.route("/brain/memories", brainMemoriesRoutes)
}

const env = { SUPERMEMORY_API_KEY: "sm_test" } as Env

function entry(id: string, memory: string, updatedAt: string) {
	return { id, memory, updatedAt }
}

describe("GET /brain/memories/export", () => {
	it("downloads the shared and the viewer's own memories as Markdown", async () => {
		const listed: string[][] = []
		globalThis.fetch = (async (
			_input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const body = JSON.parse(String(init?.body)) as {
				containerTags: string[]
			}
			listed.push(body.containerTags)
			const [tag] = body.containerTags
			const memoryEntries =
				tag === SHARED_TEAM_BRAIN_CONTAINER_TAG
					? [entry("m1", "We ship on Tuesdays.", "2026-09-24T09:00:00.000Z")]
					: [entry("m2", "I prefer short answers.", "2026-09-23T09:00:00.000Z")]
			return Response.json({ memoryEntries, pagination: { totalPages: 1 } })
		}) as typeof fetch

		const res = await app(true).request("/brain/memories/export", {}, env)
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toContain("text/markdown")
		expect(res.headers.get("content-disposition")).toMatch(
			/^attachment; filename="company-brain-memories-\d{4}-\d{2}-\d{2}\.md"$/,
		)
		const markdown = await res.text()
		expect(markdown).toContain("# What Company Brain remembers about Acme")
		expect(markdown).toMatch(
			/## Shared team brain[\s\S]*- We ship on Tuesdays\./,
		)
		expect(markdown).toMatch(/## Only you[\s\S]*- I prefer short answers\./)
		// Only the shared container and the viewer's own, never another member's.
		expect(listed.flat().sort()).toEqual([
			SHARED_TEAM_BRAIN_CONTAINER_TAG,
			privateContainerTagFor(user.id),
		])
	})

	it("refuses a signed-out request", async () => {
		const res = await app(false).request("/brain/memories/export", {}, env)
		expect(res.status).toBe(401)
	})
})
