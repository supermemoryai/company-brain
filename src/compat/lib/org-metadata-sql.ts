import { sql } from "@repo/db"
import { organization } from "@repo/db/schema"

// better-auth writes metadata as a JSON string, so a plain `= 'object'` check falls to '{}' and wipes brainMode.
export function orgMetadataAsJsonb() {
	const col = organization.metadata
	return sql`CASE
		WHEN jsonb_typeof(${col}::jsonb) = 'object' THEN ${col}::jsonb
		WHEN jsonb_typeof(${col}::jsonb) = 'string'
			AND jsonb_typeof((${col} #>> '{}')::jsonb) = 'object'
			THEN (${col} #>> '{}')::jsonb
		ELSE '{}'::jsonb
	END`
}
