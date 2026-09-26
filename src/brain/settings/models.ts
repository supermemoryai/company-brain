import { db, eq, sql, withTransaction } from "@repo/db"
import * as schema from "@repo/db/schema"
import { orgMetadataObject } from "@/lib/org-metadata-sql"
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
	return withTransaction(db(env), async (tx) => {
		const [row] = await tx
			.select({ metadata: schema.organization.metadata })
			.from(schema.organization)
			.where(eq(schema.organization.id, orgId))
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

		// Replace only the brainModels subtree so other keys aren't clobbered.
		await tx
			.update(schema.organization)
			.set({
				metadata: sql`json_set(${orgMetadataObject()}, '$.brainModels', json(${JSON.stringify(merged)}))`,
			})
			.where(eq(schema.organization.id, orgId))
		return merged
	})
}
