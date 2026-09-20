import { and, db, eq, isNull, or } from "@repo/db"
import type { McpConnectionMetadata } from "@repo/db/schema/brain/mcp"
import { mcpConnection } from "@repo/db/schema/brain/mcp"
import { getAgentByName } from "agents"
import { encryptToken } from "@/lib/crypto"
import { captureActivationRung } from "@/lib/posthog"

export type McpConnectionRow = typeof mcpConnection.$inferSelect

// userId null = org-shared connection.
export async function getConnection(
	env: Env,
	orgId: string,
	serverSlug: string,
	userId: string | null,
): Promise<McpConnectionRow | undefined> {
	const [row] = await db(env)
		.select()
		.from(mcpConnection)
		.where(
			and(
				eq(mcpConnection.orgId, orgId),
				eq(mcpConnection.serverSlug, serverSlug),
				userId === null
					? isNull(mcpConnection.userId)
					: eq(mcpConnection.userId, userId),
			),
		)
		.limit(1)
	return row
}

export async function getConnectionById(
	env: Env,
	connectionId: string,
): Promise<McpConnectionRow | undefined> {
	const [row] = await db(env)
		.select()
		.from(mcpConnection)
		.where(eq(mcpConnection.id, connectionId))
		.limit(1)
	return row
}

// Connections visible to an actor (any status): org-shared + the actor's own.
// Used by the list route so a member never sees peers' personal connections.
export async function listConnectionsForActor(
	env: Env,
	orgId: string,
	userId: string | undefined,
	options: { personalOnly?: boolean; orgSharedOnly?: boolean } = {},
): Promise<McpConnectionRow[]> {
	if (options.personalOnly) {
		if (!userId) return []
		return db(env)
			.select()
			.from(mcpConnection)
			.where(
				and(eq(mcpConnection.orgId, orgId), eq(mcpConnection.userId, userId)),
			)
	}
	if (options.orgSharedOnly) {
		return db(env)
			.select()
			.from(mcpConnection)
			.where(and(eq(mcpConnection.orgId, orgId), isNull(mcpConnection.userId)))
	}
	const scope = userId
		? or(isNull(mcpConnection.userId), eq(mcpConnection.userId, userId))
		: isNull(mcpConnection.userId)
	return db(env)
		.select()
		.from(mcpConnection)
		.where(and(eq(mcpConnection.orgId, orgId), scope))
}

// Active connections usable by an actor. personalOnly restricts to the actor's
// own connections (org-shared excluded); a personal-only actor with no userId
// gets nothing rather than falling back to org-shared.
export async function listActiveConnectionsForActor(
	env: Env,
	orgId: string,
	userId: string | undefined,
	personalOnly = false,
): Promise<McpConnectionRow[]> {
	if (personalOnly) {
		if (!userId) return []
		return db(env)
			.select()
			.from(mcpConnection)
			.where(
				and(
					eq(mcpConnection.orgId, orgId),
					eq(mcpConnection.status, "active"),
					eq(mcpConnection.userId, userId),
				),
			)
	}
	const scope = userId
		? or(isNull(mcpConnection.userId), eq(mcpConnection.userId, userId))
		: isNull(mcpConnection.userId)
	return db(env)
		.select()
		.from(mcpConnection)
		.where(
			and(
				eq(mcpConnection.orgId, orgId),
				eq(mcpConnection.status, "active"),
				scope,
			),
		)
}

export async function saveConnectionTokens(
	env: Env,
	connectionId: string,
	tokens: {
		accessToken: string
		refreshToken?: string
		expiresInSec?: number
		scope?: string
		tokenType?: string
	},
	metadataPatch?: Partial<McpConnectionMetadata>,
): Promise<void> {
	const secret = env.ENCRYPTION_SECRET
	const [existing] = await db(env)
		.select({
			metadata: mcpConnection.metadata,
			status: mcpConnection.status,
			orgId: mcpConnection.orgId,
			userId: mcpConnection.userId,
			serverSlug: mcpConnection.serverSlug,
		})
		.from(mcpConnection)
		.where(eq(mcpConnection.id, connectionId))
		.limit(1)

	await db(env)
		.update(mcpConnection)
		.set({
			accessToken: await encryptToken(tokens.accessToken, secret),
			refreshToken: tokens.refreshToken
				? await encryptToken(tokens.refreshToken, secret)
				: undefined,
			// undefined (not null) so Drizzle preserves prior expiry when a
			// refresh response omits expires_in instead of marking it non-expiring
			expiresAt: tokens.expiresInSec
				? new Date(Date.now() + tokens.expiresInSec * 1000)
				: undefined,
			scopes: tokens.scope ? tokens.scope.split(" ") : undefined,
			status: "active",
			metadata: {
				...existing?.metadata,
				...metadataPatch,
				tokenType: tokens.tokenType ?? existing?.metadata?.tokenType,
			},
			updatedAt: new Date(),
		})
		.where(eq(mcpConnection.id, connectionId))

	// Only the first activation counts; later calls are token refreshes.
	if (existing && existing.status !== "active" && existing.orgId) {
		captureActivationRung({
			orgId: existing.orgId,
			userId: existing.userId ?? undefined,
			rung: existing.userId ? "tool_personal" : "tool_workspace",
			source: "oauth",
			detail: { server_slug: existing.serverSlug },
		})
	}
}

export async function markConnectionError(
	env: Env,
	connectionId: string,
	error: string,
): Promise<void> {
	const [existing] = await db(env)
		.select({ metadata: mcpConnection.metadata })
		.from(mcpConnection)
		.where(eq(mcpConnection.id, connectionId))
		.limit(1)

	await db(env)
		.update(mcpConnection)
		.set({
			status: "error",
			metadata: { ...existing?.metadata, lastError: error },
			updatedAt: new Date(),
		})
		.where(eq(mcpConnection.id, connectionId))
}

export async function deleteConnection(
	env: Env,
	orgId: string,
	serverSlug: string,
	userId: string | null,
): Promise<boolean> {
	const deleted = await db(env)
		.delete(mcpConnection)
		.where(
			and(
				eq(mcpConnection.orgId, orgId),
				eq(mcpConnection.serverSlug, serverSlug),
				userId === null
					? isNull(mcpConnection.userId)
					: eq(mcpConnection.userId, userId),
			),
		)
		.returning({ id: mcpConnection.id })
	if (deleted.length > 0) {
		try {
			const agent = await getAgentByName(env.COMPANY_BRAIN_AGENT, orgId)
			await Promise.all(deleted.map((d) => agent.onConnectionRevoked(d.id)))
		} catch (err) {
			console.warn(
				`[company-brain] revoke leases for deleted connection failed: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}
	return deleted.length > 0
}

// Static-auth: store a user-provided bearer/header secret, no OAuth.
export async function upsertStaticConnection(
	env: Env,
	args: {
		orgId: string
		userId: string | null
		serverSlug: string
		serverUrl: string
		token: string
		headerName?: string
		extraHeaders?: Record<string, string>
	},
): Promise<void> {
	const secret = env.ENCRYPTION_SECRET
	const encrypted = await encryptToken(args.token, secret)
	const existing = await getConnection(
		env,
		args.orgId,
		args.serverSlug,
		args.userId,
	)

	if (existing) {
		// Replacing any prior connection with a static one: clear OAuth token/state
		// so runtime takes the static-header branch instead of the stale oauth path.
		// The request is authoritative, so reconnecting without headers clears them.
		await db(env)
			.update(mcpConnection)
			.set({
				accessToken: encrypted,
				refreshToken: null,
				expiresAt: null,
				scopes: null,
				serverUrl: args.serverUrl,
				authType: "static",
				status: "active",
				metadata: {
					headerName: args.headerName,
					extraHeaders: args.extraHeaders,
				},
				updatedAt: new Date(),
			})
			.where(eq(mcpConnection.id, existing.id))
		return
	}

	await db(env)
		.insert(mcpConnection)
		.values({
			orgId: args.orgId,
			userId: args.userId,
			serverSlug: args.serverSlug,
			serverUrl: args.serverUrl,
			authType: "static",
			status: "active",
			accessToken: encrypted,
			metadata: {
				headerName: args.headerName,
				extraHeaders: args.extraHeaders,
			},
		})

	captureActivationRung({
		orgId: args.orgId,
		userId: args.userId ?? undefined,
		rung: args.userId ? "tool_personal" : "tool_workspace",
		source: "token",
		detail: { server_slug: args.serverSlug },
	})
}
