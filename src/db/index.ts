import { drizzle } from "drizzle-orm/d1"
import * as schema from "./schema"

export {
	and,
	asc,
	count,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	ne,
	notInArray,
	or,
	sql,
} from "drizzle-orm"
export * from "./schema"

export type Database = ReturnType<typeof drizzle<typeof schema>>

const cache = new WeakMap<D1Database, Database>()

/** Drizzle over the deployment's D1 database. */
export function db(env: { DB: D1Database }): Database {
	const existing = cache.get(env.DB)
	if (existing) return existing
	const instance = drizzle(env.DB, { schema })
	cache.set(env.DB, instance)
	return instance
}

/**
 * Postgres connection scoping in the original. D1 has no pool to scope, so the
 * callback just runs.
 */
export function runInDbScope<T>(run: () => T): T {
	return run()
}

/**
 * D1 rejects explicit BEGIN/COMMIT, so the callback runs against the same
 * handle and each statement commits on its own. Every caller here converges
 * through upserts or a claim token rather than relying on rollback; anything
 * that must be all-or-nothing should use `database.batch()` instead.
 */
export async function withTransaction<T>(
	database: Database,
	run: (tx: Database) => Promise<T>,
): Promise<T> {
	return run(database)
}
