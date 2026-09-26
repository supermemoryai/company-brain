import { Hono } from "hono"
import {
	privateContainerTagFor,
	SHARED_TEAM_BRAIN_CONTAINER_TAG,
} from "@/lib/spaces/provisioning"
import type { AppContext } from "@/types"
import { memoryClient } from "../memory/client"
import { listBrainMemories } from "../memory/memories"

const RECENT_LIMIT = 8

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
export const brainMemoriesRoutes = new Hono<AppContext>().get("/", async (c) => {
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
