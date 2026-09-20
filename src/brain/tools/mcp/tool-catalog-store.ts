import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js"
import type { CompanyBrainAgent } from "../../turn/agent"
import {
	boundedCommandWrapperContract,
	type CommandWrapperContract,
	type CommandWrapperHydrationFailure,
	type CommandWrapperToolContract,
} from "./router-wrapper"

export const MCP_TOOL_CATALOG_TTL_MS = 45 * 60 * 1000

export type McpToolCatalog = {
	version: 1
	connectionId: string
	serverSlug: string
	tools: McpTool[]
	wrappers: Record<string, CommandWrapperContract>
	fingerprint: string
}

type ToolCatalogRow = {
	connection_id: string
	server_slug: string
	fingerprint: string
	catalog_json: string
	created_at: number
	expires_at: number
}

type RouterContractRow = {
	parent_tool_name: string
	record_kind: "tool" | "failure"
	record_key: string
	record_json: string
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize)
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, item]) => item !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, canonicalize(item)]),
		)
	}
	return value
}

function digest(value: string): string {
	let left = 0x811c9dc5
	let right = 0x9e3779b9
	for (const character of value) {
		const point = character.codePointAt(0) ?? 0
		left = Math.imul(left ^ point, 0x01000193)
		right = Math.imul(right ^ point, 0x85ebca6b)
	}
	return `${(left >>> 0).toString(36)}_${(right >>> 0).toString(36)}`
}

export function catalogFingerprint(
	tools: readonly McpTool[],
	wrappers: Readonly<Record<string, CommandWrapperContract>> = {},
): string {
	const methods = [...tools]
		.map((tool) => ({
			name: tool.name,
			inputSchema: canonicalize(tool.inputSchema),
			outputSchema: canonicalize(tool.outputSchema),
			wrapper: wrappers[tool.name]
				? canonicalize(wrappers[tool.name])
				: undefined,
		}))
		.sort((left, right) => left.name.localeCompare(right.name))
	const serialized = JSON.stringify(methods)
	return `mcp_catalog_v1_${digest(serialized)}_${serialized.length}`
}

function validTool(value: unknown): value is McpTool {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const tool = value as { name?: unknown; inputSchema?: unknown }
	return (
		typeof tool.name === "string" &&
		tool.name.length > 0 &&
		Boolean(tool.inputSchema) &&
		typeof tool.inputSchema === "object"
	)
}

function validCatalog(value: unknown): value is McpToolCatalog {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const catalog = value as Partial<McpToolCatalog>
	return (
		catalog.version === 1 &&
		typeof catalog.connectionId === "string" &&
		typeof catalog.serverSlug === "string" &&
		typeof catalog.fingerprint === "string" &&
		Array.isArray(catalog.tools) &&
		catalog.tools.every(validTool) &&
		Boolean(catalog.wrappers) &&
		typeof catalog.wrappers === "object" &&
		!Array.isArray(catalog.wrappers)
	)
}

function wrapperMetadata(
	contract: CommandWrapperContract,
): CommandWrapperContract {
	const bounded = boundedCommandWrapperContract(contract)
	return { ...bounded, tools: {}, failures: {} }
}

function normalizedWrappers(
	wrappers: Readonly<Record<string, CommandWrapperContract>>,
): Record<string, CommandWrapperContract> {
	return Object.fromEntries(
		Object.entries(wrappers).map(([toolName, contract]) => [
			toolName,
			boundedCommandWrapperContract(contract),
		]),
	)
}

function storedCatalog(catalog: McpToolCatalog): McpToolCatalog {
	return {
		...catalog,
		wrappers: Object.fromEntries(
			Object.entries(catalog.wrappers).map(([toolName, contract]) => [
				toolName,
				wrapperMetadata(contract),
			]),
		),
	}
}

function parseRouterTool(
	metadata: CommandWrapperContract,
	key: string,
	value: unknown,
): CommandWrapperToolContract | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined
	const candidate = value as Partial<CommandWrapperToolContract>
	if (candidate.name !== key) return undefined
	const bounded = boundedCommandWrapperContract({
		...metadata,
		tools: { [key]: candidate as CommandWrapperToolContract },
		failures: {},
	})
	return bounded.tools[key]
}

function parseRouterFailure(
	key: string,
	value: unknown,
): CommandWrapperHydrationFailure | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined
	const candidate = value as Partial<CommandWrapperHydrationFailure>
	if (
		typeof candidate.toolName !== "string" ||
		typeof candidate.reason !== "string" ||
		typeof candidate.observedAt !== "number" ||
		(candidate.fieldPath !== undefined &&
			typeof candidate.fieldPath !== "string") ||
		(candidate.detail !== undefined && typeof candidate.detail !== "string")
	) {
		return undefined
	}
	const metadata: CommandWrapperContract = {
		commandField: "command",
		commands: { info: "info", schema: "schema", call: "call" },
		leadingTokens: [],
		requiredAuxiliaryFields: [],
		tools: {},
		failures: { [key]: candidate as CommandWrapperHydrationFailure },
	}
	return boundedCommandWrapperContract(metadata).failures?.[key]
}

export function ensureMcpToolCatalogTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_mcp_tool_catalog (
			connection_id TEXT PRIMARY KEY,
			server_slug TEXT NOT NULL,
			fingerprint TEXT NOT NULL,
			catalog_json TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_mcp_tool_catalog_server_slug_idx
		ON brain_mcp_tool_catalog (server_slug)
	`
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_mcp_router_contract (
			connection_id TEXT NOT NULL,
			parent_tool_name TEXT NOT NULL,
			record_kind TEXT NOT NULL,
			record_key TEXT NOT NULL,
			record_json TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			PRIMARY KEY (connection_id, parent_tool_name, record_kind, record_key)
		)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_mcp_router_contract_expires_idx
		ON brain_mcp_router_contract (expires_at)
	`
}

function saveRouterRecords(
	agent: CompanyBrainAgent,
	connectionId: string,
	wrappers: Readonly<Record<string, CommandWrapperContract>>,
	expiresAt: number,
): void {
	agent.sql`
		DELETE FROM brain_mcp_router_contract
		WHERE connection_id = ${connectionId}
	`
	for (const [parentToolName, contract] of Object.entries(wrappers)) {
		for (const [toolName, tool] of Object.entries(contract.tools)) {
			agent.sql`
				INSERT INTO brain_mcp_router_contract (
					connection_id, parent_tool_name, record_kind, record_key,
					record_json, expires_at
				) VALUES (
					${connectionId}, ${parentToolName}, 'tool', ${toolName},
					${JSON.stringify(tool)}, ${expiresAt}
				)
			`
		}
		for (const [failureKey, failure] of Object.entries(
			contract.failures ?? {},
		)) {
			agent.sql`
				INSERT INTO brain_mcp_router_contract (
					connection_id, parent_tool_name, record_kind, record_key,
					record_json, expires_at
				) VALUES (
					${connectionId}, ${parentToolName}, 'failure', ${failureKey},
					${JSON.stringify(failure)}, ${expiresAt}
				)
			`
		}
	}
}

function loadRouterRecords(
	agent: CompanyBrainAgent,
	connectionId: string,
	wrappers: Readonly<Record<string, CommandWrapperContract>>,
	now: number,
): Record<string, CommandWrapperContract> | undefined {
	const hydrated = normalizedWrappers(wrappers)
	const rows = agent.sql<RouterContractRow>`
		SELECT parent_tool_name, record_kind, record_key, record_json
		FROM brain_mcp_router_contract
		WHERE connection_id = ${connectionId}
			AND expires_at > ${now}
		ORDER BY parent_tool_name, record_kind, record_key
	`
	for (const row of rows) {
		const metadata = hydrated[row.parent_tool_name]
		if (!metadata) return undefined
		let parsed: unknown
		try {
			parsed = JSON.parse(row.record_json)
		} catch {
			return undefined
		}
		if (row.record_kind === "tool") {
			const tool = parseRouterTool(metadata, row.record_key, parsed)
			if (!tool) return undefined
			hydrated[row.parent_tool_name] = {
				...metadata,
				tools: { ...metadata.tools, [row.record_key]: tool },
			}
			continue
		}
		if (row.record_kind === "failure") {
			const failure = parseRouterFailure(row.record_key, parsed)
			if (!failure) return undefined
			hydrated[row.parent_tool_name] = {
				...metadata,
				failures: { ...metadata.failures, [row.record_key]: failure },
			}
			continue
		}
		return undefined
	}
	return normalizedWrappers(hydrated)
}

export function loadMcpToolCatalog(
	agent: CompanyBrainAgent,
	connectionId: string,
	now = Date.now(),
): McpToolCatalog | undefined {
	ensureMcpToolCatalogTable(agent)
	const [row] = agent.sql<ToolCatalogRow>`
		SELECT * FROM brain_mcp_tool_catalog
		WHERE connection_id = ${connectionId}
			AND expires_at > ${now}
		LIMIT 1
	`
	if (!row) return undefined
	try {
		const parsed: unknown = JSON.parse(row.catalog_json)
		if (
			validCatalog(parsed) &&
			parsed.connectionId === row.connection_id &&
			parsed.serverSlug === row.server_slug &&
			parsed.fingerprint === row.fingerprint
		) {
			const wrappers = loadRouterRecords(
				agent,
				row.connection_id,
				parsed.wrappers,
				now,
			)
			if (wrappers) {
				const catalog = { ...parsed, wrappers }
				if (
					catalogFingerprint(catalog.tools, catalog.wrappers) ===
					row.fingerprint
				) {
					return catalog
				}
			}
		}
	} catch {}
	invalidateMcpToolCatalog(agent, { connectionId })
	return undefined
}

export function saveMcpToolCatalog(
	agent: CompanyBrainAgent,
	input: {
		connectionId: string
		serverSlug: string
		tools: readonly McpTool[]
		wrappers?: Readonly<Record<string, CommandWrapperContract>>
	},
	now = Date.now(),
): McpToolCatalog {
	ensureMcpToolCatalogTable(agent)
	const wrappers = normalizedWrappers(input.wrappers ?? {})
	const tools = input.tools.map((tool) => ({ ...tool }))
	const fingerprint = catalogFingerprint(tools, wrappers)
	const catalog: McpToolCatalog = {
		version: 1,
		connectionId: input.connectionId,
		serverSlug: input.serverSlug,
		tools,
		wrappers,
		fingerprint,
	}
	const expiresAt = now + MCP_TOOL_CATALOG_TTL_MS
	const persisted = storedCatalog(catalog)
	saveRouterRecords(agent, catalog.connectionId, wrappers, expiresAt)
	agent.sql`
		INSERT INTO brain_mcp_tool_catalog (
			connection_id, server_slug, fingerprint, catalog_json,
			created_at, expires_at
		) VALUES (
			${catalog.connectionId},
			${catalog.serverSlug},
			${catalog.fingerprint},
			${JSON.stringify(persisted)},
			${now},
			${expiresAt}
		)
		ON CONFLICT (connection_id) DO UPDATE SET
			server_slug = excluded.server_slug,
			fingerprint = excluded.fingerprint,
			catalog_json = excluded.catalog_json,
			created_at = excluded.created_at,
			expires_at = excluded.expires_at
	`
	return catalog
}

export function saveMcpRouterContract(
	agent: CompanyBrainAgent,
	catalog: McpToolCatalog,
	toolName: string,
	contract: CommandWrapperContract,
): McpToolCatalog {
	return saveMcpToolCatalog(agent, {
		connectionId: catalog.connectionId,
		serverSlug: catalog.serverSlug,
		tools: catalog.tools,
		wrappers: { ...catalog.wrappers, [toolName]: contract },
	})
}

export function invalidateMcpToolCatalog(
	agent: CompanyBrainAgent,
	selector: { connectionId?: string; serverSlug?: string } = {},
): number {
	ensureMcpToolCatalogTable(agent)
	if (selector.connectionId) {
		agent.sql`
			DELETE FROM brain_mcp_router_contract
			WHERE connection_id = ${selector.connectionId}
		`
		return agent.sql<{ connection_id: string }>`
			DELETE FROM brain_mcp_tool_catalog
			WHERE connection_id = ${selector.connectionId}
			RETURNING connection_id
		`.length
	}
	if (selector.serverSlug) {
		agent.sql`
			DELETE FROM brain_mcp_router_contract
			WHERE connection_id IN (
				SELECT connection_id FROM brain_mcp_tool_catalog
				WHERE server_slug = ${selector.serverSlug}
			)
		`
		return agent.sql<{ connection_id: string }>`
			DELETE FROM brain_mcp_tool_catalog
			WHERE server_slug = ${selector.serverSlug}
			RETURNING connection_id
		`.length
	}
	agent.sql`DELETE FROM brain_mcp_router_contract`
	return agent.sql<{ connection_id: string }>`
		DELETE FROM brain_mcp_tool_catalog
		RETURNING connection_id
	`.length
}
