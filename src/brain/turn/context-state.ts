import type { FormattedThreadHistoryEntry } from "../prompt/build"
import { MCP_CATALOG } from "../tools/mcp/catalog"
import type { McpRuntimeServerState } from "../tools/mcp/runtime-tools"

export type PersistedAppConnectionState = {
	id: string
	serverSlug: string
	userId: string | null
	status: "active" | "pending" | "error"
}

export function buildAppCapabilitySnapshot(args: {
	persistedConnections: PersistedAppConnectionState[]
	runtimeStates: McpRuntimeServerState[]
}) {
	const persistedBySlug = new Map<string, PersistedAppConnectionState>()
	for (const connection of args.persistedConnections) {
		const current = persistedBySlug.get(connection.serverSlug)
		if (!current || (current.userId === null && connection.userId !== null)) {
			persistedBySlug.set(connection.serverSlug, connection)
		}
	}
	const runtimeBySlug = new Map<string, McpRuntimeServerState>()
	for (const state of args.runtimeStates) {
		const current = runtimeBySlug.get(state.serverSlug)
		const priority = (candidate: McpRuntimeServerState) =>
			(candidate.runtimeStatus === "ready" ? 10 : 0) +
			(candidate.accessScope === "personal"
				? 3
				: candidate.accessScope === "organization"
					? 2
					: 1)
		if (!current || priority(state) > priority(current)) {
			runtimeBySlug.set(state.serverSlug, state)
		}
	}
	const catalogBySlug = new Map(MCP_CATALOG.map((entry) => [entry.slug, entry]))
	const slugs = [
		...MCP_CATALOG.map((entry) => entry.slug),
		...[...persistedBySlug.keys()].filter((slug) => !catalogBySlug.has(slug)),
		...[...runtimeBySlug.keys()].filter(
			(slug) => !catalogBySlug.has(slug) && !persistedBySlug.has(slug),
		),
	]
	const apps = slugs.map((slug) => {
		const entry = catalogBySlug.get(slug)
		const persisted = persistedBySlug.get(slug)
		const runtime = runtimeBySlug.get(slug)
		const runtimeStatus = runtime?.runtimeStatus ?? "not_attempted"
		const state = (() => {
			if (runtime?.runtimeStatus === "ready") return "ready" as const
			if (
				runtime?.runtimeStatus === "reconnect_required" ||
				persisted?.status === "error"
			) {
				return "reconnect_required" as const
			}
			if (persisted?.status === "pending") return "pending" as const
			if (
				runtime?.runtimeStatus === "temporarily_unavailable" ||
				persisted?.status === "active"
			) {
				return "temporarily_unavailable" as const
			}
			return "not_connected" as const
		})()
		return {
			slug,
			name: entry?.name ?? slug,
			category: entry?.category ?? "custom",
			authType: entry?.authType ?? "unknown",
			connectable: Boolean(entry),
			configured: Boolean(persisted),
			persistedStatus: persisted?.status ?? "not_configured",
			usableThisTurn: state === "ready",
			runtimeStatus,
			state,
			accessScope:
				runtime?.accessScope ??
				(persisted
					? persisted.userId === null
						? "organization"
						: "personal"
					: null),
		}
	})
	return {
		configuredApps: apps.filter((app) => app.configured).map((app) => app.slug),
		usableApps: apps.filter((app) => app.usableThisTurn).map((app) => app.slug),
		apps,
	}
}

function scoreThreadEntry(
	entry: FormattedThreadHistoryEntry,
	query: string,
): number {
	const normalized = query.trim().toLowerCase()
	if (!normalized) return 1
	const haystack = `${entry.speakerLabel} ${entry.content}`.toLowerCase()
	let score = haystack.includes(normalized) ? 100 : 0
	for (const term of normalized.split(/\s+/).filter(Boolean)) {
		if (haystack.includes(term)) score++
	}
	return score
}

export function selectThreadHistoryEntries(
	entries: FormattedThreadHistoryEntry[],
	args: { query?: string; cursor?: number; limit: number },
): FormattedThreadHistoryEntry[] {
	if (!args.query?.trim()) {
		const start = args.cursor ?? 0
		return entries.slice(start, start + args.limit)
	}
	return entries
		.map((entry) => ({
			entry,
			score: scoreThreadEntry(entry, args.query ?? ""),
		}))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, args.limit)
		.map(({ entry }) => entry)
}
