/**
 * Finds SQL data-changing statements (DML) in the arguments of a query tool.
 *
 * Why: tools named `query`, `run_query` or `execute_sql` take free-form SQL.
 * The word "query" is on the read-verb list, so `query({ sql: "DELETE ..." })`
 * used to run with no Approve/Deny card. The tool's name cannot tell a SELECT
 * from a DELETE; the SQL text can.
 *
 * Scope, for tools whose name contains "query" or "sql":
 *   - DML (step 1): INSERT, UPDATE, DELETE, MERGE, REPLACE, UPSERT
 *   - DDL (step 2): DROP, ALTER, TRUNCATE
 */

/** Name tokens that mark a tool as one that runs caller-supplied SQL. */
const QUERY_TOOL_TOKENS = new Set(["query", "queries", "sql"])

const DML_PATTERNS: RegExp[] = [
	/\binsert\s+(?:or\s+\w+\s+)?into\b/i, // INSERT INTO, INSERT OR REPLACE INTO
	/\bupdate\s+(?:only\s+)?[\w."`[\]]+(?:\s+(?:as\s+)?\w+)?\s+set\b/i, // UPDATE t [alias] SET
	/\bdelete\s+from\b/i, // DELETE FROM
	/\bdelete\s+(?!from\b)[\w."`[\]]+\s+where\b/i, // T-SQL: DELETE t WHERE
	/\bmerge\s+into\b/i, // MERGE INTO
	/\breplace\s+into\b/i, // MySQL REPLACE INTO
	/\bupsert\s+into\b/i, // UPSERT INTO (CockroachDB and others)
]

// Objects that DROP and ALTER act on. Listing them keeps a column such as
// `drop_rate` or a table such as `alter_log` from being read as a statement.
const SCHEMA_OBJECTS =
	"(?:table|database|schema|view|materialized\\s+view|index|function|procedure|trigger|sequence|type|user|role|extension|owned|system)"

const DDL_PATTERNS: RegExp[] = [
	new RegExp(`\\bdrop\\s+${SCHEMA_OBJECTS}\\b`, "i"), // DROP TABLE, DROP DATABASE, ...
	new RegExp(`\\balter\\s+${SCHEMA_OBJECTS}\\b`, "i"), // ALTER TABLE, ALTER USER, ...
	// TRUNCATE [TABLE] [ONLY] name. The name must follow a space, so the
	// numeric function TRUNCATE(price, 2) in a SELECT is not matched.
	/\btruncate\s+(?:table\s+)?(?:only\s+)?[\w."`[\]]/i,
]

/** Splits "runQuery" / "execute_sql" / "EXECUTE-SQL" into lowercase words. */
export function nameTokens(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
}

export function isQueryTool(toolName: string): boolean {
	return nameTokens(toolName).some((token) => QUERY_TOOL_TOKENS.has(token))
}

/**
 * Removes comments and quoted text so that neither `-- DELETE FROM x` nor
 * `WHERE note = 'delete from list'` is mistaken for a statement.
 */
function stripCommentsAndLiterals(sql: string): string {
	return sql
		.replace(/\/\*[\s\S]*?\*\//g, " ") // /* block comments */
		.replace(/--[^\n]*/g, " ") // -- line comments
		.replace(/'(?:[^']|'')*'/g, "''") // 'string literals'
		.replace(/\$\$[\s\S]*?\$\$/g, "''") // $$ dollar-quoted $$
}

export function sqlContainsDml(sql: string): boolean {
	const code = stripCommentsAndLiterals(sql)
	return DML_PATTERNS.some((pattern) => pattern.test(code))
}

/** Every string value in the arguments, including inside objects and arrays. */
function stringValues(input: unknown, limit = 2_000): string[] {
	const out: string[] = []
	const stack: unknown[] = [input]
	while (stack.length && out.length < limit) {
		const value = stack.pop()
		if (typeof value === "string") out.push(value)
		else if (Array.isArray(value)) stack.push(...value)
		else if (value && typeof value === "object") stack.push(...Object.values(value))
	}
	return out
}

/** DROP, ALTER or TRUNCATE: statements that remove or restructure data. */
export function sqlContainsDdl(sql: string): boolean {
	const code = stripCommentsAndLiterals(sql)
	return DDL_PATTERNS.some((pattern) => pattern.test(code))
}

/** True when a query tool is being asked to run a data-changing statement. */
export function queryToolCallHasDml(toolName: string, input: unknown): boolean {
	if (!isQueryTool(toolName)) return false
	return stringValues(input).some(sqlContainsDml)
}

/** True when a query tool is being asked to drop, alter or truncate. */
export function queryToolCallHasDdl(toolName: string, input: unknown): boolean {
	if (!isQueryTool(toolName)) return false
	return stringValues(input).some(sqlContainsDdl)
}