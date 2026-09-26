import { db, eq, sql } from "@repo/db"
import * as schema from "@repo/db/schema"
import { mergedOrgMetadata } from "@/lib/org-metadata-sql"

export async function setCompanyDomain(
	env: Env,
	orgId: string,
	domain: string,
): Promise<boolean> {
	const updated = await db(env)
		.update(schema.organization)
		.set({ metadata: mergedOrgMetadata({ brainWorkspaceDomain: domain }) })
		.where(eq(schema.organization.id, orgId))
		.returning({ id: schema.organization.id })
	return updated.length > 0
}
