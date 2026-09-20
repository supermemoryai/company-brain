import { getCatalogEntry, MCP_CATALOG } from "./catalog"
import directoryData from "./directory.json"

export type McpDirectoryAvailability =
	| "fixed"
	| "tenant"
	| "unavailable"
	| "local"

export type McpDirectoryEntry = {
	id: string
	name: string
	type: "remote" | "local"
	url: string | null
	auth: string
	note: string | null
	categories: string[]
	popularity: number
	availability: McpDirectoryAvailability
	iconDomain: string | null
	setup: "custom" | "unsupported"
	oauthCapability: "dcr" | "preregistered" | null
	authMethods: Array<"oauth" | "api-key">
}

export const MCP_DIRECTORY_VERSION = directoryData.version as number
export const MCP_DIRECTORY = directoryData.entries as McpDirectoryEntry[]

const catalogByName = new Map(
	MCP_CATALOG.map((e) => [e.name.toLowerCase(), e.slug]),
)

export function catalogSlugForDirectoryEntry(
	entry: McpDirectoryEntry,
): string | null {
	return catalogByName.get(entry.name.toLowerCase()) ?? null
}

// The web lists every entry; this is the subset we can actually finish connecting.
export function isConnectable(entry: McpDirectoryEntry): boolean {
	return (
		entry.availability !== "unavailable" &&
		entry.type === "remote" &&
		entry.setup === "custom" &&
		!!entry.url &&
		entry.authMethods.length > 0
	)
}

export const CONNECTABLE_MCP_DIRECTORY = MCP_DIRECTORY.filter(isConnectable)

// oauth = DCR; apikey = their own key; prereg = needs our OAuth app registered.
export type McpConnectMode = "oauth" | "apikey" | "prereg"

export function connectModeFor(entry: McpDirectoryEntry): McpConnectMode {
	if (entry.oauthCapability === "dcr") return "oauth"
	if (entry.oauthCapability === "preregistered") return "prereg"
	return "apikey"
}

// prereg by raw URL falls through to DCR, which those vendors reject.
export function isAgentOfferable(entry: McpDirectoryEntry): boolean {
	if (!isConnectable(entry)) return false
	if (catalogSlugForDirectoryEntry(entry)) return true
	return connectModeFor(entry) !== "prereg"
}

export const AGENT_MCP_DIRECTORY = MCP_DIRECTORY.filter(isAgentOfferable)

// Must stay byte-identical to apps/web's connectCustom, or one app becomes two rows.
const DIRECTORY_SLUG_RE = /-sm-dir-[a-z0-9]{6}$/

function slugifyMcpName(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63)
}

function stableDirectorySuffix(value: string): string {
	let hash = 0x811c9dc5
	for (const character of value) {
		hash ^= character.codePointAt(0) ?? 0
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0).toString(36).slice(0, 6).padStart(6, "0")
}

export function directorySlug(entry: McpDirectoryEntry): string {
	const suffix = stableDirectorySuffix(entry.url ?? entry.note ?? entry.id)
	return `${slugifyMcpName(entry.name).slice(0, 49)}-sm-dir-${suffix}`
}

export function isDirectorySlug(slug: string): boolean {
	return DIRECTORY_SLUG_RE.test(slug)
}

// Agent-offerable only, so a hidden app resolves to unknown instead of a dead connect.
const directoryBySlug = new Map(
	AGENT_MCP_DIRECTORY.map((entry) => [directorySlug(entry), entry]),
)

export function getDirectoryEntryBySlug(
	slug: string,
): McpDirectoryEntry | undefined {
	return directoryBySlug.get(slug)
}

// Catalog first, then the directory: a slug from either must render as a name.
export function mcpAppDisplayName(slug: string): string {
	return (
		getCatalogEntry(slug)?.name ?? getDirectoryEntryBySlug(slug)?.name ?? slug
	)
}

// Catalog entries carry a written category; directory ones only have slugs.
export function mcpAppSubtitle(slug: string): string | undefined {
	const catalogCategory = getCatalogEntry(slug)?.category
	if (catalogCategory) return catalogCategory
	const labels = (getDirectoryEntryBySlug(slug)?.categories ?? [])
		.slice(0, 3)
		.map((c) =>
			c
				.split("-")
				.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
				.join(" "),
		)
	return labels.length ? labels.join(" · ") : undefined
}

// Opens the prefilled setup dialog. Param is namespaced: apps/web strips a bare `org`.
export function mcpSetupUrl(
	env: { CONSUMER_APP_URL?: string },
	slug: string,
): string {
	const base = (env.CONSUMER_APP_URL ?? "https://app.supermemory.ai").replace(
		/\/$/,
		"",
	)
	// /configure is canonical; /configure/tools only redirects here.
	return `${base}/configure?mcpSetup=${encodeURIComponent(slug)}`
}

function score(query: string, entry: McpDirectoryEntry): number {
	const q = query.toLowerCase().trim()
	if (!q) return 0
	const name = entry.name.toLowerCase()
	const terms = q.split(/\s+/).filter(Boolean)
	let s = 0
	if (name === q) s += 100
	else if (name.startsWith(q)) s += 60
	else if (name.includes(q)) s += 40
	for (const term of terms) {
		if (name.includes(term)) s += 10
		if (entry.categories.some((c) => c.includes(term))) s += 4
		if (entry.note?.toLowerCase().includes(term)) s += 2
	}
	if (s > 0) s += Math.min(entry.popularity / 5000, 5)
	return s
}

export type McpDirectorySearchHit = {
	name: string
	url: string
	categories: string[]
	slug: string
	connectMode: McpConnectMode
}

export type McpDirectorySearchResult = {
	apps: McpDirectorySearchHit[]
	totalMatches: number
	truncated: boolean
}

export function searchMcpDirectory(
	query: string,
	limit = 10,
): McpDirectorySearchResult {
	const ranked = AGENT_MCP_DIRECTORY.map((entry) => ({
		entry,
		score: score(query, entry),
	}))
		.filter((r) => r.score > 0)
		.sort((a, b) => b.score - a.score)
	const apps = ranked.slice(0, limit).map(({ entry }) => {
		const catalogSlug = catalogSlugForDirectoryEntry(entry)
		return {
			name: entry.name,
			url: entry.url as string,
			categories: entry.categories,
			slug: catalogSlug ?? directorySlug(entry),
			connectMode: catalogSlug ? ("oauth" as const) : connectModeFor(entry),
		}
	})
	// Broad queries match far more than the limit; without this the model reads a
	// slice as the whole set and denies apps it could connect.
	return {
		apps,
		totalMatches: ranked.length,
		truncated: ranked.length > apps.length,
	}
}
