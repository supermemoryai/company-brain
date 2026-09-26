import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js"
import type { McpAuthType } from "@repo/db/schema/brain/mcp"
import { connectorPause } from "@repo/lib/connector-availability"
import {
	type NativeMethodInputContract,
	nativeMethodInputContract,
	nativeMethodInputContractSummary,
} from "./preflight"
import {
	type CommandWrapperVirtualMethod,
	commandWrapperVirtualMethods,
	mergeCommandWrapperContracts,
} from "./router-wrapper"
import type { McpToolCatalog } from "./tool-catalog-store"

type CatalogEntryBase = {
	slug: string
	name: string
	category: string
	iconDomain: string
	personalOnly?: boolean
	leaseable?: boolean
	tokenHint?: string
}

export type RemoteMcpCatalogEntry = CatalogEntryBase & {
	runtime: "remote_mcp"
	serverUrl: string
	authType: McpAuthType
	leaseable: boolean
	// oauth servers without DCR: scope requested on the authorize URL
	oauthScope?: string
	// oauth servers without DCR: env vars holding our pre-registered app creds
	preregisteredClientEnv?: { id: keyof Env; secret: keyof Env }
}

export type EmbeddedCatalogEntry = CatalogEntryBase & {
	runtime: "embedded"
	authType: "oauth"
	personalOnly: true
	leaseable: false
}

export type McpCatalogEntry = RemoteMcpCatalogEntry | EmbeddedCatalogEntry

// Curated inbuilt MCP servers. Connecting by slug seeds the serverUrl + authType
export const MCP_CATALOG: McpCatalogEntry[] = [
	{
		slug: "linear",
		name: "Linear",
		category: "Project Management",
		iconDomain: "linear.app",
		runtime: "remote_mcp",
		serverUrl: "https://mcp.linear.app/mcp",
		authType: "oauth",
		leaseable: true,
	},
	{
		slug: "notion",
		name: "Notion",
		category: "Docs",
		iconDomain: "notion.com",
		runtime: "remote_mcp",
		serverUrl: "https://mcp.notion.com/mcp",
		authType: "oauth",
		leaseable: true,
	},
	{
		slug: "posthog",
		name: "PostHog",
		category: "Analytics",
		iconDomain: "posthog.com",
		runtime: "remote_mcp",
		serverUrl: "https://mcp.posthog.com/mcp",
		authType: "oauth",
		leaseable: true,
	},
	{
		slug: "plain",
		name: "Plain",
		category: "support",
		iconDomain: "plain.com",
		runtime: "remote_mcp",
		serverUrl: "https://mcp.plain.com/mcp",
		authType: "oauth",
		leaseable: true,
	},
	{
		slug: "github",
		name: "GitHub",
		category: "Code",
		iconDomain: "github.com",
		runtime: "remote_mcp",
		serverUrl: "https://api.githubcopilot.com/mcp/",
		authType: "oauth",
		leaseable: true,
		oauthScope: "repo read:org read:user",
		preregisteredClientEnv: {
			id: "GITHUB_MCP_CLIENT_ID",
			secret: "GITHUB_MCP_CLIENT_SECRET",
		},
	},
	{
		slug: "sentry",
		name: "Sentry",
		category: "Observability",
		iconDomain: "sentry.io",
		runtime: "remote_mcp",
		serverUrl: "https://mcp.sentry.dev/mcp",
		authType: "oauth",
		leaseable: true,
	},
	{
		slug: "granola",
		name: "Granola",
		category: "Meetings",
		iconDomain: "granola.ai",
		runtime: "remote_mcp",
		serverUrl: "https://mcp.granola.ai/mcp",
		authType: "oauth",
		leaseable: true,
	},
	{
		slug: "gmail",
		name: "Gmail",
		category: "Email",
		iconDomain: "gmail.com",
		runtime: "embedded",
		authType: "oauth",
		personalOnly: true,
		leaseable: false,
	},
]

// Reserve non-leaseable slugs before their catalog entries ship so a future
// inbox integration cannot silently inherit the custom-server default.
const NON_LEASEABLE_RESERVED_SLUGS = new Set(["gmail"])

export const OFFERABLE_MCP_CATALOG = MCP_CATALOG.filter(
	(entry) => !connectorPause(entry.slug).paused,
)

export function getCatalogEntry(slug: string): McpCatalogEntry | undefined {
	return MCP_CATALOG.find((e) => e.slug === slug.toLowerCase())
}

export function isMcpServerLeaseable(slug: string): boolean {
	const normalized = slug.trim().toLowerCase()
	if (NON_LEASEABLE_RESERVED_SLUGS.has(normalized)) return false
	return getCatalogEntry(normalized)?.leaseable ?? true
}

export function getRemoteCatalogEntry(
	slug: string,
): RemoteMcpCatalogEntry | undefined {
	const entry = getCatalogEntry(slug)
	return entry?.runtime === "remote_mcp" ? entry : undefined
}

function words(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
}

export function getCatalogEntryForToolLabel(
	value: string | undefined,
): McpCatalogEntry | undefined {
	if (!value) return undefined
	const normalized = value.toLowerCase()
	const tokens = new Set(words(value))
	return MCP_CATALOG.find((entry) => {
		if (normalized === entry.slug || normalized.startsWith(`${entry.slug}.`)) {
			return true
		}
		if (tokens.has(entry.slug)) return true
		const nameTokens = words(entry.name)
		return (
			nameTokens.length > 0 && nameTokens.every((token) => tokens.has(token))
		)
	})
}

export function getCatalogIconUrlForToolLabel(
	...values: Array<string | undefined>
): string | undefined {
	for (const value of values) {
		const entry = getCatalogEntryForToolLabel(value)
		if (!entry) continue
		return faviconUrlForDomain(entry.iconDomain)
	}
}

function iconDomainForServerUrl(serverUrl: string): string | undefined {
	const hostname = new URL(serverUrl).hostname
	if (!hostname) return undefined
	const parts = hostname.split(".")
	while (parts.length > 2 && ["api", "mcp", "www"].includes(parts[0] ?? "")) {
		parts.shift()
	}
	return parts.join(".")
}

export function faviconUrlForServerUrl(
	serverUrl: string | undefined,
): string | undefined {
	if (!serverUrl) return undefined
	try {
		const domain = iconDomainForServerUrl(serverUrl)
		if (!domain) return undefined
		return faviconUrlForDomain(domain)
	} catch {
		return undefined
	}
}

function faviconUrlForDomain(domain: string): string {
	return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`
}

export function mcpIconUrlForServer(
	slug: string,
	serverUrl: string | undefined,
): string | undefined {
	const entry = getCatalogEntry(slug)
	return entry
		? faviconUrlForDomain(entry.iconDomain)
		: faviconUrlForServerUrl(serverUrl)
}

// Paused apps stay in the catalog for existing connections but are not offered.
export function getMcpCatalogSlugs(): string[] {
	return OFFERABLE_MCP_CATALOG.map((entry) => entry.slug)
}

export function isMcpCatalogSlug(slug: string): boolean {
	return getMcpCatalogSlugs().includes(slug.toLowerCase())
}

export function isLeaseableMcpSlug(slug: string): boolean {
	return isMcpServerLeaseable(slug)
}

// Pre-registered OAuth creds for no-DCR catalog servers; prefer process.env, then worker env bindings.
export function getPreregisteredClient(
	env: Env,
	slug: string,
): { client_id: string; client_secret: string } | undefined {
	const entry = getCatalogEntry(slug)
	const ref =
		entry?.runtime === "remote_mcp" ? entry.preregisteredClientEnv : undefined
	if (!ref) return undefined
	const proc: Record<string, string | undefined> = process.env
	const client_id = proc[ref.id] ?? (env[ref.id] as string | undefined)
	const client_secret =
		proc[ref.secret] ?? (env[ref.secret] as string | undefined)
	if (!client_id || !client_secret) return undefined
	return { client_id, client_secret }
}

const JS_RESERVED_WORDS = new Set([
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"implements",
	"import",
	"in",
	"instanceof",
	"interface",
	"let",
	"new",
	"null",
	"package",
	"private",
	"protected",
	"public",
	"return",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
])

export type CatalogMethod = {
	serverSlug: string
	connectorName: string
	sourceToolName: string
	methodName: string
	path: string
	description?: string
	inputSchema: McpTool["inputSchema"]
	inputContract: NativeMethodInputContract
	annotations?: McpTool["annotations"]
	canonical: string
	virtualParentMethod?: string
}

function shortHash(value: string): string {
	let hash = 0x811c9dc5
	for (const character of value) {
		hash ^= character.codePointAt(0) ?? 0
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0).toString(36).slice(0, 6)
}

export function sanitizeMcpMethodName(value: string): string {
	let name = value.replace(/[-.\s]+/g, "_").replace(/[^a-zA-Z0-9_$]/g, "")
	if (!name) name = "method"
	if (/^[0-9]/.test(name)) name = `_${name}`
	if (JS_RESERVED_WORDS.has(name)) name = `${name}_`
	return name === "__proto__" ? "mcp___proto__" : name
}

export function stableMcpMethodNames(
	tools: readonly Pick<McpTool, "name">[],
): Map<string, string> {
	const byBase = new Map<string, Array<Pick<McpTool, "name">>>()
	const sourceNames = new Set<string>()
	for (const tool of tools) {
		if (sourceNames.has(tool.name)) {
			throw new Error(
				`MCP tool catalog contains duplicate name '${tool.name}'.`,
			)
		}
		sourceNames.add(tool.name)
		const base = sanitizeMcpMethodName(tool.name)
		const group = byBase.get(base) ?? []
		group.push(tool)
		byBase.set(base, group)
	}
	const names = new Map<string, string>()
	const reservedBases = new Set(byBase.keys())
	const used = new Set<string>()
	for (const [base, group] of [...byBase].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		if (group.length === 1 && group[0]) {
			names.set(group[0].name, base)
			used.add(base)
			continue
		}
		for (const tool of [...group].sort((left, right) =>
			left.name.localeCompare(right.name),
		)) {
			const stem = `${base}_${shortHash(tool.name)}`
			let exposed = stem
			let suffix = 2
			while (used.has(exposed) || reservedBases.has(exposed)) {
				exposed = `${stem}_${suffix}`
				suffix += 1
			}
			names.set(tool.name, exposed)
			used.add(exposed)
		}
	}
	return names
}

export function stableConnectorNames(
	serverSlugs: readonly string[],
): Map<string, string> {
	const pseudoTools = serverSlugs.map((serverSlug) => ({
		serverSlug,
		name: `mcp_${serverSlug}`,
	}))
	const exposed = stableMcpMethodNames(pseudoTools)
	return new Map(
		pseudoTools.map(({ serverSlug, name }) => [
			serverSlug,
			exposed.get(name) ?? sanitizeMcpMethodName(name),
		]),
	)
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function literalType(value: unknown): string {
	return typeof value === "string" ? JSON.stringify(value) : String(value)
}

function schemaType(schemaValue: unknown, depth = 0): string {
	if (depth > 5) return "unknown"
	const schema = objectRecord(schemaValue)
	if (!schema) return "unknown"
	if (schema.const !== undefined) return literalType(schema.const)
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		return schema.enum.slice(0, 32).map(literalType).join(" | ")
	}
	const variants = Array.isArray(schema.anyOf)
		? schema.anyOf
		: Array.isArray(schema.oneOf)
			? schema.oneOf
			: undefined
	if (variants?.length) {
		return variants
			.slice(0, 12)
			.map((item) => schemaType(item, depth + 1))
			.join(" | ")
	}
	if (schema.type === "array") return `${schemaType(schema.items, depth + 1)}[]`
	if (schema.type === "object" || objectRecord(schema.properties)) {
		const properties = objectRecord(schema.properties) ?? {}
		const required = new Set(
			Array.isArray(schema.required)
				? schema.required.filter(
						(item): item is string => typeof item === "string",
					)
				: [],
		)
		const fields = Object.entries(properties).map(([name, value]) => {
			const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)
				? name
				: JSON.stringify(name)
			return `${key}${required.has(name) ? "" : "?"}: ${schemaType(value, depth + 1)}`
		})
		if (schema.additionalProperties && schema.additionalProperties !== false) {
			fields.push("[key: string]: unknown")
		}
		return fields.length
			? `{ ${fields.join("; ")} }`
			: "Record<string, unknown>"
	}
	if (Array.isArray(schema.type)) {
		return schema.type
			.map((type) => schemaType({ type }, depth + 1))
			.join(" | ")
	}
	switch (schema.type) {
		case "string":
			return "string"
		case "integer":
		case "number":
			return "number"
		case "boolean":
			return "boolean"
		case "null":
			return "null"
		default:
			return "unknown"
	}
}

function compactDescription(
	value: string | undefined,
	max = 500,
): string | undefined {
	const normalized = value?.replace(/\s+/g, " ").trim()
	if (!normalized) return undefined
	return normalized.length <= max
		? normalized
		: `${normalized.slice(0, max - 1)}…`
}

export function renderCanonicalMethod(args: {
	path: string
	inputSchema: unknown
	description?: string
	inputContract?: NativeMethodInputContract
}): string {
	const contract =
		args.inputContract ?? nativeMethodInputContract(args.inputSchema)
	const summary = nativeMethodInputContractSummary(contract)
	const description = compactDescription(args.description)
	const details = [description, summary].filter(Boolean).join(" ")
	return `${args.path}(input: ${schemaType(args.inputSchema)}): Promise<unknown>${details ? `\n  — ${details}` : ""}`
}

export function virtualCatalogMethod(args: {
	serverSlug: string
	connectorName: string
	parentMethod: string
	virtual: CommandWrapperVirtualMethod
}): CatalogMethod {
	const path = `${args.connectorName}.${args.virtual.methodName}`
	const inputContract = nativeMethodInputContract(args.virtual.inputSchema)
	return {
		serverSlug: args.serverSlug,
		connectorName: args.connectorName,
		sourceToolName: args.virtual.tool.name,
		methodName: args.virtual.methodName,
		path,
		description: args.virtual.tool.description,
		inputSchema: args.virtual.inputSchema as McpTool["inputSchema"],
		inputContract,
		annotations: args.virtual.tool.annotations,
		virtualParentMethod: args.parentMethod,
		canonical: renderCanonicalMethod({
			path,
			inputSchema: args.virtual.inputSchema,
			description: args.virtual.tool.description,
			inputContract,
		}),
	}
}

export function catalogMethods(
	catalog: McpToolCatalog,
	connectorName: string,
): CatalogMethod[] {
	const names = stableMcpMethodNames(catalog.tools)
	const methods: CatalogMethod[] = []
	for (const tool of catalog.tools) {
		const methodName = names.get(tool.name) ?? sanitizeMcpMethodName(tool.name)
		const detected = nativeMethodInputContract(tool.inputSchema)
		const inputContract = {
			...detected,
			commandWrapper: mergeCommandWrapperContracts(
				detected.commandWrapper,
				catalog.wrappers[tool.name],
			),
		}
		const path = `${connectorName}.${methodName}`
		methods.push({
			serverSlug: catalog.serverSlug,
			connectorName,
			sourceToolName: tool.name,
			methodName,
			path,
			description: tool.description,
			inputSchema: tool.inputSchema,
			inputContract,
			annotations: tool.annotations,
			canonical: renderCanonicalMethod({
				path,
				inputSchema: tool.inputSchema,
				description: tool.description,
				inputContract,
			}),
		})
		for (const virtual of commandWrapperVirtualMethods(
			methodName,
			inputContract.commandWrapper,
		)) {
			methods.push(
				virtualCatalogMethod({
					serverSlug: catalog.serverSlug,
					connectorName,
					parentMethod: methodName,
					virtual,
				}),
			)
		}
	}
	return methods.sort((left, right) => left.path.localeCompare(right.path))
}

function searchTerms(value: string): string[] {
	return [
		...new Set(
			value
				.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((term) => term.length > 1),
		),
	]
}

export function scoreCatalogMethod(
	query: string,
	method: CatalogMethod,
): number {
	const terms = searchTerms(query)
	if (!terms.length) return 1
	const methodTerms = new Set(searchTerms(method.path))
	const description = method.description?.toLowerCase() ?? ""
	let score = 0
	for (const term of terms) {
		if (methodTerms.has(term)) score += 8
		else if (method.path.toLowerCase().includes(term)) score += 4
		if (description.includes(term)) score += 1
	}
	return score
}

export function nearestCatalogMethods(
	name: string,
	methods: readonly CatalogMethod[],
	limit = 5,
): CatalogMethod[] {
	return methods
		.map((method) => ({ method, score: scoreCatalogMethod(name, method) }))
		.sort(
			(left, right) =>
				right.score - left.score ||
				left.method.path.localeCompare(right.method.path),
		)
		.slice(0, limit)
		.map(({ method }) => method)
}
