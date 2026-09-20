import { db, eq } from "@repo/db"
import * as schema from "@repo/db/schema"
import { ROLE_ADMIN } from "@repo/lib/permissions"
import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import * as z from "zod"
import { updateBrainModels } from "@/lib/brain/settings/models"
import {
	BRAIN_EFFORT_CHOICES,
	BRAIN_MAIN_EFFORT,
	BRAIN_MAIN_EFFORT_CHOICES,
	BRAIN_MAIN_MODEL_CHOICES,
	BRAIN_MODEL,
	BRAIN_TRIAGE_EFFORT,
	BRAIN_TRIAGE_MODEL_CHOICES,
	resolveBrainMainEffort,
	resolveBrainMainModel,
	resolveBrainTriageEffort,
	resolveBrainTriageModel,
	TRIAGE_MODEL,
} from "@/lib/brain/turn/model-profile"
import { isRecord } from "@/lib/brain/turn/util"
import { roleGate } from "@/lib/auth/role-gate"
import type { AppContext } from "@/types"

const BrainModelsSchema = z.object({
	main: z.enum(BRAIN_MAIN_MODEL_CHOICES).nullish(),
	mainEffort: z.enum(BRAIN_MAIN_EFFORT_CHOICES).nullish(),
	triage: z.enum(BRAIN_TRIAGE_MODEL_CHOICES).nullish(),
	triageEffort: z.enum(BRAIN_EFFORT_CHOICES).nullish(),
})

function resolvedFor(metadata: unknown) {
	const configuredMainEffort =
		isRecord(metadata) &&
		isRecord(metadata.brainModels) &&
		metadata.brainModels.mainEffort === "auto"
			? "auto"
			: resolveBrainMainEffort(metadata)

	return {
		main: resolveBrainMainModel(metadata),
		mainEffort: configuredMainEffort,
		triage: resolveBrainTriageModel(metadata),
		triageEffort: resolveBrainTriageEffort(metadata),
	}
}

// Per-org Company Brain model config, stored on organization.metadata.brainModels.
export const brainModelsRoutes = new Hono<AppContext>()
	.get("/", async (c) => {
		const org = c.get("org")
		if (!org) return c.json({ error: "unauthorized" }, 401)
		// Read the DB row (source of truth) rather than the possibly-stale
		// request-context org snapshot, so GET matches what PATCH persists.
		const row = await db(c.env).query.organization.findFirst({
			where: eq(schema.organization.id, org.id),
		})
		return c.json({
			resolved: resolvedFor(row?.metadata),
			defaults: {
				main: BRAIN_MODEL,
				mainEffort: BRAIN_MAIN_EFFORT,
				triage: TRIAGE_MODEL,
				triageEffort: BRAIN_TRIAGE_EFFORT,
			},
			choices: {
				main: BRAIN_MAIN_MODEL_CHOICES,
				mainEffort: BRAIN_MAIN_EFFORT_CHOICES,
				triage: BRAIN_TRIAGE_MODEL_CHOICES,
				triageEffort: BRAIN_EFFORT_CHOICES,
			},
		})
	})
	.patch(
		"/",
		describeRoute({
			// Company Brain is not part of the public API surface.
			hide: true,
			description: "Update the org's Company Brain model overrides",
			responses: {
				200: {
					description: "Resolved model configuration after the update",
				},
				401: { description: "Unauthorized" },
				404: { description: "Organization not found" },
			},
		}),
		roleGate({ minimum: ROLE_ADMIN }),
		validator("json", BrainModelsSchema),
		async (c) => {
			const org = c.get("org")
			if (!org) return c.json({ error: "unauthorized" }, 401)
			const patch = c.req.valid("json")

			const next = await updateBrainModels(c.env, org.id, patch)

			if (!next) return c.json({ error: "not_found" }, 404)
			return c.json({ resolved: resolvedFor({ brainModels: next }) })
		},
	)
