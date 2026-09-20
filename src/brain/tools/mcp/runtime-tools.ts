import { type ToolSet, tool } from "ai"
import { z } from "zod"
import type { ActiveLease, LeaseRuntimeContext } from "../../lease/types"
import { McpReauthRequiredError } from "./oauth-provider"
import { connectToolProvider, type ToolProviderHandle } from "./provider"
import {
	getConnectionById,
	listActiveConnectionsForActor,
	markConnectionError,
} from "./store"
import {
	classifyMcpTool,
	decideLeasedTool,
	type McpToolAnnotations,
	mcpToolNeedsApproval,
} from "./tool-policy"

export type McpRuntimeTools = {
	tools: ToolSet
	servers: string[]
	serverStates: McpRuntimeServerState[]
	close: () => Promise<void>
}

export type McpRuntimeServerState = {
	serverSlug: string
	connectionId?: string
	accessScope: "personal" | "organization" | "temporary"
	runtimeStatus: "ready" | "temporarily_unavailable" | "reconnect_required"
}

type IndexedTool = {
	id: string // `${serverSlug}.${toolName}`
	serverSlug: string
	toolName: string
	description: string
	inputSchema: unknown
	annotations?: McpToolAnnotations
	normalizeInput?: (args: Record<string, unknown>) => Record<string, unknown>
	orgShared: boolean
	handle: ToolProviderHandle
	lease?: ActiveLease
}

// Anthropic rejects tool input_schema with top-level oneOf/allOf/anyOf and
// requires a top-level object. Coerce non-conforming MCP schemas to permissive.
function sanitizeInputSchema(schema: unknown): Record<string, unknown> {
	const s = schema as Record<string, unknown> | null | undefined
	if (
		!s ||
		typeof s !== "object" ||
		s.anyOf ||
		s.oneOf ||
		s.allOf ||
		s.type !== "object"
	) {
		return { type: "object", additionalProperties: true }
	}
	return s
}

function scoreTool(query: string, t: IndexedTool): number {
	const hay = `${t.id} ${t.description}`.toLowerCase()
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
	if (terms.length === 0) return 1
	let score = 0
	for (const term of terms) if (hay.includes(term)) score++
	return score
}

function dedupeLeasesByServer(leases: ActiveLease[]): ActiveLease[] {
	const byServer = new Map<string, ActiveLease>()
	for (const lease of leases) {
		const existing = byServer.get(lease.serverSlug)
		if (!existing || lease.mode === "read_write") {
			byServer.set(lease.serverSlug, lease)
		}
	}
	return [...byServer.values()]
}

// Positively read-only: a known read verb, no write verb, not flagged destructive.
// Names that match neither list (e.g. "save_issue") are NOT treated as read-only.
function isReadOnlyTool(t: IndexedTool): boolean {
	return classifyMcpTool(t.toolName, t.annotations) === "read"
}

// readOnly runs (automations) fail closed: only positively read-only tools are
// exposed/executed, since write verb lists can miss names like "save_issue".
// Org-shared (userId null) connections stay read-only via the write-verb gate.
function isBlockedWrite(t: IndexedTool, readOnly: boolean): boolean {
	if (readOnly) return !isReadOnlyTool(t)
	return t.orgShared && !isReadOnlyTool(t)
}

// Connect every active MCP server for the actor, build a searchable tool index,
// and expose it through 3 meta-tools (search/describe/execute) instead of
// flat-injecting hundreds of tools into the model context.
export async function createMcpRuntimeTools(
	env: Env,
	actor: {
		orgId: string
		userId?: string
		personalConnectionsOnly?: boolean
		orgSharedOnly?: boolean
		readOnly?: boolean
		/** Hide model search text and provider error bodies from operational logs. */
		redactToolLogs?: boolean
	},
	callbackUrl: string,
	traceId: string,
	leaseCtx?: LeaseRuntimeContext,
): Promise<McpRuntimeTools> {
	const loggedError = (error: unknown): string =>
		actor.redactToolLogs
			? "redacted"
			: error instanceof Error
				? error.message
				: String(error)
	const allConnections = actor.orgSharedOnly
		? await listActiveConnectionsForActor(env, actor.orgId, undefined, false)
		: await listActiveConnectionsForActor(
				env,
				actor.orgId,
				actor.userId,
				actor.personalConnectionsOnly,
			)
	// One connection per slug, personal (userId set) wins over org-shared, so tool
	// ids (keyed by slug.tool) resolve to deterministic credentials.
	const bySlug = new Map<string, (typeof allConnections)[number]>()
	for (const conn of allConnections) {
		const prev = bySlug.get(conn.serverSlug)
		if (!prev || (prev.userId === null && conn.userId !== null)) {
			bySlug.set(conn.serverSlug, conn)
		}
	}
	const connections = [...bySlug.values()]
	const index = new Map<string, IndexedTool>()
	const handles: ToolProviderHandle[] = []
	const servers: string[] = []
	const serverStates: McpRuntimeServerState[] = []
	const setupStartedAt = Date.now()

	const connectAndList = async (conn: (typeof connections)[number]) => {
		const serverStartedAt = Date.now()
		let handle: ToolProviderHandle | undefined
		try {
			const connectStartedAt = Date.now()
			handle = await connectToolProvider(env, conn, callbackUrl)
			const connectedAt = Date.now()
			const listed = await handle.listTools()
			const finishedAt = Date.now()
			console.log(
				`[company-brain][${traceId}] mcp connected ${conn.serverSlug} tools=${listed.length} connectMs=${connectedAt - connectStartedAt} listMs=${finishedAt - connectedAt} ms=${finishedAt - serverStartedAt}`,
			)
			return {
				ok: true as const,
				conn,
				handle,
				listed,
				runtimeStatus: "ready" as const,
			}
		} catch (err) {
			await handle?.close().catch(() => {})
			console.warn(
				`[company-brain][${traceId}] mcp connect ${conn.serverSlug} failed: ${loggedError(err)}`,
			)
			// expired/invalid OAuth -> flag for reconnect instead of silently dropping
			if (err instanceof McpReauthRequiredError) {
				await markConnectionError(env, conn.id, "reconnect required").catch(
					() => {},
				)
			}
			return {
				ok: false as const,
				conn,
				runtimeStatus:
					err instanceof McpReauthRequiredError
						? ("reconnect_required" as const)
						: ("temporarily_unavailable" as const),
			}
		}
	}

	const connected = await Promise.all(connections.map(connectAndList))
	for (const item of connected) {
		serverStates.push({
			serverSlug: item.conn.serverSlug,
			connectionId: item.conn.id,
			accessScope: item.conn.userId === null ? "organization" : "personal",
			runtimeStatus: item.runtimeStatus,
		})
		if (!item.ok) continue
		handles.push(item.handle)
		servers.push(item.conn.serverSlug)
		for (const t of item.listed) {
			const id = `${item.conn.serverSlug}.${t.name}`
			index.set(id, {
				id,
				serverSlug: item.conn.serverSlug,
				toolName: t.name,
				description: t.description ?? "",
				inputSchema: t.inputSchema,
				annotations: t.annotations as McpToolAnnotations | undefined,
				normalizeInput: t.normalizeInput,
				orgShared: item.conn.userId === null,
				handle: item.handle,
			})
		}
	}
	console.log(
		`[company-brain][${traceId}] mcp setup connections=${connections.length} connected=${servers.length} tools=${index.size} ms=${Date.now() - setupStartedAt}`,
	)

	const ownServers = new Set(servers)
	const leases = dedupeLeasesByServer(leaseCtx?.leases ?? [])
	for (const lease of leases) {
		try {
			if (ownServers.has(lease.serverSlug)) {
				console.log(
					`[company-brain][${traceId}] mcp lease ${lease.serverSlug} skipped (actor already connected)`,
				)
				continue
			}
			const stillValid = leaseCtx
				? await leaseCtx.revalidate(lease.leaseId)
				: false
			if (!stillValid) {
				continue
			}
			const conn = await getConnectionById(env, lease.lessorConnectionId)
			if (!conn || conn.status !== "active") continue
			if (conn.runtime !== "remote_mcp") continue
			const handle = await connectToolProvider(env, conn, callbackUrl)
			handles.push(handle)
			const listed = await handle.listTools()
			if (!servers.includes(lease.serverSlug)) servers.push(lease.serverSlug)
			serverStates.push({
				serverSlug: lease.serverSlug,
				connectionId: lease.lessorConnectionId,
				accessScope: "temporary",
				runtimeStatus: "ready",
			})
			for (const t of listed) {
				const id = `${lease.serverSlug}.${t.name}`
				index.set(id, {
					id,
					serverSlug: lease.serverSlug,
					toolName: t.name,
					description: t.description ?? "",
					inputSchema: t.inputSchema,
					annotations: t.annotations as McpToolAnnotations | undefined,
					normalizeInput: t.normalizeInput,
					orgShared: false,
					handle,
					lease,
				})
			}
			console.log(
				`[company-brain][${traceId}] mcp leased ${lease.serverSlug} tools=${listed.length} lease=${lease.leaseId}`,
			)
		} catch (err) {
			serverStates.push({
				serverSlug: lease.serverSlug,
				connectionId: lease.lessorConnectionId,
				accessScope: "temporary",
				runtimeStatus:
					err instanceof McpReauthRequiredError
						? "reconnect_required"
						: "temporarily_unavailable",
			})
			console.warn(
				`[company-brain][${traceId}] mcp leased connect ${lease.serverSlug} failed: ${loggedError(err)}`,
			)
		}
	}

	const close = async () => {
		await Promise.all(handles.map((h) => h.close()))
	}

	if (servers.length === 0) return { tools: {}, servers, serverStates, close }

	const runLeasedTool = async (
		t: IndexedTool,
		lease: ActiveLease,
		id: string,
		args: Record<string, unknown> | undefined,
	): Promise<unknown> => {
		const toolClass = classifyMcpTool(t.toolName, t.annotations)
		const stillValid = leaseCtx
			? await leaseCtx.revalidate(lease.leaseId)
			: false
		if (!stillValid) {
			return {
				isError: true,
				error: "Your temporary access has expired or been revoked.",
			}
		}
		const decision = decideLeasedTool(toolClass, lease.mode)
		if (!decision.allowed) {
			return { isError: true, error: decision.reason }
		}
		const t0 = Date.now()
		try {
			const out = await t.handle.callTool(t.toolName, args ?? {}, {
				retryOnTimeout: toolClass === "read",
			})
			console.log(
				`[company-brain][${traceId}] mcp_execute_tool(leased) ${id} ms=${Date.now() - t0} lease=${lease.leaseId}`,
			)
			return out
		} catch (err) {
			console.warn(
				`[company-brain][${traceId}] mcp_execute_tool(leased) ${id} failed: ${loggedError(err)}`,
			)
			return {
				isError: true,
				error: err instanceof Error ? err.message : String(err),
			}
		}
	}

	const searchTool = tool({
		description: `Search for tools across connected MCP apps (${servers.join(", ")}). Returns matching tool ids + descriptions. Call this first to discover the right tool, then mcp_describe_tool for its schema, then mcp_execute_tool to run it.`,
		inputSchema: z.object({
			query: z
				.string()
				.describe("What you want to do, e.g. 'list users signed up today'."),
		}),
		execute: async ({ query }) => {
			const ranked = [...index.values()]
				.filter((t) => !isBlockedWrite(t, actor.readOnly === true))
				.map((t) => ({ t, score: scoreTool(query, t) }))
				.filter((r) => r.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, 12)
			const results = (ranked.length > 0 ? ranked.map((r) => r.t) : []).map(
				(t) => ({ tool: t.id, description: t.description.slice(0, 200) }),
			)
			console.log(
				`[company-brain][${traceId}] mcp_search_tools${actor.redactToolLogs ? "" : ` q="${query}"`} hits=${results.length}`,
			)
			return { tools: results }
		},
	})

	const describeTool = tool({
		description:
			"Get the input schema for a specific MCP tool (use the `tool` id from mcp_search_tools) before executing it.",
		inputSchema: z.object({
			tool: z.string().describe("Tool id, e.g. 'posthog.query-run'."),
		}),
		execute: async ({ tool: id }) => {
			const t = index.get(id)
			if (!t) return { error: `unknown tool '${id}'` }
			if (isBlockedWrite(t, actor.readOnly === true))
				return {
					error: `'${id}' is a write action; org-shared connections are read-only. Connect ${t.serverSlug} personally to use it.`,
				}
			return {
				tool: t.id,
				server: t.serverSlug,
				description: t.description,
				inputSchema: sanitizeInputSchema(t.inputSchema),
			}
		},
	})

	const executeTool = tool({
		description:
			"Execute an MCP tool by id (from mcp_search_tools) with its arguments. Describe it first if unsure of the arguments.",
		inputSchema: z
			.object({
				tool: z.string().describe("Tool id, e.g. 'posthog.query-run'."),
				arguments: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("Arguments object matching the tool's input schema."),
			})
			.transform((input, ctx) => {
				const indexedTool = index.get(input.tool)
				if (!indexedTool?.normalizeInput) return input
				try {
					return {
						...input,
						arguments: indexedTool.normalizeInput(input.arguments ?? {}),
					}
				} catch (error) {
					ctx.addIssue({
						code: "custom",
						message:
							error instanceof Error ? error.message : "invalid tool arguments",
					})
					return z.NEVER
				}
			}),
		needsApproval: ({ tool: id }) => {
			if (typeof id !== "string") return true
			const t = index.get(id)
			// Unknown tool id resolves to an error in execute; gate it to be safe.
			if (!t) return true
			if (t.lease) {
				if (t.lease.mode !== "read_write") return false
				return classifyMcpTool(t.toolName, t.annotations) === "write"
			}
			// Org-shared writes are denied in execute; don't prompt for approval.
			if (isBlockedWrite(t, actor.readOnly === true)) return false
			return mcpToolNeedsApproval(t.toolName, t.annotations)
		},
		execute: async ({ tool: id, arguments: args }) => {
			const t = index.get(id)
			if (!t) return { isError: true, error: `unknown tool '${id}'` }
			if (t.lease) return runLeasedTool(t, t.lease, id, args)
			if (isBlockedWrite(t, actor.readOnly === true))
				return {
					isError: true,
					error: `org-shared connections are read-only; writing to ${t.serverSlug} needs a personal connection`,
				}
			const t0 = Date.now()
			try {
				const out = await t.handle.callTool(t.toolName, args ?? {}, {
					retryOnTimeout: isReadOnlyTool(t),
				})
				console.log(
					`[company-brain][${traceId}] mcp_execute_tool ${id} ms=${Date.now() - t0}`,
				)
				return out
			} catch (err) {
				console.warn(
					`[company-brain][${traceId}] mcp_execute_tool ${id} failed: ${loggedError(err)}`,
				)
				return {
					isError: true,
					error: err instanceof Error ? err.message : String(err),
				}
			}
		},
	})

	return {
		tools: {
			mcp_search_tools: searchTool,
			mcp_describe_tool: describeTool,
			mcp_execute_tool: executeTool,
		},
		servers,
		serverStates,
		close,
	}
}
