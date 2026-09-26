import { sql } from "@repo/db"
import { organization } from "@repo/db/schema"

/**
 * The organization's metadata as a JSON object, in SQLite. Anything that isn't
 * a JSON object (null, a bare string, invalid text) reads as `{}`, so a merge
 * never throws and never writes a non-object back.
 */
export function orgMetadataObject() {
	const col = organization.metadata
	return sql`(CASE
		WHEN json_valid(${col}) AND json_type(${col}) = 'object' THEN ${col}
		ELSE '{}'
	END)`
}

/** Merge `patch` into the organization's metadata without clobbering other keys. */
export function mergedOrgMetadata(patch: Record<string, unknown>) {
	return sql`json_patch(${orgMetadataObject()}, ${JSON.stringify(patch)})`
}
