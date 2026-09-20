import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js"
import {
	type McpApprovalClassifier,
	type McpOperationEffect,
	operationIsRead,
} from "./approval-classifier"

const METADATA_VERBS = new Set([
	"capabilities",
	"describe",
	"documentation",
	"help",
	"info",
	"schema",
])

const READ_VERBS = new Set([
	"analyze",
	"check",
	"count",
	"export",
	"fetch",
	"find",
	"get",
	"history",
	"inspect",
	"list",
	"lookup",
	"query",
	"read",
	"report",
	"resolve",
	"retrieve",
	"search",
	"show",
	"status",
	"view",
])

const WRITE_VERBS = new Set([
	"add",
	"archive",
	"assign",
	"cancel",
	"close",
	"comment",
	"create",
	"delete",
	"deploy",
	"disable",
	"enable",
	"invite",
	"merge",
	"move",
	"post",
	"publish",
	"release",
	"remove",
	"reopen",
	"reply",
	"save",
	"send",
	"set",
	"trigger",
	"unarchive",
	"update",
	"upload",
	"upsert",
])

function methodTokens(method: string): string[] {
	return method
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
}

/** Deterministic classification intentionally leaves generic exec/run/script
 * operations unresolved; query/sql are not treated as write signals. */
export function deterministicOperationEffect(
	method: string,
): McpOperationEffect | undefined {
	const tokens = methodTokens(method)
	if (tokens.some((token) => WRITE_VERBS.has(token))) return "material_write"
	if (tokens.some((token) => METADATA_VERBS.has(token))) return "metadata"
	if (tokens.some((token) => READ_VERBS.has(token))) return "read"
	return undefined
}

export function annotatedOperationEffect(args: {
	annotations?: McpTool["annotations"]
	trusted: boolean
}): McpOperationEffect | undefined {
	if (!args.trusted || !args.annotations) return undefined
	if (args.annotations.destructiveHint === true) return "destructive"
	if (args.annotations.readOnlyHint === true) {
		return "read"
	}
	return undefined
}

export async function classifyMcpOperation(args: {
	serverSlug: string
	method: string
	description?: string
	inputSchema: unknown
	input: unknown
	annotations?: McpTool["annotations"]
	trustedAnnotations: boolean
	classifier: McpApprovalClassifier
	effectOverride?: McpOperationEffect
}): Promise<{ effect: McpOperationEffect; source: string; reason: string }> {
	if (args.effectOverride) {
		return {
			effect: args.effectOverride,
			source: "router_contract",
			reason: "The decoded router operation has an explicit host contract.",
		}
	}
	const annotated = annotatedOperationEffect({
		annotations: args.annotations,
		trusted: args.trustedAnnotations,
	})
	if (annotated) {
		return {
			effect: annotated,
			source: "mcp_annotations",
			reason: "Trusted MCP annotations classify this operation.",
		}
	}
	const deterministic = deterministicOperationEffect(args.method)
	if (deterministic) {
		return {
			effect: deterministic,
			source: "verb_map",
			reason: "The operation name has a deterministic effect verb.",
		}
	}
	const classified = await args.classifier.classify({
		serverSlug: args.serverSlug,
		toolName: args.method,
		description: args.description ?? "",
		inputSchema: args.inputSchema,
		arguments: args.input,
	})
	return {
		effect: classified.effect,
		source: "classifier",
		reason: classified.reason,
	}
}

export type McpNativeCallPolicyDecision =
	| {
			decision: "allow"
			effect: Extract<McpOperationEffect, "metadata" | "read">
	  }
	| { decision: "pause"; effect: McpOperationEffect; reason: string }
	| { decision: "deny"; effect: McpOperationEffect; reason: string }

export function decideMcpNativeCallPolicy(args: {
	effect: McpOperationEffect
	readOnly: boolean
	toolIdentity: string
	reason: string
}): McpNativeCallPolicyDecision {
	if (operationIsRead(args.effect)) {
		return { decision: "allow", effect: args.effect }
	}
	if (args.readOnly) {
		return {
			decision: "deny",
			effect: args.effect,
			reason: `${args.toolIdentity} may change external state, but this connected-app access is read-only.`,
		}
	}
	return {
		decision: "pause",
		effect: args.effect,
		reason:
			args.effect === "unknown"
				? `${args.toolIdentity} has an ambiguous external effect, so requester approval is required.`
				: args.reason,
	}
}
