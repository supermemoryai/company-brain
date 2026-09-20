import { db, eq, sql } from "@repo/db"
import * as schema from "@repo/db/schema"
import { orgMetadataAsJsonb } from "@/lib/org-metadata-sql"

export async function setCompanyDomain(
	env: Env,
	orgId: string,
	domain: string,
): Promise<boolean> {
	const patch = JSON.stringify({ brainWorkspaceDomain: domain })
	const updated = await db(env)
		.update(schema.organization)
		.set({
			metadata: sql`(${orgMetadataAsJsonb()} || ${patch}::jsonb)::json`,
		})
		.where(eq(schema.organization.id, orgId))
		.returning({ id: schema.organization.id })
	return updated.length > 0
}
