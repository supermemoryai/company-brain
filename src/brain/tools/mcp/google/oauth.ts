import { and, db, eq, gt } from "@repo/db"
import { mcpOAuthState } from "@repo/db/schema/brain/mcp"
import { encryptToken } from "@/lib/crypto"
import { GMAIL_METADATA_SCOPE, mergeGmailScopes } from "./scopes"

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"

export type GoogleTokenResponse = {
	access_token: string
	refresh_token?: string
	expires_in?: number
	scope: string
	token_type?: string
}

export type GoogleIdentity = { sub: string; email: string }

export class GoogleCallbackScopeError extends Error {}

function base64Url(bytes: Uint8Array): string {
	let binary = ""
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export async function createPkce(): Promise<{
	verifier: string
	challenge: string
}> {
	const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)))
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	)
	return { verifier, challenge: base64Url(new Uint8Array(digest)) }
}

function googleCredentials(env: Env): {
	clientId: string
	clientSecret: string
} {
	const clientId = env.GOOGLE_WORKSPACE_CLIENT_ID
	const clientSecret = env.GOOGLE_WORKSPACE_CLIENT_SECRET
	if (!clientId || !clientSecret) {
		throw new Error("Company Brain Google Workspace OAuth is not configured")
	}
	return { clientId, clientSecret }
}

export function googleWorkspaceClientId(env: Env): string {
	return googleCredentials(env).clientId
}

export function buildGoogleAuthorizationUrl(args: {
	env: Env
	state: string
	redirectUri: string
	challenge: string
	scopes?: string[]
	loginHint?: string
}): string {
	const { clientId } = googleCredentials(args.env)
	const url = new URL(AUTHORIZE_URL)
	url.searchParams.set("client_id", clientId)
	url.searchParams.set("redirect_uri", args.redirectUri)
	url.searchParams.set("response_type", "code")
	url.searchParams.set("scope", mergeGmailScopes(args.scopes).join(" "))
	url.searchParams.set("state", args.state)
	url.searchParams.set("access_type", "offline")
	url.searchParams.set("prompt", "consent")
	url.searchParams.set("code_challenge", args.challenge)
	url.searchParams.set("code_challenge_method", "S256")
	if (args.loginHint) url.searchParams.set("login_hint", args.loginHint)
	return url.toString()
}

async function parseGoogleResponse<T>(response: Response): Promise<T> {
	const body = (await response.json().catch(() => ({}))) as Record<
		string,
		unknown
	>
	if (!response.ok) {
		throw new Error(
			typeof body.error === "string"
				? body.error
				: `Google OAuth failed (${response.status})`,
		)
	}
	return body as T
}

export async function exchangeGoogleCode(args: {
	env: Env
	code: string
	redirectUri: string
	verifier: string
	fetch?: typeof fetch
}): Promise<GoogleTokenResponse> {
	const { clientId, clientSecret } = googleCredentials(args.env)
	const request = args.fetch ?? fetch
	const response = await request(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			code: args.code,
			code_verifier: args.verifier,
			grant_type: "authorization_code",
			redirect_uri: args.redirectUri,
		}),
	})
	return parseGoogleResponse<GoogleTokenResponse>(response)
}

export async function fetchGoogleIdentity(
	accessToken: string,
	request: typeof fetch = fetch,
): Promise<GoogleIdentity> {
	const identity = await parseGoogleResponse<GoogleIdentity>(
		await request(USERINFO_URL, {
			headers: { authorization: `Bearer ${accessToken}` },
		}),
	)
	if (!identity.sub || !identity.email)
		throw new Error("Google identity is incomplete")
	return identity
}

export async function consumeGoogleOAuthState(env: Env, stateToken: string) {
	const [state] = await db(env)
		.delete(mcpOAuthState)
		.where(
			and(
				eq(mcpOAuthState.stateToken, stateToken),
				eq(mcpOAuthState.runtime, "embedded"),
				gt(mcpOAuthState.expiresAt, new Date()),
			),
		)
		.returning()
	return state
}

export async function encryptPkceVerifier(env: Env, verifier: string) {
	return encryptToken(verifier, env.ENCRYPTION_SECRET)
}

export async function googleOAuthStateSecurityFields(
	env: Env,
	requestedScopes: string[],
	verifier: string,
): Promise<{ requestedScopes: string[]; pkceVerifierEnc: string }> {
	return {
		requestedScopes: [...requestedScopes],
		pkceVerifierEnc: await encryptPkceVerifier(env, verifier),
	}
}

export function validateGoogleCallbackScopes(
	requestedScopes: readonly string[] | null | undefined,
	grantedScope: string,
): void {
	if (!requestedScopes?.length) {
		throw new GoogleCallbackScopeError(
			"Google OAuth state is missing requested scopes",
		)
	}
	const granted = new Set(grantedScope.split(/\s+/).filter(Boolean))
	if (granted.has(GMAIL_METADATA_SCOPE)) {
		throw new GoogleCallbackScopeError(
			"Google granted the incompatible gmail.metadata scope",
		)
	}
	const missing = requestedScopes.filter((scope) => !granted.has(scope))
	if (missing.length) {
		throw new GoogleCallbackScopeError(
			`Google did not grant requested scopes: ${missing.join(", ")}`,
		)
	}
}
