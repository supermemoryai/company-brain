import type {
	OAuthClientInformation,
	OAuthClientInformationFull,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { and, db, eq, isNull } from "@repo/db"
import { mcpConnection, mcpOAuthState } from "@repo/db/schema/brain/mcp"
import { decryptToken, encryptToken } from "@/lib/crypto"
import { getPreregisteredClient, getRemoteCatalogEntry } from "./catalog"
import type { McpConnectionRow } from "./store"
import { saveConnectionTokens } from "./store"

// Thrown when a runtime (agent) connection needs the user to re-auth in a browser.
// The agent must never redirect mid-turn; surface "reconnect" instead.
export class McpReauthRequiredError extends Error {
	constructor(public readonly serverSlug: string) {
		super(`MCP server "${serverSlug}" requires reconnection`)
		this.name = "McpReauthRequiredError"
	}
}

function clientMetadata(
	callbackUrl: string,
	scope?: string,
): OAuthClientMetadata {
	return {
		client_name: "Supermemory Company Brain",
		redirect_uris: [callbackUrl],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		...(scope ? { scope } : {}),
	}
}

// Connect / callback flow. Backed by the transient mcp_oauth_state row keyed by
// stateToken. On saveTokens it promotes the row into a durable mcp_connection.
export class McpConnectProvider {
	private _authorizationUrl?: URL

	constructor(
		private env: Env,
		private ctx: {
			stateToken: string
			orgId: string
			userId: string | null
			serverSlug: string
			serverUrl: string
			callbackUrl: string
		},
	) {}

	get authorizationUrl(): URL | undefined {
		return this._authorizationUrl
	}

	get redirectUrl(): string {
		return this.ctx.callbackUrl
	}

	get clientMetadata(): OAuthClientMetadata {
		return clientMetadata(
			this.ctx.callbackUrl,
			getRemoteCatalogEntry(this.ctx.serverSlug)?.oauthScope,
		)
	}

	state(): string {
		return this.ctx.stateToken
	}

	private async row() {
		const [r] = await db(this.env)
			.select()
			.from(mcpOAuthState)
			.where(eq(mcpOAuthState.stateToken, this.ctx.stateToken))
			.limit(1)
		return r
	}

	async clientInformation(): Promise<OAuthClientInformation | undefined> {
		// Pre-registered app (no DCR) short-circuits registration.
		const pre = getPreregisteredClient(this.env, this.ctx.serverSlug)
		if (pre) return pre
		const r = await this.row()
		return r?.clientInfo as OAuthClientInformation | undefined
	}

	async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
		await db(this.env)
			.update(mcpOAuthState)
			.set({ clientInfo: info as unknown as Record<string, unknown> })
			.where(eq(mcpOAuthState.stateToken, this.ctx.stateToken))
	}

	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		await db(this.env)
			.update(mcpOAuthState)
			.set({ codeVerifier })
			.where(eq(mcpOAuthState.stateToken, this.ctx.stateToken))
	}

	async codeVerifier(): Promise<string> {
		const r = await this.row()
		if (!r?.codeVerifier) throw new Error("missing code verifier")
		return r.codeVerifier
	}

	async tokens(): Promise<OAuthTokens | undefined> {
		const r = await this.row()
		return r?.tokens as OAuthTokens | undefined
	}

	// Promote the completed OAuth handshake into a durable mcp_connection.
	async saveTokens(tokens: OAuthTokens): Promise<void> {
		const r = await this.row()
		const clientInfo = r?.clientInfo as OAuthClientInformationFull | undefined
		const secret = this.env.ENCRYPTION_SECRET

		// DCR path uses the registered client; pre-registered (no-DCR) servers fall back to env creds.
		const pre = getPreregisteredClient(this.env, this.ctx.serverSlug)
		const clientId = clientInfo?.client_id ?? pre?.client_id
		const rawClientSecret = clientInfo?.client_secret ?? pre?.client_secret
		const clientSecretEnc = rawClientSecret
			? await encryptToken(rawClientSecret, secret)
			: undefined

		const existing = await db(this.env)
			.select({ id: mcpConnection.id })
			.from(mcpConnection)
			.where(
				and(
					eq(mcpConnection.orgId, this.ctx.orgId),
					eq(mcpConnection.serverSlug, this.ctx.serverSlug),
					this.ctx.userId === null
						? isNull(mcpConnection.userId)
						: eq(mcpConnection.userId, this.ctx.userId),
				),
			)
			.limit(1)

		const metadata = {
			clientId,
			clientSecretEnc,
			tokenType: tokens.token_type,
		}

		if (existing[0]) {
			await saveConnectionTokens(
				this.env,
				existing[0].id,
				toSaveArgs(tokens),
				metadata,
			)
			// Reconnecting via OAuth: relabel the row so a prior static row isn't
			// left as static, refresh the URL, and drop stale static metadata.
			await db(this.env)
				.update(mcpConnection)
				.set({
					authType: "oauth",
					serverUrl: this.ctx.serverUrl,
					metadata,
				})
				.where(eq(mcpConnection.id, existing[0].id))
		} else {
			const [created] = await db(this.env)
				.insert(mcpConnection)
				.values({
					orgId: this.ctx.orgId,
					userId: this.ctx.userId,
					serverSlug: this.ctx.serverSlug,
					serverUrl: this.ctx.serverUrl,
					authType: "oauth",
					status: "pending",
					metadata,
				})
				.returning({ id: mcpConnection.id })
			if (created) {
				await saveConnectionTokens(
					this.env,
					created.id,
					toSaveArgs(tokens),
					metadata,
				)
			}
		}
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		this._authorizationUrl = authorizationUrl
	}
}

// Agent-runtime flow. Backed by a durable mcp_connection row. Auto-refresh writes
// back through saveTokens; it must never redirect a browser mid-turn.
export class McpRuntimeProvider {
	constructor(
		private env: Env,
		private connection: McpConnectionRow,
		private callbackUrl: string,
	) {}

	get redirectUrl(): string {
		return this.callbackUrl
	}

	get clientMetadata(): OAuthClientMetadata {
		return clientMetadata(
			this.callbackUrl,
			getRemoteCatalogEntry(this.connection.serverSlug)?.oauthScope,
		)
	}

	async clientInformation(): Promise<OAuthClientInformation | undefined> {
		const meta = this.connection.metadata
		if (!meta?.clientId)
			return getPreregisteredClient(this.env, this.connection.serverSlug)
		const client_secret = meta.clientSecretEnc
			? await decryptToken(meta.clientSecretEnc, this.env.ENCRYPTION_SECRET)
			: undefined
		return { client_id: meta.clientId, client_secret }
	}

	async tokens(): Promise<OAuthTokens | undefined> {
		if (!this.connection.accessToken) return undefined
		const secret = this.env.ENCRYPTION_SECRET
		const access_token = await decryptToken(this.connection.accessToken, secret)
		const refresh_token = this.connection.refreshToken
			? await decryptToken(this.connection.refreshToken, secret)
			: undefined
		const expiresInSec = this.connection.expiresAt
			? Math.max(
					0,
					Math.floor((this.connection.expiresAt.getTime() - Date.now()) / 1000),
				)
			: undefined
		return {
			access_token,
			refresh_token,
			token_type: this.connection.metadata?.tokenType ?? "Bearer",
			expires_in: expiresInSec,
			scope: this.connection.scopes?.join(" "),
		}
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		await saveConnectionTokens(this.env, this.connection.id, toSaveArgs(tokens))
		// Mirror the rotated tokens in-memory so a refresh+retry can't reuse the old one.
		const secret = this.env.ENCRYPTION_SECRET
		this.connection = {
			...this.connection,
			accessToken: await encryptToken(tokens.access_token, secret),
			refreshToken: tokens.refresh_token
				? await encryptToken(tokens.refresh_token, secret)
				: this.connection.refreshToken,
			expiresAt: tokens.expires_in
				? new Date(Date.now() + tokens.expires_in * 1000)
				: this.connection.expiresAt,
			scopes: tokens.scope ? tokens.scope.split(" ") : this.connection.scopes,
		}
	}

	// not used at runtime (no DCR re-registration); refresh reuses stored client
	saveClientInformation(): void {}
	saveCodeVerifier(): void {}
	codeVerifier(): string {
		throw new Error("no code verifier at runtime")
	}

	redirectToAuthorization(): void {
		throw new McpReauthRequiredError(this.connection.serverSlug)
	}
}

function toSaveArgs(tokens: OAuthTokens) {
	return {
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresInSec: tokens.expires_in,
		scope: tokens.scope,
		tokenType: tokens.token_type,
	}
}
