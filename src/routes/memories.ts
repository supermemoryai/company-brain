import { Hono } from "hono"
import {
	privateContainerTagFor,
	SHARED_TEAM_BRAIN_CONTAINER_TAG,
} from "@/lib/spaces/provisioning"
import type { AppContext } from "@/types"
import { memoryClient } from "../memory/client"
import { memoriesToMarkdown, memoryExportFilename } from "../memory/markdown"
import { listBrainMemories } from "../memory/memories"

const RECENT_LIMIT = 8
// Upper bound for one export, per container. Reading is paged 100 at a time,
// so two containers stay inside the free plan's 50 subrequests per request.
export const EXPORT_LIMIT = 2000

async function memoryCount(env: Env, containerTag: string): Promise<number> {
	const response = await memoryClient(env).post<{
		pagination: { totalItems: number }
	}>("/v4/memories/list", {
		body: { containerTags: [containerTag], page: 1, limit: 1 },
	})
	return response.pagination.totalItems
}

/**
 * What the brain remembers, for the home page: how many memories there are and
 * the newest few. Same surface as the graph: the shared team brain plus the
 * viewer's own private container, never a teammate's.
 */
export const brainMemoriesRoutes = new Hono<AppContext>()
	.get("/", async (c) => {
		const user = c.get("user")
		if (!user || !c.get("org")) return c.json({ error: "unauthorized" }, 401)

		const containerTags = [
			SHARED_TEAM_BRAIN_CONTAINER_TAG,
			privateContainerTagFor(user.id),
		]
		const [counts, recent] = await Promise.all([
			Promise.all(containerTags.map((tag) => memoryCount(c.env, tag))),
			listBrainMemories(c.env, { containerTags, limit: RECENT_LIMIT }),
		])
		return c.json({
			count: counts.reduce((total, n) => total + n, 0),
			recent: recent.map((memory) => ({
				id: memory.id,
				memory: memory.memory,
				updatedAt: memory.updatedAt,
			})),
		})
	})
	/**
	 * Everything the viewer can see, as a Markdown download: the shared team
	 * brain and their own private memories. Same containers as the home page,
	 * so an export never includes a teammate's private memories.
	 */
	.get("/export", async (c) => {
		const user = c.get("user")
		const org = c.get("org")
		if (!user || !org) return c.json({ error: "unauthorized" }, 401)

		const [shared, personal] = await Promise.all([
			listBrainMemories(c.env, {
				containerTags: [SHARED_TEAM_BRAIN_CONTAINER_TAG],
				limit: EXPORT_LIMIT,
			}),
			listBrainMemories(c.env, {
				containerTags: [privateContainerTagFor(user.id)],
				limit: EXPORT_LIMIT,
			}),
		])
		const exportedAt = new Date()
		const markdown = memoriesToMarkdown({
			orgName: org.name,
			exportedAt,
			sections: [
				{
					heading: "Shared team brain",
					description: "What everyone in the workspace can draw on.",
					memories: shared,
				},
				{
					heading: "Only you",
					description:
						"Your private memories. Nobody else's export includes these.",
					memories: personal,
				},
			],
		})
		return c.body(markdown, 200, {
			"Content-Type": "text/markdown; charset=utf-8",
			"Content-Disposition": `attachment; filename="${memoryExportFilename(exportedAt)}"`,
			"Cache-Control": "no-store",
		})
	})
