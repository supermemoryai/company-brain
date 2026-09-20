import type { ActiveLease, LeaseRuntimeContext } from "../../lease/types"
import type { TurnActor } from "../../turn/actor"
import type { CompanyBrainAgent } from "../../turn/agent"
import { ToolError } from "../../turn/errors"
import { type TurnState, touchTurnState } from "../../turn/state"
import {
	catalogMethods,
	getCatalogEntry,
	getRemoteCatalogEntry,
	scoreCatalogMethod,
	stableConnectorNames,
} from "./catalog"
import { McpReauthRequiredError } from "./oauth-provider"
import type { ConnectedAppServerRef } from "./pause"
import { connectToolProvider, type ToolProviderHandle } from "./provider"
import {
	getConnectionById,
	type McpConnectionRow,
	markConnectionError,
} from "./store"
import {
	loadMcpToolCatalog,
	type McpToolCatalog,
	saveMcpToolCatalog,
} from "./tool-catalog-store"

export const DISCOVERY_METHOD_LIMIT_PER_APP = 12

export type ConnectedAppSource = {
	ref: ConnectedAppServerRef
	displayName: string
	trustedAnnotations: boolean
	lease?: ActiveLease
}

export type OpenConnectedApp = {
	source: ConnectedAppSource
	handle: ToolProviderHandle
	catalog: McpToolCatalog
	trustedAnnotations: boolean
}

function dedupeLeasesByServer(leases: readonly ActiveLease[]): ActiveLease[] {
	const byServer = new Map<string, ActiveLease>()
	for (const lease of leases) {
		const current = byServer.get(lease.serverSlug)
		if (!current || lease.mode === "read_write") {
			byServer.set(lease.serverSlug, lease)
		}
	}
	return [...byServer.values()]
}

export function createConnectedAppSources(args: {
	connections: readonly McpConnectionRow[]
	actor: TurnActor
	leaseCtx?: LeaseRuntimeContext
}): ConnectedAppSource[] {
	const bySlug = new Map<string, McpConnectionRow>()
	for (const connection of args.connections) {
		if (connection.status !== "active") continue
		const current = bySlug.get(connection.serverSlug)
		if (!current || (current.userId === null && connection.userId !== null)) {
			bySlug.set(connection.serverSlug, connection)
		}
	}
	const leases = dedupeLeasesByServer(args.leaseCtx?.leases ?? []).filter(
		(lease) => !bySlug.has(lease.serverSlug),
	)
	const slugs = [...bySlug.keys(), ...leases.map((lease) => lease.serverSlug)]
	const connectorNames = stableConnectorNames(slugs)
	const sources: ConnectedAppSource[] = []

	for (const connection of bySlug.values()) {
		const catalog = getCatalogEntry(connection.serverSlug)
		sources.push({
			ref: {
				serverSlug: connection.serverSlug,
				connectorName:
					connectorNames.get(connection.serverSlug) ?? connection.serverSlug,
				connectionId: connection.id,
				accessScope: connection.userId === null ? "organization" : "personal",
				readOnly: args.actor.readOnly === true || connection.userId === null,
			},
			displayName: catalog?.name ?? connection.serverSlug,
			trustedAnnotations: Boolean(catalog),
		})
	}
	for (const lease of leases) {
		const catalog = getCatalogEntry(lease.serverSlug)
		sources.push({
			ref: {
				serverSlug: lease.serverSlug,
				connectorName: connectorNames.get(lease.serverSlug) ?? lease.serverSlug,
				connectionId: lease.lessorConnectionId,
				accessScope: "temporary",
				readOnly: args.actor.readOnly === true || lease.mode === "read_only",
				leaseId: lease.leaseId,
				leaseMode: lease.mode,
			},
			displayName: catalog?.name ?? lease.serverSlug,
			trustedAnnotations: Boolean(catalog),
			lease,
		})
	}
	return sources.sort((left, right) =>
		left.ref.serverSlug.localeCompare(right.ref.serverSlug),
	)
}

export function sourceFromJournalRef(args: {
	ref: ConnectedAppServerRef
	sources: readonly ConnectedAppSource[]
}): ConnectedAppSource | undefined {
	return args.sources.find(
		(source) =>
			source.ref.serverSlug === args.ref.serverSlug &&
			source.ref.connectorName === args.ref.connectorName &&
			source.ref.connectionId === args.ref.connectionId &&
			source.ref.accessScope === args.ref.accessScope &&
			source.ref.leaseId === args.ref.leaseId,
	)
}

async function validateSourceConnection(args: {
	env: Env
	actor: TurnActor
	source: ConnectedAppSource
	leaseCtx?: LeaseRuntimeContext
}): Promise<McpConnectionRow> {
	if (
		args.source.ref.leaseId &&
		!(await args.leaseCtx?.revalidate(args.source.ref.leaseId))
	) {
		throw new ToolError({
			kind: "unavailable",
			tool: args.source.ref.serverSlug,
			message: `Temporary access to ${args.source.displayName} expired or was revoked.`,
			suggestion: "Request connected-app access again before retrying.",
			retryable: false,
		})
	}
	const connection = await getConnectionById(
		args.env,
		args.source.ref.connectionId,
	)
	if (!connection || connection.status !== "active") {
		throw new ToolError({
			kind: "unavailable",
			tool: args.source.ref.serverSlug,
			message: `${args.source.displayName} is no longer connected.`,
			suggestion: `Reconnect ${args.source.displayName}, then retry.`,
			retryable: false,
		})
	}
	if (connection.orgId !== args.actor.orgId) {
		throw new ToolError({
			kind: "policy_denied",
			tool: args.source.ref.serverSlug,
			message: `${args.source.displayName} is not available to this workspace.`,
			suggestion: "Use only a connected app visible to this workspace.",
			retryable: false,
		})
	}
	if (
		args.source.ref.accessScope === "personal" &&
		(!args.actor.userId || connection.userId !== args.actor.userId)
	) {
		throw new ToolError({
			kind: "policy_denied",
			tool: args.source.ref.serverSlug,
			message: `${args.source.displayName} is not available to this requester.`,
			suggestion:
				"Use the requester's own connection or request temporary access.",
			retryable: false,
		})
	}
	if (
		args.source.ref.accessScope === "organization" &&
		connection.userId !== null
	) {
		throw new ToolError({
			kind: "policy_denied",
			tool: args.source.ref.serverSlug,
			message: `${args.source.displayName} is not an organization connection.`,
			suggestion: "Use the connection selected for this requester.",
			retryable: false,
		})
	}
	if (
		args.source.ref.accessScope === "temporary" &&
		(!args.source.lease ||
			args.source.lease.leaseId !== args.source.ref.leaseId ||
			args.source.lease.lessorConnectionId !== args.source.ref.connectionId)
	) {
		throw new ToolError({
			kind: "policy_denied",
			tool: args.source.ref.serverSlug,
			message: `Temporary access to ${args.source.displayName} is invalid.`,
			suggestion: "Request a new connected-app access lease.",
			retryable: false,
		})
	}
	return connection
}

function trustsToolAnnotations(
	connection: McpConnectionRow,
	source: ConnectedAppSource,
): boolean {
	const curated = getRemoteCatalogEntry(source.ref.serverSlug)
	return (
		source.trustedAnnotations &&
		curated !== undefined &&
		connection.serverUrl === curated.serverUrl
	)
}

async function connectSource(args: {
	env: Env
	actor: TurnActor
	source: ConnectedAppSource
	callbackUrl: string
	leaseCtx?: LeaseRuntimeContext
	traceId: string
}): Promise<{ connection: McpConnectionRow; handle: ToolProviderHandle }> {
	const connection = await validateSourceConnection(args)
	try {
		return {
			connection,
			handle: await connectToolProvider(args.env, connection, args.callbackUrl),
		}
	} catch (error) {
		if (error instanceof McpReauthRequiredError) {
			await markConnectionError(
				args.env,
				connection.id,
				"reconnect required",
			).catch(() => {})
		}
		throw new ToolError({
			kind:
				error instanceof McpReauthRequiredError
					? "auth_required"
					: "unavailable",
			tool: args.source.ref.serverSlug,
			message:
				error instanceof McpReauthRequiredError
					? `${args.source.displayName} needs to be reconnected.`
					: `${args.source.displayName} is temporarily unavailable.`,
			detail: error instanceof Error ? error.message : String(error),
			suggestion:
				error instanceof McpReauthRequiredError
					? `Reconnect ${args.source.displayName}, then retry.`
					: "Retry once later; if the app is still unavailable, report that the live lookup failed.",
			retryable: !(error instanceof McpReauthRequiredError),
			traceId: args.traceId,
		})
	}
}

export async function resolveSourceCatalog(args: {
	agent: CompanyBrainAgent
	env: Env
	actor: TurnActor
	source: ConnectedAppSource
	callbackUrl: string
	leaseCtx?: LeaseRuntimeContext
	traceId: string
}): Promise<McpToolCatalog> {
	const cached = loadMcpToolCatalog(args.agent, args.source.ref.connectionId)
	if (cached && cached.serverSlug === args.source.ref.serverSlug) return cached
	const { handle } = await connectSource(args)
	try {
		const tools = await handle.listTools()
		return saveMcpToolCatalog(args.agent, {
			connectionId: args.source.ref.connectionId,
			serverSlug: args.source.ref.serverSlug,
			tools,
		})
	} finally {
		await handle.close().catch(() => {})
	}
}

export async function openConnectedApp(args: {
	agent: CompanyBrainAgent
	env: Env
	actor: TurnActor
	source: ConnectedAppSource
	callbackUrl: string
	leaseCtx?: LeaseRuntimeContext
	traceId: string
}): Promise<OpenConnectedApp> {
	const { connection, handle } = await connectSource(args)
	try {
		const cached = loadMcpToolCatalog(args.agent, args.source.ref.connectionId)
		const catalog =
			cached && cached.serverSlug === args.source.ref.serverSlug
				? cached
				: saveMcpToolCatalog(args.agent, {
						connectionId: args.source.ref.connectionId,
						serverSlug: args.source.ref.serverSlug,
						tools: await handle.listTools(),
					})
		return {
			source: args.source,
			handle,
			catalog,
			trustedAnnotations: trustsToolAnnotations(connection, args.source),
		}
	} catch (error) {
		await handle.close().catch(() => {})
		throw error
	}
}

export async function discoverAppMethods(args: {
	agent: CompanyBrainAgent
	env: Env
	actor: TurnActor
	sources: readonly ConnectedAppSource[]
	apps: readonly string[]
	query: string
	callbackUrl: string
	leaseCtx?: LeaseRuntimeContext
	traceId: string
	state: TurnState
}): Promise<{
	status: "ok"
	apps: Array<{
		app: string
		global: string
		fingerprint: string
		methods: Array<{ path: string; signature: string }>
		omitted: number
		hint?: string
	}>
}> {
	const bySlug = new Map(
		args.sources.map((source) => [source.ref.serverSlug, source]),
	)
	const selected = args.apps.map((app) => {
		const source = bySlug.get(app)
		if (!source) {
			throw new ToolError({
				kind: "unavailable",
				tool: "discover_app_methods",
				message: `Connected app '${app}' is unavailable to this requester.`,
				suggestion: "Select one of the connected app slugs in the tool schema.",
				retryable: false,
				traceId: args.traceId,
			})
		}
		return source
	})
	const catalogs = await Promise.all(
		selected.map(async (source) => ({
			source,
			catalog: await resolveSourceCatalog({ ...args, source }),
		})),
	)
	const now = Date.now()
	const results = catalogs.map(({ source, catalog }, appIndex) => {
		const methods = catalogMethods(catalog, source.ref.connectorName)
			.map((method) => ({
				method,
				score: scoreCatalogMethod(args.query, method),
			}))
			.sort(
				(left, right) =>
					right.score - left.score ||
					left.method.path.localeCompare(right.method.path),
			)
			.map(({ method }) => method)
		const shown = methods.slice(0, DISCOVERY_METHOD_LIMIT_PER_APP)
		const omitted = Math.max(0, methods.length - shown.length)
		const known = new Map(
			(args.state.apps.discovered[source.ref.serverSlug] ?? []).map(
				(method) => [method.name, method],
			),
		)
		for (const [index, method] of shown.entries()) {
			known.set(method.path, {
				name: method.path,
				canonical: method.canonical,
				discoveredAt: now + appIndex * DISCOVERY_METHOD_LIMIT_PER_APP + index,
			})
		}
		args.state.apps.discovered[source.ref.serverSlug] = [...known.values()]
		return {
			app: source.ref.serverSlug,
			global: source.ref.connectorName,
			fingerprint: catalog.fingerprint,
			methods: shown.map((method) => ({
				path: method.path,
				signature: method.canonical,
			})),
			omitted,
			...(omitted > 0 ? { hint: "narrow the query" } : {}),
		}
	})
	touchTurnState(args.state)
	return { status: "ok", apps: results }
}
