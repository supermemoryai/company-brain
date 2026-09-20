import { ROLE_ADMIN, ROLE_OWNER } from "@repo/lib/permissions"
import { getAgentByName } from "agents"
import type { Context } from "hono"
import { Hono } from "hono"

import {
	assertOrgSkillScopeAuthorized,
	type SkillCreateInput,
	type SkillEditableInput,
} from "@/lib/brain/skills/store"
import {
	parseSkillMarkdown,
	SKILL_ORIGINS,
	SkillValidationError,
	validateSkillInput,
} from "@/lib/brain/skills/validation"
import type { CompanyBrainAgent } from "@/lib/brain/turn/agent"
import type { AppContext, AuthOrganization } from "@/types"
import { classifySkillHttpError } from "./skills-http-errors"

function isAdmin(c: Context<AppContext>): boolean {
	const role = c.get("memberRole")
	return role === ROLE_OWNER || role === ROLE_ADMIN
}

function skillOrg(org: AuthOrganization) {
	return {
		id: org.id,
		name: org.name,
		slug: org.slug,
		metadata: org.metadata ?? null,
	}
}

function requireOrg(c: Context<AppContext>): AuthOrganization | Response {
	const org = c.get("org")
	if (!org) return c.json({ error: "unauthorized" }, 401)
	return org
}

async function brainAgentFor(
	c: Context<AppContext>,
	orgId: string,
): Promise<CompanyBrainAgent> {
	return (await getAgentByName(
		c.env.COMPANY_BRAIN_AGENT,
		orgId,
	)) as unknown as CompanyBrainAgent
}

function errorResponse(c: Context<AppContext>, error: unknown) {
	const classified = classifySkillHttpError(error)
	return c.json({ error: classified.message }, classified.status)
}

function editableFromBody(
	body: Partial<SkillEditableInput>,
): SkillEditableInput {
	return {
		name: body.name ?? "",
		description: body.description ?? "",
		body: body.body ?? "",
		scope: body.scope as SkillEditableInput["scope"],
	}
}

function requiredVersion(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new SkillValidationError("version must be a positive integer")
	}
	return value
}

export const brainSkillsRoutes = new Hono<AppContext>()
	.get("/", async (c) => {
		const required = requireOrg(c)
		if (required instanceof Response) return required
		const user = c.get("user")
		if (!user) return c.json({ error: "unauthorized" }, 401)
		const admin = isAdmin(c)
		const agent = await brainAgentFor(c, required.id)
		const skills = await agent.listSkills(user.id, admin)
		return c.json({
			skills,
			isAdmin: admin,
			viewerId: user.id,
		})
	})
	.post("/upload", async (c) => {
		const required = requireOrg(c)
		if (required instanceof Response) return required
		if (!c.get("user")) return c.json({ error: "unauthorized" }, 401)
		const body = await c.req
			.json<{ content?: unknown }>()
			.catch(() => ({ content: undefined }))
		try {
			if (typeof body.content !== "string") {
				throw new SkillValidationError("content required")
			}
			return c.json({ draft: parseSkillMarkdown(body.content) })
		} catch (error) {
			return errorResponse(c, error)
		}
	})
	.post("/", async (c) => {
		const required = requireOrg(c)
		if (required instanceof Response) return required
		const user = c.get("user")
		if (!user) return c.json({ error: "unauthorized" }, 401)
		const body = await c.req
			.json<Partial<SkillCreateInput>>()
			.catch(() => ({}) as Partial<SkillCreateInput>)
		try {
			const admin = isAdmin(c)
			const editable = validateSkillInput(editableFromBody(body))
			assertOrgSkillScopeAuthorized(editable.scope, admin)
			const agent = await brainAgentFor(c, required.id)
			const origin =
				body.origin && SKILL_ORIGINS.includes(body.origin)
					? body.origin === "upload"
						? "upload"
						: "web"
					: "web"
			const skill = await agent.createSkill(
				skillOrg(required),
				{
					...editable,
					origin,
					creatorSlackUserId: null,
					sourceTeamId: null,
					sourceThread: null,
				},
				user.id,
				admin,
			)
			return c.json({ skill }, 201)
		} catch (error) {
			return errorResponse(c, error)
		}
	})
	.put("/:id", async (c) => {
		const required = requireOrg(c)
		if (required instanceof Response) return required
		const user = c.get("user")
		if (!user) return c.json({ error: "unauthorized" }, 401)
		const body = await c.req
			.json<Partial<SkillEditableInput> & { expectedVersion?: unknown }>()
			.catch(
				() =>
					({}) as Partial<SkillEditableInput> & {
						expectedVersion?: unknown
					},
			)
		try {
			const admin = isAdmin(c)
			const editable = validateSkillInput(editableFromBody(body))
			const expectedVersion = requiredVersion(body.expectedVersion)
			assertOrgSkillScopeAuthorized(editable.scope, admin)
			const agent = await brainAgentFor(c, required.id)
			const skill = await agent.updateSkill(
				skillOrg(required),
				c.req.param("id"),
				editable,
				user.id,
				admin,
				expectedVersion,
			)
			return c.json({ skill })
		} catch (error) {
			return errorResponse(c, error)
		}
	})
	.delete("/:id", async (c) => {
		const required = requireOrg(c)
		if (required instanceof Response) return required
		const user = c.get("user")
		if (!user) return c.json({ error: "unauthorized" }, 401)
		const body = await c.req
			.json<{ expectedVersion?: unknown }>()
			.catch(() => ({ expectedVersion: undefined }))
		try {
			const expectedVersion = requiredVersion(body.expectedVersion)
			const agent = await brainAgentFor(c, required.id)
			await agent.deleteSkill(
				c.req.param("id"),
				user.id,
				isAdmin(c),
				expectedVersion,
			)
			return c.json({ ok: true })
		} catch (error) {
			return errorResponse(c, error)
		}
	})
