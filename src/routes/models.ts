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
import {
	availableProviders,
	preferredRouter,
} from "@/lib/brain/turn/brain-model"
import { orcaCatalogFor } from "@/lib/brain/turn/orcarouter-models"
import { envOrcaCatalogCache } from "@/lib/brain/turn/orcarouter-store"
import { getModelInfo, type SupportedModel } from "@/lib/model-registry"
import { isRecord } from "@/lib/brain/turn/util"
import { roleGate } from "@/lib/auth/role-gate"
import type { AppContext } from "@/types"

const BrainModelsSchema = z.object({
	main: z.enum(BRAIN_MAIN_MODEL_CHOICES).nullish(),
	mainEffort: z.enum(BRAIN_MAIN_EFFORT_CHOICES).nullish(),
	triage: z.enum(BRAIN_TRIAGE_MODEL_CHOICES).nullish(),
	triageEffort: z.enum(BRAIN_EFFORT_CHOICES).nullish(),
})

/**
 * Whether this surface must only offer models that declare the ability to
 * read an uploaded image. Company Brain attaches Slack images and PDFs to a
 * turn (`slack/attachments.ts`), so the answer models are filtered on it.
 */
export type ModelSurface = "main" | "triage"

export type OrcaModelOption = {
	id: string
	name: string
	contextLength?: number
	reasoningEfforts?: readonly string[]
}

export type ModelsCatalogSection = {
	degraded: boolean
	degradedReason?: string
	source: "live" | "seed"
	options: OrcaModelOption[]
}

/**
 * The OrcaRouter dropdown for one surface, filtered to what that surface
 * actually does. The list is the live catalog when discovery succeeded, the
 * last known-good list next, and otherwise the small verified seed — never a
 * free-text field and never a hand-written sample presented as the catalog.
 */
export async function orcaCatalogSection(
	env: Env,
	surface: ModelSurface,
): Promise<ModelsCatalogSection> {
	const catalog = await orcaCatalogFor(
		env,
		surface === "main" ? "chat-multimodal" : "chat",
		{
			apiKey: env.ORCA_API_KEY,
			cache: envOrcaCatalogCache(env),
		},
	)
	return {
		degraded: catalog.source === "seed" || catalog.degradedReason !== undefined,
		degradedReason: catalog.degradedReason,
		source: catalog.source,
		options: catalog.models.map((model) => ({
			id: model.id,
			name: model.name,
			contextLength: model.contextLength,
		})),
	}
}

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

// Offer only models whose provider this deployment has a key for; picking any
// other would silently fall back to a different provider at run time.
function usableModels<T extends SupportedModel>(
	env: Env,
	models: readonly T[],
): T[] {
	const providers = new Set(availableProviders(env))
	return models.filter((model) => providers.has(getModelInfo(model).provider))
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
		// When OrcaRouter is the router in play, the pickable models are the
		// ones its catalog actually offers for this surface.
		const router = preferredRouter(c.env)
		const orcaCatalog =
			router === "orcarouter"
				? {
						main: await orcaCatalogSection(c.env, "main"),
						triage: await orcaCatalogSection(c.env, "triage"),
					}
				: null
		return c.json({
			resolved: resolvedFor(row?.metadata),
			defaults: {
				main: BRAIN_MODEL,
				mainEffort: BRAIN_MAIN_EFFORT,
				triage: TRIAGE_MODEL,
				triageEffort: BRAIN_TRIAGE_EFFORT,
			},
			router,
			orca: orcaCatalog,
			choices: {
				main: usableModels(c.env, BRAIN_MAIN_MODEL_CHOICES),
				mainEffort: BRAIN_MAIN_EFFORT_CHOICES,
				triage: usableModels(c.env, BRAIN_TRIAGE_MODEL_CHOICES),
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
