import { Hono } from "hono"
import * as z from "zod"
import { validator } from "hono-openapi"
import {
	privateContainerTagFor,
	SHARED_TEAM_BRAIN_CONTAINER_TAG,
} from "@/lib/spaces/provisioning"
import type { AppContext } from "@/types"
import { memoryClient } from "../memory/client"

const GraphPageSchema = z.object({
	page: z.number().int().min(1).default(1),
	limit: z.number().int().min(1).max(500).default(200),
})

type MemoryEntry = { spaceContainerTag?: string | null } & Record<
	string,
	unknown
>

type DocumentsWithMemories = {
	documents: Array<
		{ content?: unknown; memoryEntries?: MemoryEntry[] } & Record<
			string,
			unknown
		>
	>
	pagination: Record<string, number>
}

/**
 * Documents and their memories for the graph. A person sees the shared team
 * brain and their own private container, never a teammate's; memory entries
 * are filtered server-side so nothing outside that surface reaches the page.
 */
export const brainGraphRoutes = new Hono<AppContext>().post(
	"/",
	validator("json", GraphPageSchema),
	async (c) => {
		const user = c.get("user")
		if (!user || !c.get("org")) return c.json({ error: "unauthorized" }, 401)

		const containerTags = [
			SHARED_TEAM_BRAIN_CONTAINER_TAG,
			privateContainerTagFor(user.id),
		]
		const { page, limit } = c.req.valid("json")
		// The SDK has no method for documents-with-memories; the route is public.
		const response = await memoryClient(c.env).post<DocumentsWithMemories>(
			"/v3/documents/documents",
			{
				body: { page, limit, sort: "createdAt", order: "desc", containerTags },
			},
		)

		const allowed = new Set(containerTags)
		return c.json({
			pagination: response.pagination,
			documents: response.documents.map(({ content: _content, ...doc }) => ({
				...doc,
				memoryEntries: (doc.memoryEntries ?? []).filter(
					(entry) =>
						entry.spaceContainerTag != null &&
						allowed.has(entry.spaceContainerTag),
				),
			})),
		})
	},
)
