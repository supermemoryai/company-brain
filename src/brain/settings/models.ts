import { db, eq, sql } from "@repo/db"
import * as schema from "@repo/db/schema"
import { orgMetadataAsJsonb } from "@/lib/org-metadata-sql"
import { isRecord } from "../turn/util"

const BRAIN_MODEL_KEYS = [
	"main",
	"mainEffort",
	"triage",
	"triageEffort",
] as const

export type BrainModelsPatch = Partial<
	Record<(typeof BRAIN_MODEL_KEYS)[number], string | null>
>

// Shared by the route and the tool; null deletes an override, null result = no org.
export async function updateBrainModels(
	env: Env,
	orgId: string,
	patch: BrainModelsPatch,
): Promise<Record<string, unknown> | null> {
	return db(env).transaction(async (tx) => {
		const [row] = await tx
			.select({ metadata: schema.organization.metadata })
			.from(schema.organization)
			.where(eq(schema.organization.id, orgId))
			.for("update")
		if (!row) return null

		const merged: Record<string, unknown> =
			isRecord(row.metadata) && isRecord(row.metadata.brainModels)
				? { ...(row.metadata.brainModels as Record<string, unknown>) }
				: {}
		for (const key of BRAIN_MODEL_KEYS) {
			if (!(key in patch)) continue
			const value = patch[key]
			if (value == null) delete merged[key]
			else merged[key] = value
		}

		// jsonb_set only the brainModels subtree so other keys aren't clobbered.
		await tx
			.update(schema.organization)
			.set({
				metadata: sql`jsonb_set(${orgMetadataAsJsonb()}, '{brainModels}', ${JSON.stringify(merged)}::jsonb, true)::json`,
			})
			.where(eq(schema.organization.id, orgId))
		return merged
	})
}
