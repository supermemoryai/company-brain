import { db, sql } from "@repo/db"
import * as schema from "@repo/db/schema"
import { mergedOrgMetadata } from "@/lib/org-metadata-sql"

// Merge-not-replace, so a concurrent writer to other keys isn't clobbered.
export async function mergeOrgMetadata(
	env: Env,
	orgId: string,
	patch: Record<string, unknown>,
): Promise<void> {
	await db(env)
		.update(schema.organization)
		.set({ metadata: mergedOrgMetadata(patch) })
		.where(sql`${schema.organization.id} = ${orgId}`)
}
