import { MIGRATIONS } from "./migrations.generated"

// Wrangler's own bookkeeping table, so `wrangler d1 migrations apply` and the
// worker agree on what has run whichever one got there first.
const MIGRATIONS_TABLE = "d1_migrations"

export type MigrationStatus = {
	applied: string[]
	pending: string[]
}

async function appliedNames(db: D1Database): Promise<Set<string>> {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT UNIQUE,
				applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
			)`,
		)
		.run()
	const { results } = await db
		.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`)
		.all<{ name: string }>()
	return new Set(results.map((row) => row.name))
}

export async function migrationStatus(env: Env): Promise<MigrationStatus> {
	const applied = await appliedNames(env.DB)
	return {
		applied: MIGRATIONS.filter((m) => applied.has(m.name)).map((m) => m.name),
		pending: MIGRATIONS.filter((m) => !applied.has(m.name)).map((m) => m.name),
	}
}

/**
 * Apply every bundled migration that hasn't run yet, in order. Each one is a
 * single D1 batch, which commits or rolls back as a whole, together with its
 * bookkeeping row. Two isolates racing here is harmless: the loser's batch
 * fails on a table that already exists and rolls back.
 */
export async function applyMigrations(env: Env): Promise<string[]> {
	const applied = await appliedNames(env.DB)
	const ran: string[] = []
	for (const migration of MIGRATIONS) {
		if (applied.has(migration.name)) continue
		await env.DB.batch([
			...migration.statements.map((statement) => env.DB.prepare(statement)),
			env.DB.prepare(
				`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES (?)`,
			).bind(migration.name),
		])
		ran.push(migration.name)
	}
	return ran
}

let ensured: Promise<void> | null = null

/**
 * Bring the database up to date once per isolate, so a fresh deploy works
 * without anyone running `wrangler d1 migrations apply`. A failure is logged
 * and retried on the next request; /setup shows what's still pending.
 */
export function ensureMigrated(env: Env): Promise<void> {
	ensured ??= applyMigrations(env).then(
		(ran) => {
			if (ran.length > 0) console.log("[db] applied migrations:", ran)
		},
		(error) => {
			ensured = null
			console.error("[db] automatic migration failed:", error)
		},
	)
	return ensured
}
