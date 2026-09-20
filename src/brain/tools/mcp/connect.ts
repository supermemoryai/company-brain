import { auth } from "@modelcontextprotocol/sdk/client/auth.js"
import { db } from "@repo/db"
import type { McpOAuthStateContext } from "@repo/db/schema/brain/mcp"
import { mcpOAuthState } from "@repo/db/schema/brain/mcp"
import { connectorPause } from "@repo/lib/connector-availability"
import { generateId } from "@repo/lib/generate-id"
import { getConfig } from "@/config"
import {
	getCatalogEntry,
	getPreregisteredClient,
	getRemoteCatalogEntry,
} from "./catalog"
import { createCustomMcpFetch } from "./custom-url"
import { getDirectoryEntryBySlug } from "./directory"
import { withMcpFetchTimeout } from "./fetch"
import { getGoogleWorkspaceGrant } from "./google/grant-store"
import {
	buildGoogleAuthorizationUrl,
	createPkce,
	googleOAuthStateSecurityFields,
} from "./google/oauth"
import { mergeGmailScopes } from "./google/scopes"
import { McpConnectProvider } from "./oauth-provider"
import { getConnection } from "./store"

const STATE_TTL_MS = 10 * 60 * 1000

export type McpSlackConnectContext = NonNullable<McpOAuthStateContext["slack"]>

export type StartMcpConnectArgs = {
	env: Env
	orgId: string
	userId: string
	slug: string
	callbackOrigin: string
	shared?: boolean
	serverUrl?: string
	redirectUrl?: string
	slackContext?: McpSlackConnectContext
}

export type StartMcpConnectResult =
	| { ok: true; authUrl: string; stateToken: string }
	| { ok: true; alreadyAuthorized: true }
	| { ok: false; error: string; status?: number }

function mcpCallbackUrl(callbackOrigin: string): string {
	return `${callbackOrigin.replace(/\/$/, "")}/brain/mcp-connections/callback`
}

// Public API origin for browser/OAuth redirects; prefer PUBLIC_URL behind tunnels.
export function publicApiOrigin(env: Env, reqUrl: string): string {
	if (env.PUBLIC_URL) {
		try {
			return new URL(env.PUBLIC_URL).origin
		} catch {}
	}
	return new URL(reqUrl).origin
}

export async function startMcpConnect(
	args: StartMcpConnectArgs,
): Promise<StartMcpConnectResult> {
	const slug = args.slug.toLowerCase()
	const entry = getCatalogEntry(slug)
	if (entry?.runtime === "embedded") {
		if (slug !== "gmail") {
			return { ok: false, error: "unsupported embedded provider", status: 400 }
		}
		const pause = connectorPause(slug)
		if (pause) return { ok: false, error: pause.message, status: 503 }
		if (args.shared || args.serverUrl) {
			return {
				ok: false,
				error: "Gmail connections are personal and do not use a server URL",
				status: 400,
			}
		}
		return startGoogleWorkspaceConnect(args)
	}
	const remoteEntry = getRemoteCatalogEntry(slug)
	const directoryEntry = remoteEntry ? undefined : getDirectoryEntryBySlug(slug)
	// A recognized directory slug pins its own URL: a caller-supplied one must
	// never repoint a trusted name at an attacker endpoint.
	const serverUrl =
		directoryEntry?.url ?? args.serverUrl ?? remoteEntry?.serverUrl ?? undefined
	if (!serverUrl) {
		return {
			ok: false,
			error: "serverUrl required (not in catalog)",
			status: 400,
		}
	}

	if (
		remoteEntry?.preregisteredClientEnv &&
		args.serverUrl &&
		args.serverUrl !== remoteEntry.serverUrl
	) {
		return {
			ok: false,
			error: `${remoteEntry.name} must use its configured MCP server URL`,
			status: 400,
		}
	}

	// No-DCR servers (GitHub) need pre-registered creds; without them auth() falls into DCR and throws.
	if (
		remoteEntry?.preregisteredClientEnv &&
		!getPreregisteredClient(args.env, slug)
	) {
		return {
			ok: false,
			error: `${remoteEntry.name} is not configured on this deployment`,
			status: 501,
		}
	}

	const userId = args.shared ? null : args.userId
	const stateToken = generateId()
	const callbackUrl = mcpCallbackUrl(args.callbackOrigin)

	await db(args.env)
		.insert(mcpOAuthState)
		.values({
			stateToken,
			orgId: args.orgId,
			userId,
			serverSlug: slug,
			serverUrl,
			redirectUrl: args.redirectUrl,
			context: args.slackContext ? { slack: args.slackContext } : undefined,
			expiresAt: new Date(Date.now() + STATE_TTL_MS),
		})

	const provider = new McpConnectProvider(args.env, {
		stateToken,
		orgId: args.orgId,
		userId,
		serverSlug: slug,
		serverUrl,
		callbackUrl,
	})

	const authResult = await auth(provider, {
		serverUrl,
		scope: remoteEntry?.oauthScope,
		fetchFn: entry
			? withMcpFetchTimeout()
			: withMcpFetchTimeout(createCustomMcpFetch(args.env)),
	}).then(
		(result) => ({ ok: true as const, result }),
		(err) => ({
			ok: false as const,
			error: `authorization failed: ${err instanceof Error ? err.message : String(err)}`,
		}),
	)
	if (!authResult.ok) {
		return {
			ok: false,
			error: authResult.error,
			status: 502,
		}
	}
	const { result } = authResult
	if (result === "REDIRECT" && provider.authorizationUrl) {
		return {
			ok: true,
			authUrl: provider.authorizationUrl.toString(),
			stateToken,
		}
	}
	if (result === "AUTHORIZED") return { ok: true, alreadyAuthorized: true }
	return { ok: false, error: "could not start authorization", status: 502 }
}

async function startGoogleWorkspaceConnect(
	args: StartMcpConnectArgs,
): Promise<StartMcpConnectResult> {
	const existing = await getConnection(
		args.env,
		args.orgId,
		"gmail",
		args.userId,
	)
	const target = existing?.googleWorkspaceGrantId
		? await getGoogleWorkspaceGrant(args.env, existing.googleWorkspaceGrantId)
		: undefined
	const stateToken = generateId()
	const callbackUrl = mcpCallbackUrl(args.callbackOrigin)
	const pkce = await createPkce()
	const requestedScopes = mergeGmailScopes(target?.scopes ?? [])
	const securityFields = await googleOAuthStateSecurityFields(
		args.env,
		requestedScopes,
		pkce.verifier,
	)
	await db(args.env)
		.insert(mcpOAuthState)
		.values({
			stateToken,
			orgId: args.orgId,
			userId: args.userId,
			runtime: "embedded",
			serverSlug: "gmail",
			serverUrl: null,
			targetGoogleWorkspaceGrantId: target?.id,
			...securityFields,
			redirectUrl: args.redirectUrl,
			context: args.slackContext ? { slack: args.slackContext } : undefined,
			expiresAt: new Date(Date.now() + STATE_TTL_MS),
		})
	return {
		ok: true,
		stateToken,
		authUrl: buildGoogleAuthorizationUrl({
			env: args.env,
			state: stateToken,
			redirectUri: callbackUrl,
			challenge: pkce.challenge,
			scopes: requestedScopes,
			loginHint: target?.email,
		}),
	}
}

export function buildMcpCallbackUrl(env: Env, reqUrl: string): string {
	return mcpCallbackUrl(publicApiOrigin(env, reqUrl))
}

function trustedRedirectOrigins(env: Env): string[] {
	const origins = new Set<string>(getConfig().trustedOrigins)
	for (const u of [
		env.PUBLIC_URL,
		env.FRONTEND_URL,
		env.CONSUMER_APP_URL,
	]) {
		if (!u) continue
		try {
			origins.add(new URL(u).origin)
		} catch {}
	}
	return [...origins]
}

function originMatches(pattern: string, url: URL): boolean {
	const m = pattern.match(/^([a-z][\w+.-]*):\/\/(.+?)\/?$/i)
	const scheme = m?.[1]
	const hostPort = m?.[2]
	if (!scheme || !hostPort) return false
	if (`${scheme}:`.toLowerCase() !== url.protocol.toLowerCase()) return false
	if (hostPort.startsWith("*.")) return url.host.endsWith(hostPort.slice(1))
	return hostPort.toLowerCase() === url.host.toLowerCase()
}

// Open-redirect guard: only honor relative paths or trusted origins.
export function sanitizeRedirectUrl(
	redirectUrl: string | null | undefined,
	env: Env,
): string | undefined {
	if (!redirectUrl) return undefined
	if (redirectUrl.startsWith("/") && !redirectUrl.startsWith("//"))
		return redirectUrl
	let url: URL
	try {
		url = new URL(redirectUrl)
	} catch {
		return undefined
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
	return trustedRedirectOrigins(env).some((o) => originMatches(o, url))
		? url.toString()
		: undefined
}
