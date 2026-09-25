import { ROLE_ADMIN } from "@repo/lib/permissions"
import { MAX_WORKSPACE_PROMPT_LENGTH } from "@repo/lib/constants"
import { getAgentByName } from "agents"
import { Hono } from "hono"
import { validator } from "hono-openapi"
import * as z from "zod"
import { roleGate } from "@/lib/auth/role-gate"
import type { AppContext } from "@/types"

const WorkspacePromptSchema = z.object({
	workspacePrompt: z.string().max(MAX_WORKSPACE_PROMPT_LENGTH).nullable(),
})

// Standing workspace instructions, kept in the org's agent Durable Object.
// The hosted app read these through the generic org settings endpoint.
export const brainWorkspacePromptRoutes = new Hono<AppContext>()
	.get("/", async (c) => {
		const org = c.get("org")
		if (!org) return c.json({ error: "unauthorized" }, 401)
		const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, org.id)
		return c.json({ workspacePrompt: await agent.getWorkspacePrompt() })
	})
	.put(
		"/",
		roleGate({ minimum: ROLE_ADMIN }),
		validator("json", WorkspacePromptSchema),
		async (c) => {
			const org = c.get("org")
			if (!org) return c.json({ error: "unauthorized" }, 401)
			const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, org.id)
			const workspacePrompt = await agent.setWorkspacePrompt(
				c.req.valid("json").workspacePrompt,
			)
			return c.json({ workspacePrompt })
		},
	)
