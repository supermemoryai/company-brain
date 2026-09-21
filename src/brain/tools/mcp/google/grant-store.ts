import { and, asc, db, eq, isNotNull, isNull, lt, or, sql, withTransaction } from "@repo/db"
import { googleWorkspaceGrant, mcpConnection } from "@repo/db/schema/brain/mcp"
import { generateId } from "@repo/lib/generate-id"
import type { SQL } from "drizzle-orm"
import { decryptToken, encryptToken } from "@/lib/crypto"
import { captureActivationRung } from "@/lib/posthog"
import {
	GoogleCallbackScopeError,
	type GoogleIdentity,
	type GoogleTokenResponse,
	validateGoogleCallbackScopes,
} from "./oauth"
import { hasRequiredGmailScopes } from "./scopes"

export type GoogleWorkspaceGrant = typeof googleWorkspaceGrant.$inferSelect
// withTransaction hands back the same handle, since D1 has no interactive
// transactions to open.
type GoogleGrantTransaction = ReturnType<typeof db>

export class GoogleIdentityMismatchError extends Error {
	authorization?: LosingGoogleAuthorization
	winner?: GoogleAuthorizationIdentity | null
	authorizationPersisted?: boolean
}
export class GoogleGrantReconnectRequiredError extends Error {}
export class GoogleBindingAlreadyExistsError extends Error {
	constructor(
		public readonly authorization: LosingGoogleAuthorization,
		public readonly winner?: GoogleAuthorizationIdentity,
		public authorizationPersisted = false,
	) {
		super("Gmail was connected while this authorization was in progress")
	}
}

class GoogleCallbackScopeCleanupError extends GoogleCallbackScopeError {
	constructor(
		message: string,
		public readonly authorization: LosingGoogleAuthorization,
		public readonly winner: GoogleAuthorizationIdentity | null | undefined,
		public readonly authorizationPersisted: boolean,
	) {
		super(message)
	}
}

export type GoogleAuthorizationIdentity = {
	googleSub: string
	oauthClientId: string
}

export type LosingGoogleAuthorization = GoogleAuthorizationIdentity & {
	accessToken: string
	refreshToken?: string
}

export function googleCallbackLockKey(
	orgId: string,
	userId: string,
	slug: string,
): string {
	return `company-brain:embedded-callback:${orgId}:${userId}:${slug}`
}

export function googleGrantStatus(scopes: readonly string[]): {
	status: "active" | "error"
	lastError: string | null
} {
	return hasRequiredGmailScopes(scopes)
		? { status: "active", lastError: null }
		: { status: "error", lastError: "missing required Gmail scopes" }
}

export function assertGoogleReconnectIdentity(
	target:
		| Pick<GoogleWorkspaceGrant, "userId" | "oauthClientId" | "googleSub">
		| undefined,
	expected: GoogleAuthorizationIdentity & { userId: string },
): asserts target is Pick<
	GoogleWorkspaceGrant,
	"userId" | "oauthClientId" | "googleSub"
> {
	if (
		!target ||
		target.userId !== expected.userId ||
		target.oauthClientId !== expected.oauthClientId ||
		target.googleSub !== expected.googleSub
	) {
		throw new GoogleIdentityMismatchError(
			"Reconnect must use the same Google account",
		)
	}
}

export async function revokeGoogleAuthorizationToken(
	token: string,
	request: typeof fetch = fetch,
): Promise<void> {
	const response = await request("https://oauth2.googleapis.com/revoke", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ token }),
	})
	if (!response.ok) {
		throw new Error(`Google OAuth revocation failed (${response.status})`)
	}
}

export function shouldRevokeLosingGoogleAuthorization(
	loser: GoogleAuthorizationIdentity,
	winner: GoogleAuthorizationIdentity | null | undefined,
): boolean {
	if (winner === undefined) return false
	if (winner === null) return true
	return (
		loser.googleSub !== winner.googleSub ||
		loser.oauthClientId !== winner.oauthClientId
	)
}

export async function cleanupExchangedGoogleAuthorization(
	authorization: LosingGoogleAuthorization,
	winner: GoogleAuthorizationIdentity | null | undefined,
	request: typeof fetch = fetch,
	authorizationPersisted = false,
): Promise<"discarded" | "revoked"> {
	if (authorizationPersisted) return "discarded"
	if (!shouldRevokeLosingGoogleAuthorization(authorization, winner)) {
		return "discarded"
	}
	await revokeGoogleAuthorizationToken(
		authorization.refreshToken ?? authorization.accessToken,
		request,
	)
	return "revoked"
}

export async function checkGoogleCallbackAuthorization(args: {
	authorization: LosingGoogleAuthorization
	winner: GoogleAuthorizationIdentity | null | undefined
	targetGrantId?: string | null
	requestedScopes: readonly string[] | null | undefined
	grantedScope: string
	authorizationPersisted?: boolean
}): Promise<void> {
	try {
		validateGoogleCallbackScopes(args.requestedScopes, args.grantedScope)
	} catch (error) {
		if (error instanceof GoogleCallbackScopeError) {
			throw new GoogleCallbackScopeCleanupError(
				error.message,
				args.authorization,
				args.winner,
				args.authorizationPersisted ?? false,
			)
		}
		throw error
	}

	if (!args.targetGrantId && args.winner) {
		throw new GoogleBindingAlreadyExistsError(
			args.authorization,
			args.winner,
			args.authorizationPersisted,
		)
	}
}

export async function cleanupGoogleCallbackError(
	error: unknown,
	request: typeof fetch = fetch,
): Promise<void> {
	if (error instanceof GoogleBindingAlreadyExistsError) {
		await cleanupExchangedGoogleAuthorization(
			error.authorization,
			error.winner,
			request,
			error.authorizationPersisted,
		).catch(() => {})
	} else if (error instanceof GoogleCallbackScopeCleanupError) {
		await cleanupExchangedGoogleAuthorization(
			error.authorization,
			error.winner,
			request,
			error.authorizationPersisted,
		).catch(() => {})
	} else if (
		error instanceof GoogleIdentityMismatchError &&
		error.authorization
	) {
		await cleanupExchangedGoogleAuthorization(
			error.authorization,
			error.winner,
			request,
			error.authorizationPersisted,
		).catch(() => {})
	}
}

async function getGoogleCallbackWinnerIdentityWithStore(
	store: Pick<GoogleGrantTransaction, "select">,
	args: { orgId: string; userId: string; targetGrantId?: string | null },
): Promise<GoogleAuthorizationIdentity | null | undefined> {
	if (args.targetGrantId) {
		const [grant] = await store
			.select()
			.from(googleWorkspaceGrant)
			.where(eq(googleWorkspaceGrant.id, args.targetGrantId))
			.limit(1)
		if (grant?.userId !== args.userId) return
		return { googleSub: grant.googleSub, oauthClientId: grant.oauthClientId }
	}
	const [winner] = await store
		.select({
			googleSub: googleWorkspaceGrant.googleSub,
			oauthClientId: googleWorkspaceGrant.oauthClientId,
		})
		.from(mcpConnection)
		.innerJoin(
			googleWorkspaceGrant,
			eq(mcpConnection.googleWorkspaceGrantId, googleWorkspaceGrant.id),
		)
		.where(
			and(
				eq(mcpConnection.orgId, args.orgId),
				eq(mcpConnection.userId, args.userId),
				eq(mcpConnection.serverSlug, "gmail"),
			),
		)
		.limit(1)
	return winner ?? null
}

async function googleAuthorizationIsPersistedWithStore(
	store: Pick<GoogleGrantTransaction, "select">,
	args: GoogleAuthorizationIdentity,
): Promise<boolean> {
	const [grant] = await store
		.select({ id: googleWorkspaceGrant.id })
		.from(googleWorkspaceGrant)
		.where(
			and(
				eq(googleWorkspaceGrant.googleSub, args.googleSub),
				eq(googleWorkspaceGrant.oauthClientId, args.oauthClientId),
			),
		)
		.limit(1)
	return Boolean(grant)
}

export async function getGoogleWorkspaceGrant(
	env: Env,
	grantId: string,
): Promise<GoogleWorkspaceGrant | undefined> {
	const [grant] = await db(env)
		.select()
		.from(googleWorkspaceGrant)
		.where(eq(googleWorkspaceGrant.id, grantId))
		.limit(1)
	return grant
}

type SaveGoogleWorkspaceGrantArgs = {
	env: Env
	orgId: string
	userId: string
	oauthClientId: string
	identity: GoogleIdentity
	tokens: GoogleTokenResponse
	targetGrantId?: string | null
}

async function saveGoogleWorkspaceGrantWithTransaction(
	tx: GoogleGrantTransaction,
	args: SaveGoogleWorkspaceGrantArgs,
): Promise<GoogleWorkspaceGrant> {
	const scopes = args.tokens.scope.split(/\s+/).filter(Boolean)
	const accessTokenEnc = await encryptToken(
		args.tokens.access_token,
		args.env.ENCRYPTION_SECRET,
	)
	const refreshTokenEnc = args.tokens.refresh_token
		? await encryptToken(args.tokens.refresh_token, args.env.ENCRYPTION_SECRET)
		: undefined
	const { status, lastError } = googleGrantStatus(scopes)
	const expiresAt = args.tokens.expires_in
		? new Date(Date.now() + args.tokens.expires_in * 1000)
		: null

	const binding = {
		runtime: "embedded" as const,
		serverUrl: null,
		authType: "oauth" as const,
		status: status === "active" ? ("active" as const) : ("error" as const),
		accessToken: null,
		refreshToken: null,
		expiresAt: null,
		scopes: null,
		metadata: lastError ? { lastError } : null,
		updatedAt: new Date(),
	}

	if (args.targetGrantId) {
		const [target] = await tx
			.select()
			.from(googleWorkspaceGrant)
			.where(eq(googleWorkspaceGrant.id, args.targetGrantId))
			.limit(1)
		assertGoogleReconnectIdentity(target, {
			userId: args.userId,
			oauthClientId: args.oauthClientId,
			googleSub: args.identity.sub,
		})
		const [updatedBinding] = await tx
			.update(mcpConnection)
			.set({ ...binding, googleWorkspaceGrantId: target.id })
			.where(
				and(
					eq(mcpConnection.orgId, args.orgId),
					eq(mcpConnection.userId, args.userId),
					eq(mcpConnection.serverSlug, "gmail"),
					eq(mcpConnection.googleWorkspaceGrantId, target.id),
				),
			)
			.returning({ id: mcpConnection.id })
		if (!updatedBinding) {
			throw new GoogleIdentityMismatchError(
				"Gmail binding changed during reconnect",
			)
		}
		const [grant] = await tx
			.update(googleWorkspaceGrant)
			.set({
				email: args.identity.email,
				accessTokenEnc,
				refreshTokenEnc: refreshTokenEnc ?? target.refreshTokenEnc,
				expiresAt,
				scopes,
				status,
				lastError,
				refreshVersion: target.refreshVersion + 1,
				refreshClaimToken: null,
				refreshClaimExpiresAt: null,
				updatedAt: new Date(),
			})
			.where(eq(googleWorkspaceGrant.id, target.id))
			.returning()
		if (!grant) throw new Error("Failed to save Google Workspace grant")
		return grant
	}

	const [grant] = await tx
		.insert(googleWorkspaceGrant)
		.values({
			userId: args.userId,
			googleSub: args.identity.sub,
			email: args.identity.email,
			oauthClientId: args.oauthClientId,
			accessTokenEnc,
			refreshTokenEnc,
			expiresAt,
			scopes,
			status,
			lastError,
		})
		.onConflictDoUpdate({
			target: [
				googleWorkspaceGrant.userId,
				googleWorkspaceGrant.googleSub,
				googleWorkspaceGrant.oauthClientId,
			],
			set: {
				email: args.identity.email,
				accessTokenEnc,
				...(refreshTokenEnc ? { refreshTokenEnc } : {}),
				expiresAt,
				scopes,
				status,
				lastError,
				refreshVersion: sql`${googleWorkspaceGrant.refreshVersion} + 1`,
				refreshClaimToken: null,
				refreshClaimExpiresAt: null,
				updatedAt: new Date(),
			},
		})
		.returning()
	if (!grant) throw new Error("Failed to save Google Workspace grant")
	const [createdBinding] = await tx
		.insert(mcpConnection)
		.values({
			orgId: args.orgId,
			userId: args.userId,
			serverSlug: "gmail",
			googleWorkspaceGrantId: grant.id,
			...binding,
		})
		.onConflictDoNothing()
		.returning({ id: mcpConnection.id })
	if (!createdBinding) {
		const [winner] = await tx
			.select({
				googleSub: googleWorkspaceGrant.googleSub,
				oauthClientId: googleWorkspaceGrant.oauthClientId,
			})
			.from(mcpConnection)
			.innerJoin(
				googleWorkspaceGrant,
				eq(mcpConnection.googleWorkspaceGrantId, googleWorkspaceGrant.id),
			)
			.where(
				and(
					eq(mcpConnection.orgId, args.orgId),
					eq(mcpConnection.userId, args.userId),
					eq(mcpConnection.serverSlug, "gmail"),
				),
			)
			.limit(1)
		throw new GoogleBindingAlreadyExistsError(
			{
				googleSub: args.identity.sub,
				oauthClientId: args.oauthClientId,
				accessToken: args.tokens.access_token,
				refreshToken: args.tokens.refresh_token,
			},
			winner,
		)
	}
	// Embedded Google grants bypass saveConnectionTokens, so the rung is emitted
	// here. Reaching this line means the binding is new, not a token refresh.
	if (status === "active") {
		captureActivationRung({
			orgId: args.orgId,
			userId: args.userId,
			rung: "tool_personal",
			source: "oauth",
			detail: { server_slug: "gmail" },
		})
	}
	return grant
}

export async function finalizeGoogleWorkspaceCallback(
	args: SaveGoogleWorkspaceGrantArgs & {
		requestedScopes: readonly string[] | null | undefined
		request?: typeof fetch
	},
): Promise<GoogleWorkspaceGrant> {
	try {
		return await withTransaction(db(args.env), async (tx) => {
			const winner = await getGoogleCallbackWinnerIdentityWithStore(tx, {
				orgId: args.orgId,
				userId: args.userId,
				targetGrantId: args.targetGrantId,
			})
			const authorization: LosingGoogleAuthorization = {
				googleSub: args.identity.sub,
				oauthClientId: args.oauthClientId,
				accessToken: args.tokens.access_token,
				refreshToken: args.tokens.refresh_token,
			}
			const authorizationPersisted =
				await googleAuthorizationIsPersistedWithStore(tx, {
					googleSub: authorization.googleSub,
					oauthClientId: authorization.oauthClientId,
				})

			await checkGoogleCallbackAuthorization({
				authorization,
				winner,
				targetGrantId: args.targetGrantId,
				requestedScopes: args.requestedScopes,
				grantedScope: args.tokens.scope,
				authorizationPersisted,
			})

			try {
				return await saveGoogleWorkspaceGrantWithTransaction(tx, args)
			} catch (error) {
				if (error instanceof GoogleIdentityMismatchError) {
					error.authorization = authorization
					error.winner = winner
					error.authorizationPersisted = authorizationPersisted
				} else if (error instanceof GoogleBindingAlreadyExistsError) {
					error.authorizationPersisted = authorizationPersisted
				}
				throw error
			}
		})
	} catch (error) {
		await cleanupGoogleCallbackError(error, args.request)
		throw error
	}
}

export async function markGoogleGrantError(
	env: Env,
	grantId: string,
	error: string,
): Promise<void> {
	await db(env)
		.update(googleWorkspaceGrant)
		.set({ status: "error", lastError: error, updatedAt: new Date() })
		.where(eq(googleWorkspaceGrant.id, grantId))
	await db(env)
		.update(mcpConnection)
		.set({
			status: "error",
			metadata: { lastError: error },
			updatedAt: new Date(),
		})
		.where(eq(mcpConnection.googleWorkspaceGrantId, grantId))
}

export async function markGoogleBindingError(
	env: Env,
	grantId: string,
	error: string,
): Promise<void> {
	await db(env)
		.update(mcpConnection)
		.set({
			status: "error",
			metadata: { lastError: error },
			updatedAt: new Date(),
		})
		.where(eq(mcpConnection.googleWorkspaceGrantId, grantId))
}

type RefreshResponse = Pick<GoogleTokenResponse, "access_token"> &
	Partial<Pick<GoogleTokenResponse, "refresh_token" | "expires_in" | "scope">>

const REFRESH_SKEW_MS = 60_000
const CLAIM_TTL_MS = 30_000
const GOOGLE_AUTH_REVOKED = "Google authorization revoked"

function ownedGoogleRefreshClaim(
	grantId: string,
	refreshVersion: number,
	claimToken: string,
) {
	return and(
		eq(googleWorkspaceGrant.id, grantId),
		eq(googleWorkspaceGrant.refreshVersion, refreshVersion),
		eq(googleWorkspaceGrant.refreshClaimToken, claimToken),
	)
}

async function releaseGoogleRefreshClaim(
	env: Env,
	grantId: string,
	refreshVersion: number,
	claimToken: string,
): Promise<void> {
	await db(env)
		.update(googleWorkspaceGrant)
		.set({
			refreshClaimToken: null,
			refreshClaimExpiresAt: null,
			updatedAt: new Date(),
		})
		.where(ownedGoogleRefreshClaim(grantId, refreshVersion, claimToken))
}

async function markGoogleGrantRevokedIfClaimOwned(
	env: Env,
	grantId: string,
	refreshVersion: number,
	claimToken: string,
): Promise<boolean> {
	return withTransaction(db(env), async (tx) => {
		await tx
			.select({ id: mcpConnection.id })
			.from(mcpConnection)
			.where(eq(mcpConnection.googleWorkspaceGrantId, grantId))
			.orderBy(asc(mcpConnection.id))

		const [updated] = await tx
			.update(googleWorkspaceGrant)
			.set({
				status: "error",
				lastError: GOOGLE_AUTH_REVOKED,
				refreshClaimToken: null,
				refreshClaimExpiresAt: null,
				updatedAt: new Date(),
			})
			.where(ownedGoogleRefreshClaim(grantId, refreshVersion, claimToken))
			.returning({ id: googleWorkspaceGrant.id })
		if (!updated) return false

		await tx
			.update(mcpConnection)
			.set({
				status: "error",
				metadata: { lastError: GOOGLE_AUTH_REVOKED },
				updatedAt: new Date(),
			})
			.where(eq(mcpConnection.googleWorkspaceGrantId, grantId))
		return true
	})
}

export async function getFreshGoogleAccessToken(
	env: Env,
	grantId: string,
	request: typeof fetch = fetch,
): Promise<string> {
	let grant = await getGoogleWorkspaceGrant(env, grantId)
	if (!grant || grant.status !== "active") {
		throw new GoogleGrantReconnectRequiredError(
			"Google grant requires reconnect",
		)
	}
	if (!hasRequiredGmailScopes(grant.scopes)) {
		await markGoogleBindingError(env, grant.id, "missing required Gmail scopes")
		throw new GoogleGrantReconnectRequiredError(
			"Google grant requires Gmail scopes",
		)
	}
	if (
		!grant.expiresAt ||
		grant.expiresAt.getTime() > Date.now() + REFRESH_SKEW_MS
	) {
		return decryptToken(grant.accessTokenEnc, env.ENCRYPTION_SECRET)
	}
	if (!grant.refreshTokenEnc) {
		await markGoogleGrantError(env, grant.id, "missing refresh token")
		throw new GoogleGrantReconnectRequiredError(
			"Google grant requires reconnect",
		)
	}

	const refreshVersion = grant.refreshVersion
	const claimToken = generateId()
	const now = new Date()
	const [claimed] = await db(env)
		.update(googleWorkspaceGrant)
		.set({
			refreshClaimToken: claimToken,
			refreshClaimExpiresAt: new Date(now.getTime() + CLAIM_TTL_MS),
		})
		.where(
			and(
				eq(googleWorkspaceGrant.id, grant.id),
				eq(googleWorkspaceGrant.refreshVersion, refreshVersion),
				or(
					isNull(googleWorkspaceGrant.refreshClaimToken),
					lt(googleWorkspaceGrant.refreshClaimExpiresAt, now),
				),
			),
		)
		.returning({ id: googleWorkspaceGrant.id })
	if (!claimed) {
		for (let attempt = 0; attempt < 6; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
			grant = await getGoogleWorkspaceGrant(env, grantId)
			if (!grant || grant.status !== "active") break
			if (
				grant.refreshVersion > refreshVersion &&
				grant.expiresAt &&
				grant.expiresAt > now
			) {
				return decryptToken(grant.accessTokenEnc, env.ENCRYPTION_SECRET)
			}
		}
		return getFreshGoogleAccessToken(env, grantId, request)
	}

	try {
		const refreshToken = await decryptToken(
			grant.refreshTokenEnc,
			env.ENCRYPTION_SECRET,
		)
		const response = await request("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: env.GOOGLE_WORKSPACE_CLIENT_ID ?? "",
				client_secret: env.GOOGLE_WORKSPACE_CLIENT_SECRET ?? "",
				grant_type: "refresh_token",
				refresh_token: refreshToken,
			}),
		})
		const body = (await response
			.json()
			.catch(() => ({}))) as RefreshResponse & {
			error?: string
		}
		if (!response.ok || !body.access_token) {
			if (body.error === "invalid_grant") {
				const revoked = await markGoogleGrantRevokedIfClaimOwned(
					env,
					grant.id,
					refreshVersion,
					claimToken,
				)
				if (!revoked) return getFreshGoogleAccessToken(env, grantId, request)
				throw new GoogleGrantReconnectRequiredError(
					"Google grant requires reconnect",
				)
			}
			throw new Error(
				body.error ?? `Google token refresh failed (${response.status})`,
			)
		}
		const accessTokenEnc = await encryptToken(
			body.access_token,
			env.ENCRYPTION_SECRET,
		)
		const refreshTokenEnc = body.refresh_token
			? await encryptToken(body.refresh_token, env.ENCRYPTION_SECRET)
			: grant.refreshTokenEnc
		const refreshedScopes = body.scope ? body.scope.split(/\s+/) : grant.scopes
		const [saved] = await db(env)
			.update(googleWorkspaceGrant)
			.set({
				accessTokenEnc,
				refreshTokenEnc,
				expiresAt: body.expires_in
					? new Date(Date.now() + body.expires_in * 1000)
					: grant.expiresAt,
				scopes: refreshedScopes,
				refreshVersion: refreshVersion + 1,
				refreshClaimToken: null,
				refreshClaimExpiresAt: null,
				updatedAt: new Date(),
			})
			.where(ownedGoogleRefreshClaim(grant.id, refreshVersion, claimToken))
			.returning({ accessTokenEnc: googleWorkspaceGrant.accessTokenEnc })
		if (!saved) return getFreshGoogleAccessToken(env, grantId, request)
		if (!hasRequiredGmailScopes(refreshedScopes)) {
			await markGoogleBindingError(
				env,
				grant.id,
				"missing required Gmail scopes",
			)
			throw new GoogleGrantReconnectRequiredError(
				"Google grant requires Gmail scopes",
			)
		}
		return body.access_token
	} catch (error) {
		await releaseGoogleRefreshClaim(
			env,
			grant.id,
			refreshVersion,
			claimToken,
		).catch(() => {})
		throw error
	}
}

type DeletedGoogleGrantToken = {
	id: string
	googleSub: string
	oauthClientId: string
	accessTokenEnc: string
	refreshTokenEnc: string | null
}

export function googleGrantCanBeRevoked(remainingBindings: number): boolean {
	return remainingBindings === 0
}

export async function revokeGoogleGrantIdsBestEffort(
	grantIds: readonly string[],
	revoke: (grantId: string) => Promise<void>,
	log: (message: string) => void = console.warn,
): Promise<void> {
	for (const grantId of grantIds) {
		try {
			await revoke(grantId)
		} catch {
			log(`Failed to revoke Google Workspace grant ${grantId}`)
		}
	}
}

async function revokeGoogleWorkspaceGrantsWhere(
	env: Env,
	condition: SQL,
	request: typeof fetch,
): Promise<void> {
	const deleted = await withTransaction(db(env), async (tx) => {
		const bindings = await tx
			.select({ grantId: mcpConnection.googleWorkspaceGrantId })
			.from(mcpConnection)
			.where(and(condition, isNotNull(mcpConnection.googleWorkspaceGrantId)))
		const grantIds = [
			...new Set(
				bindings
					.map((binding) => binding.grantId)
					.filter((grantId): grantId is string => Boolean(grantId)),
			),
		]

		await tx
			.delete(mcpConnection)
			.where(and(condition, isNotNull(mcpConnection.googleWorkspaceGrantId)))

		const orphaned: DeletedGoogleGrantToken[] = []
		for (const grantId of grantIds) {
			const remaining = await tx
				.select({ id: mcpConnection.id })
				.from(mcpConnection)
				.where(eq(mcpConnection.googleWorkspaceGrantId, grantId))
				.limit(1)
			if (!googleGrantCanBeRevoked(remaining.length)) continue
			const [grant] = await tx
				.delete(googleWorkspaceGrant)
				.where(eq(googleWorkspaceGrant.id, grantId))
				.returning({
					id: googleWorkspaceGrant.id,
					googleSub: googleWorkspaceGrant.googleSub,
					oauthClientId: googleWorkspaceGrant.oauthClientId,
					accessTokenEnc: googleWorkspaceGrant.accessTokenEnc,
					refreshTokenEnc: googleWorkspaceGrant.refreshTokenEnc,
				})
			if (!grant) continue
			const [siblingGrant] = await tx
				.select({ id: googleWorkspaceGrant.id })
				.from(googleWorkspaceGrant)
				.where(
					and(
						eq(googleWorkspaceGrant.googleSub, grant.googleSub),
						eq(googleWorkspaceGrant.oauthClientId, grant.oauthClientId),
					),
				)
				.limit(1)
			if (!siblingGrant) orphaned.push(grant)
		}
		return orphaned
	})

	await revokeDeletedGoogleGrantsBestEffort(env, deleted, request)
}

async function revokeDeletedGoogleGrantsBestEffort(
	env: Env,
	grants: readonly DeletedGoogleGrantToken[],
	request: typeof fetch,
): Promise<void> {
	await revokeGoogleGrantIdsBestEffort(
		grants.map((grant) => grant.id),
		async (grantId) => {
			const grant = grants.find((candidate) => candidate.id === grantId)
			if (!grant) return
			const token = await decryptToken(
				grant.refreshTokenEnc ?? grant.accessTokenEnc,
				env.ENCRYPTION_SECRET,
			)
			await revokeGoogleAuthorizationToken(token, request)
		},
	)
}

export async function disconnectGoogleWorkspaceBinding(
	env: Env,
	connectionId: string,
	request: typeof fetch = fetch,
): Promise<void> {
	await revokeGoogleWorkspaceGrantsWhere(
		env,
		eq(mcpConnection.id, connectionId),
		request,
	)
}

async function revokeAllGoogleWorkspaceGrantsForUser(
	env: Env,
	userId: string,
	request: typeof fetch,
): Promise<void> {
	const deleted = await withTransaction(db(env), async (tx) => {
		await tx
			.delete(mcpConnection)
			.where(
				and(
					eq(mcpConnection.userId, userId),
					isNotNull(mcpConnection.googleWorkspaceGrantId),
				),
			)
		const removed = await tx
			.delete(googleWorkspaceGrant)
			.where(eq(googleWorkspaceGrant.userId, userId))
			.returning({
				id: googleWorkspaceGrant.id,
				googleSub: googleWorkspaceGrant.googleSub,
				oauthClientId: googleWorkspaceGrant.oauthClientId,
				accessTokenEnc: googleWorkspaceGrant.accessTokenEnc,
				refreshTokenEnc: googleWorkspaceGrant.refreshTokenEnc,
			})
		const revocable: DeletedGoogleGrantToken[] = []
		const checked = new Set<string>()
		for (const grant of removed) {
			const identity = `${grant.oauthClientId}:${grant.googleSub}`
			if (checked.has(identity)) continue
			checked.add(identity)
			const [siblingGrant] = await tx
				.select({ id: googleWorkspaceGrant.id })
				.from(googleWorkspaceGrant)
				.where(
					and(
						eq(googleWorkspaceGrant.googleSub, grant.googleSub),
						eq(googleWorkspaceGrant.oauthClientId, grant.oauthClientId),
					),
				)
				.limit(1)
			if (!siblingGrant) revocable.push(grant)
		}
		return revocable
	})
	await revokeDeletedGoogleGrantsBestEffort(env, deleted, request)
}

export async function revokeGoogleWorkspaceGrantsForOrg(
	env: Env,
	orgId: string,
	request: typeof fetch = fetch,
): Promise<void> {
	try {
		await revokeGoogleWorkspaceGrantsWhere(
			env,
			eq(mcpConnection.orgId, orgId),
			request,
		)
	} catch {
		console.warn("Failed to disconnect Google Workspace bindings for org")
	}
}

export async function revokeGoogleWorkspaceGrantsForUser(
	env: Env,
	userId: string,
	request: typeof fetch = fetch,
): Promise<void> {
	try {
		await revokeAllGoogleWorkspaceGrantsForUser(env, userId, request)
	} catch {
		console.warn("Failed to revoke Google Workspace grants for user")
	}
}
