import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, vi } from "vitest"

vi.mock("../tools/mcp/store", () => ({ getConnectionById: async () => null }))
vi.mock("../turn/agent", () => ({ brainAgent: () => ({ env: {} }) }))

const { ensureLeaseTables, hasOpenLeaseForServer } = await import("./store")

function fakeAgent() {
	const db = new DatabaseSync(":memory:")
	const sql = (strings: TemplateStringsArray, ...values: unknown[]) =>
		db.prepare(strings.join("?")).all(...(values as never[]))
	return { name: "org", sql } as never
}

describe("hasOpenLeaseForServer", () => {
	it("lets a read-only lease be upgraded to write in the same thread", () => {
		const agent = fakeAgent()
		ensureLeaseTables(agent)
		;(agent as { sql: Function }).sql`
			INSERT INTO brain_lease (request_id, org_id, team_id, channel, thread_ts,
				lessee_user_id, lessee_slack_user, server_slug, mode, reason,
				capability_summary, candidate_approvers_json, status, created_at, expires_at)
			VALUES ('r1', 'org', 'T1', 'C1', '1.0', 'u1', 'U1', 'linear', 'read_only',
				'', '', '[]', 'active', 0, ${Date.now() + 60_000})
		`
		const open = (mode: "read_only" | "read_write") =>
			hasOpenLeaseForServer(agent, "org", "T1", "C1", "u1", "linear", "1.0", mode)

		expect(open("read_only")).toBe(true)
		expect(open("read_write")).toBe(false)
	})
})
