import { generateId } from "@repo/lib/generate-id"
import { relations, sql } from "drizzle-orm"
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core"
import { organization, user } from "../auth"

export const MCP_TRANSPORTS = ["http", "sse"] as const
export const MCP_AUTH_TYPES = [
	"oauth", // we broker OAuth 2.1 (discovery + DCR + refresh)
	"static", // bring-your-own bearer/header secret
	"none", // public server, no auth
] as const
export const MCP_CONNECTION_STATUSES = [
	"active",
	"pending", // oauth started, callback not completed
	"error", // auth/refresh failed; needs reconnect
] as const
export const MCP_RUNTIMES = ["remote_mcp", "embedded"] as const
export const GOOGLE_WORKSPACE_GRANT_STATUSES = [
	"active",
	"error",
	"revoked",
] as const

export type McpAuthType = (typeof MCP_AUTH_TYPES)[number]
export type McpTransport = (typeof MCP_TRANSPORTS)[number]
export type McpConnectionStatus = (typeof MCP_CONNECTION_STATUSES)[number]
export type McpRuntime = (typeof MCP_RUNTIMES)[number]

export const googleWorkspaceGrant = sqliteTable(
	"google_workspace_grant",
	{
		id: text("id").primaryKey().$defaultFn(generateId),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		googleSub: text("google_sub").notNull(),
		email: text("email").notNull(),
		oauthClientId: text("oauth_client_id").notNull(),
		accessTokenEnc: text("access_token_enc").notNull(),
		refreshTokenEnc: text("refresh_token_enc"),
		expiresAt: integer("expires_at", { mode: "timestamp" }),
		scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
		status: text("status", { enum: GOOGLE_WORKSPACE_GRANT_STATUSES })
			.notNull()
			.default("active"),
		lastError: text("last_error"),
		refreshVersion: integer("refresh_version").notNull().default(0),
		refreshClaimToken: text("refresh_claim_token"),
		refreshClaimExpiresAt: integer("refresh_claim_expires_at", {
			mode: "timestamp",
		}),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		uniqueIndex("uniq_google_workspace_grant_identity").on(
			table.userId,
			table.googleSub,
			table.oauthClientId,
		),
		index("idx_google_workspace_grant_user").on(table.userId),
	],
)

// OAuth client info (DCR result) + per-connection extras. client_secret is encrypted.
export type McpConnectionMetadata = {
	serverName?: string
	clientId?: string
	clientSecretEnc?: string
	tokenType?: string
	headerName?: string // static auth (defaults to Authorization: Bearer)
	extraHeaders?: Record<string, string> // static auth non-secret extras (e.g. Plane's x-workspace-slug)
	lastError?: string
}

// Durable per-org (or per-user) connection to a remote MCP server.
export const mcpConnection = sqliteTable(
	"mcp_connection",
	{
		id: text("id").primaryKey().$defaultFn(generateId),
		orgId: text("org_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		// null = org-shared connection; set = personal / identity-scoped
		userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
		runtime: text("runtime", { enum: MCP_RUNTIMES })
			.notNull()
			.default("remote_mcp"),
		serverSlug: text("server_slug").notNull(),
		serverUrl: text("server_url"),
		googleWorkspaceGrantId: text("google_workspace_grant_id").references(
			() => googleWorkspaceGrant.id,
			{ onDelete: "cascade" },
		),
		transport: text("transport", { enum: MCP_TRANSPORTS })
			.notNull()
			.default("http"),
		authType: text("auth_type", { enum: MCP_AUTH_TYPES }).notNull(),
		status: text("status", { enum: MCP_CONNECTION_STATUSES })
			.notNull()
			.default("pending"),
		// encrypted at rest via lib/crypto
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		expiresAt: integer("expires_at", { mode: "timestamp" }),
		scopes: text("scopes", { mode: "json" }).$type<string[]>(),
		metadata: text("metadata", { mode: "json" }).$type<McpConnectionMetadata>(),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		index("idx_mcp_connection_org_id").on(table.orgId),
		index("idx_mcp_connection_status").on(table.status),
		// personal connections: one row per (org, slug, user)
		uniqueIndex("uniq_mcp_connection_org_slug_user")
			.on(table.orgId, table.serverSlug, table.userId)
			.where(sql`${table.userId} is not null`),
		// org-shared connections (userId null): one row per (org, slug)
		uniqueIndex("uniq_mcp_connection_org_slug_shared")
			.on(table.orgId, table.serverSlug)
			.where(sql`${table.userId} is null`),
	],
)

export const mcpConnectionRelations = relations(mcpConnection, ({ one }) => ({
	org: one(organization, {
		fields: [mcpConnection.orgId],
		references: [organization.id],
	}),
	user: one(user, {
		fields: [mcpConnection.userId],
		references: [user.id],
	}),
	googleWorkspaceGrant: one(googleWorkspaceGrant, {
		fields: [mcpConnection.googleWorkspaceGrantId],
		references: [googleWorkspaceGrant.id],
	}),
}))

// Transient OAuth-flow state (CSRF token + PKCE verifier + DCR client info)
// during the connect redirect.
export type McpOAuthStateContext = {
	slack?: {
		teamId: string
		channel: string
		threadTs: string
		slackUserId: string
		// Onboarding connect card: the message to update + the full offered set.
		messageTs?: string
		buttons?: {
			slug: string
			label: string
			authUrl: string
			stateToken?: string
		}[]
		// Ephemeral Slack cards can only be replaced through the signed response URL
		// delivered when their URL button is clicked.
		responseUrl?: string
		originalQuestion?: string
	}
}

export const mcpOAuthState = sqliteTable(
	"mcp_oauth_state",
	{
		stateToken: text("state_token").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
		runtime: text("runtime", { enum: MCP_RUNTIMES })
			.notNull()
			.default("remote_mcp"),
		serverSlug: text("server_slug").notNull(),
		serverUrl: text("server_url"),
		codeVerifier: text("code_verifier"),
		pkceVerifierEnc: text("pkce_verifier_enc"),
		requestedScopes: text("requested_scopes", { mode: "json" }).$type<
			string[]
		>(),
		targetGoogleWorkspaceGrantId: text(
			"target_google_workspace_grant_id",
		).references(() => googleWorkspaceGrant.id, { onDelete: "cascade" }),
		clientInfo: text("client_info", { mode: "json" }).$type<
			Record<string, unknown>
		>(),
		tokens: text("tokens", { mode: "json" }).$type<Record<string, unknown>>(),
		redirectUrl: text("redirect_url"),
		context: text("context", { mode: "json" }).$type<McpOAuthStateContext>(),
		expiresAt: integer("expires_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [index("idx_mcp_oauth_state_expires_at").on(table.expiresAt)],
)
