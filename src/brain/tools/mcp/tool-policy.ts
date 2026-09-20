import type { LeaseMode } from "../../lease/types"

export type McpToolClass = "read" | "write" | "dangerous" | "disallowed"

export type McpToolAnnotations = {
	destructiveHint?: boolean
	readOnlyHint?: boolean
}
const WRITE_VERBS = new Set([
	"create",
	"update",
	"delete",
	"remove",
	"send",
	"close",
	"archive",
	"merge",
	"add",
	"set",
	"edit",
	"write",
	"post",
	"assign",
	"cancel",
	"move",
	"invite",
	"comment",
	"reply",
	"upsert",
	"patch",
	"put",
	"upload",
	"publish",
	"trigger",
	"schedule",
	"deploy",
	"share",
	"approve",
	"revoke",
	"rename",
	"label",
	"unlabel",
])
const READ_VERBS = new Set([
	"list",
	"get",
	"fetch",
	"search",
	"read",
	"query",
	"describe",
	"find",
	"show",
	"view",
	"export",
	"count",
	"stats",
	"preview",
	"docs",
	"summarize",
	"lookup",
	"resolve",
])
const DANGEROUS_TOKENS = new Set([
	"sql",
	"hogql",
	"bash",
	"shell",
	"exec",
	"eval",
	"repl",
	"workbench",
	"drop",
	"truncate",
	"destroy",
	"purge",
	"wipe",
])
const DANGEROUS_EXEC_RE =
	/(?:^|[-_. ])(?:execute|run|raw|eval)[-_. ]?(?:sql|hogql|query|code|script|command|bash|shell)/i
export function tokenizeToolName(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[_\-\s.]+/)
		.map((s) => s.toLowerCase())
		.filter(Boolean)
}

function isDangerous(name: string, tokens: string[]): boolean {
	if (DANGEROUS_EXEC_RE.test(name)) return true
	return tokens.some((t) => DANGEROUS_TOKENS.has(t))
}
export function classifyMcpTool(
	toolName: string,
	annotations?: McpToolAnnotations,
): McpToolClass {
	const tokens = tokenizeToolName(toolName)
	if (isDangerous(toolName, tokens)) return "dangerous"
	if (tokens.some((t) => WRITE_VERBS.has(t))) return "write"
	if (annotations?.destructiveHint === true) return "write"
	if (tokens.some((t) => READ_VERBS.has(t))) return "read"
	return "write"
}

export type LeaseToolDecision =
	| { allowed: true }
	| { allowed: false; reason: string }
export function decideLeasedTool(
	toolClass: McpToolClass,
	mode: LeaseMode,
): LeaseToolDecision {
	if (toolClass === "disallowed") {
		return {
			allowed: false,
			reason: "This tool isn't available through temporary borrowed access.",
		}
	}
	if (toolClass === "dangerous") {
		return {
			allowed: false,
			reason:
				"This uses raw query or code-execution access, which isn't available through temporary borrowed access — use a structured tool, or your own connection.",
		}
	}
	if (toolClass === "write" && mode !== "read_write") {
		return {
			allowed: false,
			reason:
				"This makes changes, but the temporary access you were granted is read-only. Ask an admin to approve write access if you need it.",
		}
	}
	return { allowed: true }
}
export function mcpToolNeedsApproval(
	toolName: string,
	annotations?: McpToolAnnotations,
): boolean {
	if (annotations?.destructiveHint === true) return true
	return tokenizeToolName(toolName).some((tok) => WRITE_VERBS.has(tok))
}
