import { ROLE_ADMIN, ROLE_OWNER } from "@repo/lib/permissions"
import { getAgentByName } from "agents"
import type { Context } from "hono"
import { Hono } from "hono"
import { getBotConversations } from "@/lib/brain/slack/client"
import { getWorkspaceTokenByOrgId } from "@/lib/brain/slack/workspace"
import { assessAutomationConnections } from "@/lib/brain/tools/automation-connections"
import type { AutomationInput } from "@/lib/brain/tools/automations"
import type { CompanyBrainAgent } from "@/lib/brain/turn/agent"
import { decryptToken } from "@/lib/crypto"
import type { AppContext } from "@/types"

// Members manage their own automations; admins/owners manage all.
function isAdmin(c: Context<AppContext>): boolean {
	const role = c.get("memberRole")
	return role === ROLE_OWNER || role === ROLE_ADMIN
}

// Owner-check failures are thrown from the DO with a "forbidden" prefix.
function errStatus(err: unknown): 403 | 400 {
	return err instanceof Error && err.message.startsWith("forbidden") ? 403 : 400
}
function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : "failed to save automation"
}

async function brainAgentFor(
	c: Context<AppContext>,
	orgId: string,
): Promise<CompanyBrainAgent> {
	// Cast: the agents RPC stub type silently drops newly-added DO methods.
	return (await getAgentByName(
		c.env.COMPANY_BRAIN_AGENT,
		orgId,
	)) as unknown as CompanyBrainAgent
}

// Private channels are admin-only for automations: a member must not target a
// private channel just because the bot happens to be in it.
async function assertChannelAllowed(
	c: Context<AppContext>,
	orgId: string,
	input: AutomationInput,
	admin: boolean,
): Promise<void> {
	if (admin || input.deliverTo !== "channel" || !input.channelId) return
	// This is the only private-channel restriction, so it must fail closed: a
	// non-admin may target a channel only when it is positively verified as
	// bot-visible and non-private. Missing/unverifiable targets are rejected.
	const ws = await getWorkspaceTokenByOrgId(c.env, orgId)
	if (!ws) throw new Error("forbidden: cannot verify channel access")
	const botToken = await decryptToken(ws.botTokenEnc, c.env.ENCRYPTION_SECRET)
	const channels = await getBotConversations(botToken)
	const target = channels.find((ch) => ch.id === input.channelId)
	if (!target) throw new Error("forbidden: channel not found or not accessible")
	if (target.isPrivate)
		throw new Error("forbidden: private channels are admin-only")
}

function parseInput(body: Partial<AutomationInput>): AutomationInput {
	// Explicit enabled required — a missing value must never silently disable.
	if (typeof body.enabled !== "boolean")
		throw new Error("enabled must be provided as a boolean")
	return {
		title: body.title ?? "",
		channelId: body.channelId ?? "",
		deliverTo: body.deliverTo === "dm" ? "dm" : "channel",
		prompt: body.prompt ?? null,
		cron: body.cron ?? "",
		timezone: body.timezone ?? null,
		enabled: body.enabled,
	}
}

export const brainAutomationsRoutes = new Hono<AppContext>()
	// Admins see all automations; members see only their own.
	.get("/", async (c) => {
		const org = c.get("org")
		const user = c.get("user")
		if (!org || !user) return c.json({ error: "unauthorized" }, 401)
		const agent = await brainAgentFor(c, org.id)
		const automations = await agent.listAutomations(user.id, isAdmin(c))
		return c.json({ automations, isAdmin: isAdmin(c), viewerId: user.id })
	})
	// Channels the bot can post to, for the target picker.
	.get("/channels", async (c) => {
		const org = c.get("org")
		const user = c.get("user")
		if (!org || !user) return c.json({ error: "unauthorized" }, 401)
		const ws = await getWorkspaceTokenByOrgId(c.env, org.id)
		if (!ws) return c.json({ channels: [] })
		const botToken = await decryptToken(
			ws.botTokenEnc,
			c.env.ENCRYPTION_SECRET,
		)
		const channels = await getBotConversations(botToken)
		const visible = isAdmin(c)
			? channels
			: channels.filter((ch) => !ch.isPrivate)
		return c.json({ channels: visible })
	})
	// Any member can create their own automation.
	.post("/", async (c) => {
		const org = c.get("org")
		const user = c.get("user")
		if (!org || !user) return c.json({ error: "unauthorized" }, 401)
		const body = await c.req
			.json<Partial<AutomationInput>>()
			.catch(() => ({}) as Partial<AutomationInput>)
		const agent = await brainAgentFor(c, org.id)
		try {
			const input = parseInput(body)
			await assertChannelAllowed(c, org.id, input, isAdmin(c))
			const automation = await agent.createAutomation(
				input,
				user.id,
				user.email,
				isAdmin(c),
			)
			const { warnings } = await assessAutomationConnections(
				c.env,
				org.id,
				user.id,
				input.deliverTo === "dm" ? "dm" : "channel",
			).catch(() => ({ warnings: [] }))
			return c.json({ automation, warnings })
		} catch (err) {
			return c.json({ error: errMessage(err) }, errStatus(err))
		}
	})
	// Owner or admin.
	.put("/:id", async (c) => {
		const org = c.get("org")
		const user = c.get("user")
		if (!org || !user) return c.json({ error: "unauthorized" }, 401)
		const body = await c.req
			.json<Partial<AutomationInput>>()
			.catch(() => ({}) as Partial<AutomationInput>)
		const agent = await brainAgentFor(c, org.id)
		try {
			const input = parseInput(body)
			await assertChannelAllowed(c, org.id, input, isAdmin(c))
			const automation = await agent.updateAutomation(
				c.req.param("id"),
				input,
				user.id,
				user.email,
				isAdmin(c),
			)
			// Judge the owner's connections; their app names stay private to them,
			// so skip the lookup entirely on cross-user admin edits.
			const owner = automation.createdBy ?? user.id
			const warnings =
				owner === user.id
					? (
							await assessAutomationConnections(
								c.env,
								org.id,
								owner,
								input.deliverTo === "dm" ? "dm" : "channel",
							).catch(() => ({ warnings: [] }))
						).warnings
					: []
			return c.json({ automation, warnings })
		} catch (err) {
			return c.json({ error: errMessage(err) }, errStatus(err))
		}
	})
	// Owner or admin.
	.delete("/:id", async (c) => {
		const org = c.get("org")
		const user = c.get("user")
		if (!org || !user) return c.json({ error: "unauthorized" }, 401)
		const agent = await brainAgentFor(c, org.id)
		try {
			await agent.deleteAutomation(c.req.param("id"), user.id, isAdmin(c))
			return c.json({ ok: true })
		} catch (err) {
			return c.json({ error: errMessage(err) }, errStatus(err))
		}
	})
	// Owner or admin: fire it immediately.
	.post("/:id/run-now", async (c) => {
		const org = c.get("org")
		const user = c.get("user")
		if (!org || !user) return c.json({ error: "unauthorized" }, 401)
		const agent = await brainAgentFor(c, org.id)
		try {
			const result = await agent.runAutomationNow(
				c.req.param("id"),
				user.id,
				isAdmin(c),
			)
			return c.json(result, result.ok ? 200 : 400)
		} catch (err) {
			return c.json({ error: errMessage(err) }, errStatus(err))
		}
	})
