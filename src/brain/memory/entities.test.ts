import { afterEach, describe, expect, it, vi } from "vitest"
import type { BrainMemory } from "../../memory/memories"
import { memoriesToMarkdown } from "../../memory/markdown"
import type { CompanyBrainAgent } from "../turn/agent"
import { resolveEntity } from "./entities"

// List metadata (brain_tag_labels, aliases, contacts) is written through
// flattenMetadata, so it comes back as one comma-joined string.

const realFetch = globalThis.fetch

function stubApi(routes: Record<string, unknown>) {
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const path = new URL(input instanceof Request ? input.url : input).pathname
		return Response.json(routes[path] ?? {})
	}) as unknown as typeof fetch
}

// A fresh env per test: the memory client is cached per env and keeps its fetch.
// No xAI key, so an entity miss can't fall through to a web lookup.
const newEnv = () => ({ SUPERMEMORY_API_KEY: "sm_test" }) as unknown as Env
const org = { id: "org_1", name: "Acme" }
const agent = { sql: () => [] } as unknown as CompanyBrainAgent

function savedEntity(metadata: Record<string, unknown>) {
	return {
		"/v3/documents/list": {
			memories: [
				{
					id: "doc_1",
					customId: null,
					title: String(metadata.canonical),
					metadata: { type: "entity", brain_reset_epoch: "0", ...metadata },
					createdAt: "2026-09-01T00:00:00.000Z",
				},
			],
		},
	}
}

afterEach(() => {
	globalThis.fetch = realFetch
})

describe("resolveEntity", () => {
	it("finds a saved entity by one of its aliases", async () => {
		stubApi(
			savedEntity({
				canonical: "Goldman Sachs",
				domain: "goldmansachs.com",
				aliases: "Goldman,GS",
			}),
		)
		const resolved = await resolveEntity(newEnv(), org, "user_1", "GS", agent)
		expect(resolved?.canonical).toBe("Goldman Sachs")
		expect(resolved?.aliases).toEqual(["Goldman", "GS"])
	})

	it("doesn't match a one-letter name against letters inside an alias", async () => {
		stubApi(
			savedEntity({
				canonical: "The Linux Foundation",
				domain: "linuxfoundation.org",
				aliases: "Linux,LF",
			}),
		)
		const resolved = await resolveEntity(newEnv(), org, "user_1", "X", agent)
		expect(resolved).toBeNull()
	})
})

describe("memoriesToMarkdown", () => {
	it("shows each memory's tag labels", () => {
		const memory: BrainMemory = {
			id: "mem_1",
			memory: "Kush owns the deploy pipeline",
			metadata: { brain_tag_labels: "Infra,Kush" },
			tags: [],
			buckets: [],
			documentIds: [],
			sourceCount: 1,
			updatedAt: "2026-09-01T00:00:00.000Z",
		}
		const markdown = memoriesToMarkdown({
			orgName: "Acme",
			exportedAt: new Date("2026-09-27T00:00:00.000Z"),
			sections: [{ heading: "Shared", description: "", memories: [memory] }],
		})
		expect(markdown).toContain("_(2026-09-01 · Infra · Kush)_")
	})
})
