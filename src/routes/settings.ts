import { db, eq } from "@repo/db"
import * as schema from "@repo/db/schema"
import { ROLE_ADMIN } from "@repo/lib/permissions"
import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import * as z from "zod"
import { updateBrainProactivity } from "@/lib/brain/settings/proactivity"
import {
	BRAIN_CHANNEL_PROACTIVITY,
	BRAIN_PROACTIVITY_DEFAULTS,
	DEFAULT_BRAIN_PROACTIVITY,
	parseBrainProactivity,
} from "@/lib/brain/slack/proactivity"
import { roleGate } from "@/lib/auth/role-gate"
import type { AppContext } from "@/types"

const SlackChannelIdSchema = z.string().regex(/^[CDG][A-Z0-9]{4,30}$/)

const ProactivityPatchSchema = z.object({
	default: z.enum(BRAIN_PROACTIVITY_DEFAULTS).nullish(),
	// null value deletes that channel's override; channels: null clears them all.
	channels: z
		.record(SlackChannelIdSchema, z.enum(BRAIN_CHANNEL_PROACTIVITY).nullable())
		.nullish(),
})

const BrainSettingsSchema = z.object({
	proactivity: ProactivityPatchSchema.nullish(),
})

function proactivityView(raw: unknown) {
	const settings = parseBrainProactivity(raw)
	return {
		default: settings.default ?? DEFAULT_BRAIN_PROACTIVITY,
		channels: settings.channels ?? {},
	}
}

function settingsResponse(raw: unknown) {
	return {
		proactivity: proactivityView(raw),
		choices: {
			proactivityDefault: BRAIN_PROACTIVITY_DEFAULTS,
			channelProactivity: BRAIN_CHANNEL_PROACTIVITY,
		},
	}
}

// Org-wide Company Brain behavior settings, stored on organization_settings.
export const brainSettingsRoutes = new Hono<AppContext>()
	.get("/", async (c) => {
		const org = c.get("org")
		if (!org) return c.json({ error: "unauthorized" }, 401)
		const row = await db(c.env).query.organizationSettings.findFirst({
			where: eq(schema.organizationSettings.orgId, org.id),
			columns: { brainProactivity: true },
		})
		return c.json(settingsResponse(row?.brainProactivity))
	})
	.patch(
		"/",
		describeRoute({
			// Company Brain is not part of the public API surface.
			hide: true,
			description: "Update org-wide Company Brain behavior settings",
			responses: {
				200: { description: "Resolved settings after the update" },
				401: { description: "Unauthorized" },
				422: { description: "Too many channel overrides" },
			},
		}),
		roleGate({ minimum: ROLE_ADMIN }),
		validator("json", BrainSettingsSchema),
		async (c) => {
			const org = c.get("org")
			if (!org) return c.json({ error: "unauthorized" }, 401)
			const patch = c.req.valid("json")
			const proactivityPatch = patch.proactivity
			if (proactivityPatch === undefined) {
				const row = await db(c.env).query.organizationSettings.findFirst({
					where: eq(schema.organizationSettings.orgId, org.id),
					columns: { brainProactivity: true },
				})
				return c.json(settingsResponse(row?.brainProactivity))
			}

			const result = await updateBrainProactivity(
				c.env,
				org.id,
				proactivityPatch ?? null,
			)

			if ("error" in result) return c.json({ error: result.error }, 422)
			return c.json(settingsResponse(result.merged))
		},
	)
