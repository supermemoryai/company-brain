import { describe, expect, it } from "vitest"
import type {
	McpApprovalClassifier,
	McpOperationEffect,
} from "./approval-classifier"
import { classifyMcpOperation, decideMcpNativeCallPolicy } from "./policy"
import {
	isQueryTool,
	queryToolCallHasDdl,
	queryToolCallHasDml,
	sqlContainsDdl,
	sqlContainsDml,
} from "./sql-query-check"

/** Runs the same decision the connected-app runtime makes before a call. */
async function decide(args: {
	method: string
	input: unknown
	readOnly?: boolean
	annotations?: { readOnlyHint?: boolean }
	classifierEffect?: McpOperationEffect
}) {
	let classifierCalls = 0
	const classifier: McpApprovalClassifier = {
		classify: async () => {
			classifierCalls += 1
			return { effect: args.classifierEffect ?? "read", reason: "fake" }
		},
		callsUsed: () => classifierCalls,
	}
	const classified = await classifyMcpOperation({
		serverSlug: "db",
		method: args.method,
		inputSchema: {},
		input: args.input,
		annotations: args.annotations,
		trustedAnnotations: Boolean(args.annotations),
		classifier,
	})
	const { decision } = decideMcpNativeCallPolicy({
		effect: classified.effect,
		readOnly: args.readOnly ?? false,
		toolIdentity: `db.${args.method}`,
		reason: classified.reason,
	})
	return {
		decision,
		effect: classified.effect,
		source: classified.source,
		classifierCalls,
	}
}

describe("sqlContainsDml", () => {
	it.each([
		["INSERT INTO users (email) VALUES ('a@b.c')"],
		["insert or replace into cache values (1)"],
		["UPDATE users SET role = 'admin' WHERE id = 7"],
		["update public.users u set active = false"],
		["DELETE FROM customers WHERE plan = 'free'"],
		["DELETE users WHERE id = 1"],
		["MERGE INTO stock s USING delivery d ON s.id = d.id WHEN MATCHED THEN UPDATE SET qty = 0"],
		["REPLACE INTO settings VALUES (1, 'x')"],
		["SELECT 1; DELETE FROM audit_log"],
		["WITH gone AS (DELETE FROM sessions RETURNING id) SELECT count(*) FROM gone"],
		["  \n  delete\n  from   orders"],
	])("DML-%# flags: %s", (sql) => {
		expect(sqlContainsDml(sql)).toBe(true)
	})

	it.each([
		["SELECT id, email FROM users LIMIT 10"],
		["select count(*) from orders where status = 'delete from queue'"],
		["-- DELETE FROM users\nSELECT 1"],
		["/* UPDATE users SET x = 1 */ SELECT 1"],
		["SELECT updated_at, deleted_at FROM users"],
		["SELECT * FROM inserts JOIN updates USING (id)"],
		["EXPLAIN SELECT * FROM orders"],
	])("READ-%# does not flag: %s", (sql) => {
		expect(sqlContainsDml(sql)).toBe(false)
	})
})

describe("isQueryTool", () => {
	it.each([["query"], ["run_query"], ["executeQuery"], ["execute_sql"], ["EXECUTE-SQL"], ["query_database"]])(
		"%s is a query tool",
		(name) => expect(isQueryTool(name)).toBe(true),
	)
	it.each([["search_issues"], ["list_tables"], ["get_user"]])(
		"%s is not a query tool",
		(name) => expect(isQueryTool(name)).toBe(false),
	)
})

describe("queryToolCallHasDml", () => {
	it("finds SQL nested inside objects and arrays", () => {
		expect(
			queryToolCallHasDml("query", {
				batch: [{ sql: "select 1" }, { sql: "INSERT INTO t VALUES (1)" }],
			}),
		).toBe(true)
	})

	it("ignores search tools even when the search text looks like SQL", () => {
		expect(
			queryToolCallHasDml("search_issues", { query: "delete from list is broken" }),
		).toBe(false)
	})
})

describe("approval decision for query tools", () => {
	it("TC-1 `query` with DELETE now pauses for approval (was: ran with no card)", async () => {
		const r = await decide({ method: "query", input: { sql: "DELETE FROM customers" } })
		expect(r.decision).toBe("pause")
		expect(r.source).toBe("sql_dml")
	})

	it("TC-2 `run_query` with UPDATE pauses", async () => {
		const r = await decide({
			method: "run_query",
			input: { query: "UPDATE users SET role = 'admin'" },
		})
		expect(r.decision).toBe("pause")
	})

	it("TC-3 `executeQuery` with INSERT pauses", async () => {
		const r = await decide({
			method: "executeQuery",
			input: { statement: "INSERT INTO invoices VALUES (1)" },
		})
		expect(r.decision).toBe("pause")
	})

	it("TC-4 DML on a read-only connection is refused outright", async () => {
		const r = await decide({
			method: "query",
			input: { sql: "DELETE FROM customers" },
			readOnly: true,
		})
		expect(r.decision).toBe("deny")
	})

	it("TC-5 a trusted readOnlyHint does not wave DML through", async () => {
		const r = await decide({
			method: "query",
			input: { sql: "DELETE FROM customers" },
			annotations: { readOnlyHint: true },
		})
		expect(r.decision).toBe("pause")
	})

	it("TC-6 `query` with a plain SELECT still runs with no card and no extra model call", async () => {
		const r = await decide({ method: "query", input: { sql: "SELECT * FROM users" } })
		expect(r.decision).toBe("allow")
		expect(r.classifierCalls).toBe(0)
	})

	it("TC-7 a search tool with SQL-looking text is unaffected", async () => {
		const r = await decide({
			method: "search_issues",
			input: { query: "delete from list is broken" },
		})
		expect(r.decision).toBe("allow")
	})
})

// ── Step 2: DROP, ALTER, TRUNCATE ──────────────────────────────────────────

describe("sqlContainsDdl", () => {
	it.each([
		["DROP TABLE invoices"],
		["drop table if exists invoices"],
		["DROP DATABASE prod"],
		["DROP SCHEMA billing CASCADE"],
		["DROP MATERIALIZED VIEW daily_stats"],
		["DROP INDEX idx_users_email"],
		["DROP USER analyst"],
		["ALTER TABLE users DROP COLUMN email"],
		["ALTER TABLE users ADD COLUMN age int"],
		["ALTER USER admin WITH PASSWORD 'x'"],
		["ALTER ROLE analyst SUPERUSER"],
		["TRUNCATE orders"],
		["TRUNCATE TABLE audit_log"],
		["truncate only public.events"],
		["SELECT 1; DROP TABLE users"],
		["select 1;\n\n  TRUNCATE\n  sessions"],
	])("DDL-%# flags: %s", (sql) => {
		expect(sqlContainsDdl(sql)).toBe(true)
	})

	it.each([
		["SELECT TRUNCATE(price, 2) FROM products"],
		["SELECT truncate(1.234, 1)"],
		["SELECT drop_rate, alter_count FROM metrics"],
		["SELECT * FROM alter_log JOIN drop_events USING (id)"],
		["SELECT * FROM jobs WHERE note = 'drop table next sprint'"],
		["-- DROP TABLE users\nSELECT 1"],
		["/* TRUNCATE orders */ SELECT count(*) FROM orders"],
		["SELECT date_trunc('day', created_at) FROM events"],
	])("SAFE-%# does not flag: %s", (sql) => {
		expect(sqlContainsDdl(sql)).toBe(false)
	})

	it("DDL is not mistaken for DML and vice versa", () => {
		expect(sqlContainsDml("DROP TABLE x")).toBe(false)
		expect(sqlContainsDdl("DELETE FROM x")).toBe(false)
	})
})

describe("queryToolCallHasDdl", () => {
	it("finds DDL nested inside arguments", () => {
		expect(
			queryToolCallHasDdl("run_query", {
				steps: [{ sql: "select 1" }, { sql: "TRUNCATE sessions" }],
			}),
		).toBe(true)
	})

	it("ignores non-query tools", () => {
		expect(queryToolCallHasDdl("search_docs", { query: "drop table syntax" })).toBe(false)
	})
})

describe("approval decision for DROP, ALTER, TRUNCATE", () => {
	it("TC-8 `query` with DROP TABLE pauses and is marked destructive", async () => {
		const r = await decide({ method: "query", input: { sql: "DROP TABLE invoices" } })
		expect(r.decision).toBe("pause")
		expect(r.effect).toBe("destructive")
		expect(r.source).toBe("sql_ddl")
	})

	it("TC-9 `execute_sql` with ALTER TABLE pauses", async () => {
		const r = await decide({
			method: "execute_sql",
			input: { sql: "ALTER TABLE users DROP COLUMN email" },
		})
		expect(r.decision).toBe("pause")
		expect(r.effect).toBe("destructive")
	})

	it("TC-10 `runQuery` with TRUNCATE pauses", async () => {
		const r = await decide({ method: "runQuery", input: { query: "TRUNCATE audit_log" } })
		expect(r.decision).toBe("pause")
	})

	it("TC-11 DDL on a read-only connection is refused outright", async () => {
		const r = await decide({
			method: "query",
			input: { sql: "DROP DATABASE prod" },
			readOnly: true,
		})
		expect(r.decision).toBe("deny")
	})

	it("TC-12 a trusted readOnlyHint does not wave DDL through", async () => {
		const r = await decide({
			method: "query",
			input: { sql: "TRUNCATE orders" },
			annotations: { readOnlyHint: true },
		})
		expect(r.decision).toBe("pause")
	})

	it("TC-13 a statement with both DDL and DML is labelled destructive", async () => {
		const r = await decide({
			method: "query",
			input: { sql: "DELETE FROM a; DROP TABLE b" },
		})
		expect(r.effect).toBe("destructive")
	})

	it("TC-14 SELECT TRUNCATE(price, 2) still runs with no card", async () => {
		const r = await decide({
			method: "query",
			input: { sql: "SELECT TRUNCATE(price, 2) FROM products" },
		})
		expect(r.decision).toBe("allow")
		expect(r.classifierCalls).toBe(0)
	})
})