import { drizzle } from "drizzle-orm/d1"
import * as schema from "./schema"

export { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm"
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
