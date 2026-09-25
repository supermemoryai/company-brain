import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { MIGRATIONS } from "./migrations.generated"

const drizzleDir = join(__dirname, "../../drizzle")

describe("bundled migrations", () => {
	it("match drizzle/ (run `bun run db:generate` after changing the schema)", () => {
		const journal = JSON.parse(
			readFileSync(join(drizzleDir, "meta/_journal.json"), "utf8"),
		) as { entries: Array<{ tag: string }> }

		expect(MIGRATIONS.map((m) => m.name)).toEqual(
			journal.entries.map((entry) => `${entry.tag}.sql`),
		)
		for (const migration of MIGRATIONS) {
			const statements = readFileSync(join(drizzleDir, migration.name), "utf8")
				.split("--> statement-breakpoint")
				.map((statement) => statement.trim())
				.filter(Boolean)
			expect(migration.statements).toEqual(statements)
		}
	})
})
