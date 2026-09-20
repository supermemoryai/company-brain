import { auth } from "@modelcontextprotocol/sdk/client/auth.js"
import { and, db, eq, gt } from "@repo/db"
import { mcpOAuthState } from "@repo/db/schema/brain/mcp"
import { type BrainOrgLike, isCompanyBrainOrg } from "@repo/lib/features"
import { ROLE_ADMIN, ROLE_OWNER } from "@repo/lib/permissions"
import { getAgentByName } from "agents"
import type { Context } from "hono"
import { Hono } from "hono"
import {
	renderMcpConnectErrorPage,
	renderMcpConnectSuccessPage,
} from "@/lib/brain/slack/connect-landing"
import {
	postSlackMcpConnectConfirmation,
	updateSlackMcpConnectEphemeral,
} from "@/lib/brain/slack/mcp-connect"
import { updateSlackConnectMessage } from "@/lib/brain/slack/onboarding-card"
import {
	getCatalogEntry,
	getRemoteCatalogEntry,
	OFFERABLE_MCP_CATALOG,
} from "@/lib/brain/tools/mcp/catalog"
import {
	buildMcpCallbackUrl,
	publicApiOrigin,
	sanitizeRedirectUrl,
	startMcpConnect,
} from "@/lib/brain/tools/mcp/connect"
import {
	createCustomMcpFetch,
	validateCustomMcpServerUrl,
} from "@/lib/brain/tools/mcp/custom-url"
import {
	MCP_DIRECTORY,
	MCP_DIRECTORY_VERSION,
	mcpAppDisplayName,
} from "@/lib/brain/tools/mcp/directory"
import { withMcpFetchTimeout } from "@/lib/brain/tools/mcp/fetch"
import {
	disconnectGoogleWorkspaceBinding,
	finalizeGoogleWorkspaceCallback,
	GoogleBindingAlreadyExistsError,
	GoogleIdentityMismatchError,
} from "@/lib/brain/tools/mcp/google/grant-store"
import {
	consumeGoogleOAuthState,
	exchangeGoogleCode,
	fetchGoogleIdentity,
	googleWorkspaceClientId,
} from "@/lib/brain/tools/mcp/google/oauth"
import { McpConnectProvider } from "@/lib/brain/tools/mcp/oauth-provider"
import {
	deleteConnection,
	listConnectionsForActor,
	upsertStaticConnection,
} from "@/lib/brain/tools/mcp/store"
import { decryptToken } from "@/lib/crypto"
import type { AppContext } from "@/types"
import {
	catalogConnectUrlIsValid,
	directoryConnectUrlIsValid,
} from "./mcp-connect-policy"

// Org-shared connections affect every member, so creating/deleting them
// requires an org admin or owner. Personal connections have no role gate.
function canManageShared(c: Context<AppContext>): boolean {
	const role = c.get("memberRole")
	return role === ROLE_OWNER || role === ROLE_ADMIN
}

function orgHasBrain(org: BrainOrgLike | null | undefined): boolean {
	return isCompanyBrainOrg(org)
}

// Static-auth extras, e.g. Plane's x-workspace-slug.
const HEADER_NAME_RE = /^[a-zA-Z0-9-]{1,64}$/
// The MCP SDK sets these itself; a stored override silently breaks the session.
const EXTRA_HEADER_BLOCKLIST = new Set([
	"host",
	"authorization",
	"cookie",
	"content-length",
	"content-type",
	"content-encoding",
	"connection",
	"transfer-encoding",
	"upgrade",
	"te",
	"accept",
	"mcp-session-id",
	"mcp-protocol-version",
	"last-event-id",
])

type HeaderValidation<T> = { ok: true; value: T } | { ok: false; error: string }

function validateHeaderName(
	name: string | undefined,
): HeaderValidation<string | undefined> {
	if (name === undefined) return { ok: true, value: undefined }
	if (!HEADER_NAME_RE.test(name))
		return { ok: false, error: `invalid header name: ${name}` }
	// authorization is the default carrier for the secret, so it stays legal.
	if (
		name.toLowerCase() !== "authorization" &&
		EXTRA_HEADER_BLOCKLIST.has(name.toLowerCase())
	)
		return { ok: false, error: `header name not allowed: ${name}` }
	return { ok: true, value: name }
}

function sanitizeExtraHeaders(
	input: unknown,
	headerName: string | undefined,
): HeaderValidation<Record<string, string> | undefined> {
	if (input === undefined || input === null)
		return { ok: true, value: undefined }
	if (typeof input !== "object" || Array.isArray(input))
		return {
			ok: false,
			error: "extraHeaders must be an object of string values",
		}
	const entries = Object.entries(input as Record<string, unknown>).filter(
		([, v]) => v !== "" && v !== undefined && v !== null,
	)
	if (entries.length > 8)
		return { ok: false, error: "too many extraHeaders (max 8)" }
	const secretHeader = (headerName ?? "Authorization").toLowerCase()
	const out: Record<string, string> = {}
	const seen = new Set<string>()
	for (const [name, value] of entries) {
		const lower = name.toLowerCase()
		if (!HEADER_NAME_RE.test(name))
			return { ok: false, error: `invalid extra header name: ${name}` }
		if (EXTRA_HEADER_BLOCKLIST.has(lower))
			return { ok: false, error: `extra header not allowed: ${name}` }
		if (lower === secretHeader)
			return {
				ok: false,
				error: `extra header duplicates the auth header: ${name}`,
			}
		if (seen.has(lower))
			return { ok: false, error: `duplicate extra header: ${name}` }
		if (
			typeof value !== "string" ||
			value.length > 1024 ||
			/[\r\n]/.test(value)
		)
			return { ok: false, error: `invalid extra header value for ${name}` }
		seen.add(lower)
		out[name] = value
	}
	return { ok: true, value: out }
}

export const brainMcpConnectionsRoutes = new Hono<AppContext>()
	// Inbuilt catalog of curated MCP servers.
	.get("/catalog", (c) =>
		c.json({
			catalog: OFFERABLE_MCP_CATALOG.map((e) => ({
				slug: e.slug,
				name: e.name,
				iconDomain: e.iconDomain,
				category: e.category,
				runtime: e.runtime,
				authType: e.authType,
				tokenHint: e.tokenHint,
				personalOnly: e.personalOnly ?? false,
				leaseable: e.leaseable !== false,
			})),
		}),
	)
	// One source for the UI and the agent, so they cannot disagree.
	.get("/directory", (c) => {
		c.header("Cache-Control", "public, max-age=3600")
		return c.json({
			version: MCP_DIRECTORY_VERSION,
			entries: MCP_DIRECTORY.filter((e) => e.availability !== "local"),
		})
	})
	// List MCP connections visible to the caller: org-shared + their own.
	.get("/", async (c) => {
		const org = c.get("org")
		const user = c.get("user")
		if (!org || !user) return c.json({ error: "unauthorized" }, 401)
		const rows = await listConnectionsForActor(c.env, org.id, user.id)
		return c.json({
			connections: rows.map((r) => ({
				serverSlug: r.serverSlug,
				runtime: r.runtime,
				serverUrl: r.serverUrl,
				authType: r.authType,
				status: r.status,
				userId: r.userId,
				scopes: r.scopes,
				updatedAt: r.updatedAt,
			})),
		})
	})
	// Start an OAuth connect: returns the authorize URL for the browser.
	.post("/:slug/connect", async (c) => {
		const org = c.get("org")
		const user = c.get("user")
		if (!org || !user) return c.json({ error: "unauthorized" }, 401)

		const slug = c.req.param("slug").toLowerCase()
		const body = await c.req
			.json<{ serverUrl?: string; shared?: boolean; redirectUrl?: string }>()
			.catch(() => ({}) as Record<string, never>)
		if (body.shared && !canManageShared(c))
			return c.json({ error: "org admin required for shared connections" }, 403)

		const entry = getCatalogEntry(slug)
		let serverUrl = body.serverUrl
		if (!catalogConnectUrlIsValid(entry, serverUrl)) {
			return c.json(
				{ error: "custom serverUrl cannot use a catalog slug" },
				400,
			)
		}
		if (!directoryConnectUrlIsValid(slug, serverUrl)) {
			return c.json(
				{ error: "custom serverUrl cannot use a directory slug" },
				400,
			)
		}
		// Gated on the slug, not the URL: a directory slug carries its own URL, so
		// keying this on serverUrl would let it skip both checks.
		if (!entry) {
			if (!orgHasBrain(org)) {
				return c.json({ error: "forbidden" }, 403)
			}
			if (body.shared) {
				return c.json({ error: "custom MCP URLs are personal-only" }, 403)
			}
			if (serverUrl) {
				const validated = validateCustomMcpServerUrl(serverUrl, c.env)
				if (!validated.ok) return c.json({ error: validated.error }, 400)
				serverUrl = validated.normalizedUrl
			}
		}

		const result = await startMcpConnect({
			env: c.env,
			orgId: org.id,
			userId: user.id,
			slug,
			callbackOrigin: publicApiOrigin(c.env, c.req.url),
			shared: body.shared,
			serverUrl,
			redirectUrl: body.redirectUrl,
		})
		if (!result.ok) {
			const status =
				result.status === 400 || result.status === 501 || result.status === 503
					? result.status
					: 502
			return c.json({ error: result.error }, status)
		}
		if ("alreadyAuthorized" in result && result.alreadyAuthorized) {
			return c.json({ ok: true })
		}
		if ("authUrl" in result) return c.json({ authUrl: result.authUrl })
		return c.json({ error: "could not start authorization" }, 502)
	})
	// OAuth redirect target: exchange code, persist connection, redirect back.
	.get("/callback", async (c) => {
		const code = c.req.query("code")
		const state = c.req.query("state")
		if (!code || !state) return c.json({ error: "missing code/state" }, 400)

		const [stateRow] = await db(c.env)
			.select()
			.from(mcpOAuthState)
			.where(
				and(
					eq(mcpOAuthState.stateToken, state),
					gt(mcpOAuthState.expiresAt, new Date()),
				),
			)
			.limit(1)
		if (!stateRow) {
			// Drop any matching expired row so it can't be replayed.
			await db(c.env)
				.delete(mcpOAuthState)
				.where(eq(mcpOAuthState.stateToken, state))
			return c.json({ error: "invalid or expired state" }, 400)
		}
		if (stateRow.runtime === "embedded") {
			const consumed = await consumeGoogleOAuthState(c.env, state)
			if (!consumed?.userId || !consumed.pkceVerifierEnc) {
				return c.json({ error: "invalid or expired state" }, 400)
			}
			try {
				const tokens = await exchangeGoogleCode({
					env: c.env,
					code,
					redirectUri: buildMcpCallbackUrl(c.env, c.req.url),
					verifier: await decryptToken(
						consumed.pkceVerifierEnc,
						c.env.ENCRYPTION_SECRET,
					),
				})
				const identity = await fetchGoogleIdentity(tokens.access_token)
				const oauthClientId = googleWorkspaceClientId(c.env)
				await finalizeGoogleWorkspaceCallback({
					env: c.env,
					orgId: consumed.orgId,
					userId: consumed.userId,
					oauthClientId,
					identity,
					tokens,
					requestedScopes: consumed.requestedScopes,
					targetGrantId: consumed.targetGoogleWorkspaceGrantId,
				})
			} catch (error) {
				const status =
					error instanceof GoogleIdentityMismatchError
						? 400
						: error instanceof GoogleBindingAlreadyExistsError
							? 409
							: 502
				return c.json(
					{
						error:
							error instanceof Error
								? error.message
								: "Google authorization failed",
					},
					status,
				)
			}
			const redirect = sanitizeRedirectUrl(consumed.redirectUrl, c.env)
			if (redirect) return c.redirect(redirect)
			if (consumed.context?.slack) {
				const slack = consumed.context.slack
				const continuation =
					slack.messageTs && slack.buttons
						? updateSlackConnectMessage(c.env, {
								teamId: slack.teamId,
								channel: slack.channel,
								messageTs: slack.messageTs,
								buttons: slack.buttons,
								orgId: consumed.orgId,
								userId: consumed.userId,
							})
						: getAgentByName(c.env.COMPANY_BRAIN_AGENT, consumed.orgId).then(
								(agent) =>
									agent.onSlackConnectComplete({
										teamId: slack.teamId,
										channel: slack.channel,
										threadTs: slack.threadTs,
										slackUserId: slack.slackUserId,
										slug: "gmail",
										...(slack.originalQuestion
											? { originalQuestion: slack.originalQuestion }
											: {}),
									}),
							)
				c.executionCtx.waitUntil(
					continuation.catch((error) =>
						console.warn(
							"[mcp-connect] Gmail Slack continuation failed:",
							error,
						),
					),
				)
				return c.html(
					renderMcpConnectSuccessPage({
						appName: "Gmail",
						slack: { teamId: slack.teamId, channel: slack.channel },
					}),
				)
			}
			return c.json({ ok: true })
		}
		if (!stateRow.serverUrl) return c.json({ error: "invalid state" }, 400)

		const provider = new McpConnectProvider(c.env, {
			stateToken: state,
			orgId: stateRow.orgId,
			userId: stateRow.userId,
			serverSlug: stateRow.serverSlug,
			serverUrl: stateRow.serverUrl,
			callbackUrl: buildMcpCallbackUrl(c.env, c.req.url),
		})

		const result = await auth(provider, {
			serverUrl: stateRow.serverUrl,
			authorizationCode: code,
			fetchFn: getCatalogEntry(stateRow.serverSlug)
				? withMcpFetchTimeout()
				: withMcpFetchTimeout(createCustomMcpFetch(c.env)),
		})
		const slackContext = stateRow.context?.slack
		await db(c.env)
			.delete(mcpOAuthState)
			.where(eq(mcpOAuthState.stateToken, state))

		const appName = mcpAppDisplayName(stateRow.serverSlug)
		const slackTarget = slackContext
			? { teamId: slackContext.teamId, channel: slackContext.channel }
			: undefined

		if (result !== "AUTHORIZED") {
			if (slackContext)
				return c.html(
					renderMcpConnectErrorPage({
						appName,
						message:
							"Authorization didn't complete. Please try again from Slack.",
						slack: slackTarget,
					}),
					502,
				)
			return c.json({ error: "exchange failed" }, 502)
		}
		c.executionCtx.waitUntil(
			getAgentByName(c.env.COMPANY_BRAIN_AGENT, stateRow.orgId)
				.then((agent) => agent.onConnectionChanged(stateRow.serverSlug))
				.catch((error) => {
					console.warn(
						`[mcp-connect] catalog invalidation failed: ${error instanceof Error ? error.message : String(error)}`,
					)
				}),
		)

		if (slackContext) {
			const onboardingCard =
				slackContext.messageTs && slackContext.buttons
					? { messageTs: slackContext.messageTs, buttons: slackContext.buttons }
					: null
			const ephemeralCard =
				!onboardingCard && slackContext.responseUrl && slackContext.buttons
					? {
							responseUrl: slackContext.responseUrl,
							buttons: slackContext.buttons,
						}
					: null
			c.executionCtx.waitUntil(
				(async () => {
					if (onboardingCard) {
						await updateSlackConnectMessage(c.env, {
							teamId: slackContext.teamId,
							channel: slackContext.channel,
							messageTs: onboardingCard.messageTs,
							buttons: onboardingCard.buttons,
							orgId: stateRow.orgId,
							userId: stateRow.userId ?? undefined,
						})
						return
					}
					const cardUpdated = ephemeralCard
						? await updateSlackMcpConnectEphemeral(c.env, {
								responseUrl: ephemeralCard.responseUrl,
								buttons: ephemeralCard.buttons,
								orgId: stateRow.orgId,
								userId: stateRow.userId ?? undefined,
							})
						: false
					const agent = await getAgentByName(
						c.env.COMPANY_BRAIN_AGENT,
						stateRow.orgId,
					)
					await agent.onSlackConnectComplete({
						teamId: slackContext.teamId,
						channel: slackContext.channel,
						threadTs: slackContext.threadTs,
						slackUserId: slackContext.slackUserId,
						...(slackContext.originalQuestion
							? { originalQuestion: slackContext.originalQuestion }
							: {}),
						slug: stateRow.serverSlug,
						suppressConfirmation: cardUpdated,
					})
				})().catch(async (err) => {
					console.warn("[mcp-connect] slack continuation failed:", err)
					try {
						await postSlackMcpConnectConfirmation(c.env, {
							orgId: stateRow.orgId,
							teamId: slackContext.teamId,
							channel: slackContext.channel,
							threadTs: slackContext.threadTs,
							slug: stateRow.serverSlug,
						})
					} catch (fallbackErr) {
						console.warn(
							"[mcp-connect] slack confirmation fallback failed:",
							fallbackErr,
						)
					}
				}),
			)
		}

		const safeRedirect = sanitizeRedirectUrl(stateRow.redirectUrl, c.env)
		if (safeRedirect) return c.redirect(safeRedirect)
		if (slackContext)
			return c.html(
				renderMcpConnectSuccessPage({ appName, slack: slackTarget }),
			)
		return c.json({ ok: true })
	})
	// Static-token connection (no OAuth).
	.post("/:slug/connect-static", async (c) => {
		const org = c.get("org")
		const user = c.get("user")
		if (!org || !user) return c.json({ error: "unauthorized" }, 401)

		const slug = c.req.param("slug").toLowerCase()
		const body = await c.req
			.json<{
				serverUrl?: string
				token?: string
				headerName?: string
				extraHeaders?: Record<string, string>
				shared?: boolean
			}>()
			.catch(() => ({}) as Record<string, never>)
		const entry = getCatalogEntry(slug)
		const remoteEntry = getRemoteCatalogEntry(slug)
		if (entry?.runtime === "embedded") {
			return c.json(
				{ error: "embedded providers do not support static auth" },
				400,
			)
		}
		let serverUrl = body.serverUrl ?? remoteEntry?.serverUrl
		if (!serverUrl || !body.token)
			return c.json(
				{ error: "serverUrl (or catalog slug) and token required" },
				400,
			)
		const headerName = validateHeaderName(body.headerName)
		if (!headerName.ok) return c.json({ error: headerName.error }, 400)
		const extraHeaders = sanitizeExtraHeaders(
			body.extraHeaders,
			body.headerName,
		)
		if (!extraHeaders.ok) return c.json({ error: extraHeaders.error }, 400)
		if (body.shared && !canManageShared(c))
			return c.json({ error: "org admin required for shared connections" }, 403)
		if (!directoryConnectUrlIsValid(slug, body.serverUrl)) {
			return c.json(
				{ error: "custom serverUrl cannot use a directory slug" },
				400,
			)
		}
		if (
			entry &&
			body.serverUrl &&
			(!remoteEntry || !catalogConnectUrlIsValid(remoteEntry, body.serverUrl))
		) {
			return c.json(
				{ error: "custom serverUrl cannot use a catalog slug" },
				400,
			)
		}
		if (!entry) {
			if (!orgHasBrain(org)) {
				return c.json({ error: "forbidden" }, 403)
			}
			if (body.shared) {
				return c.json({ error: "custom MCP URLs are personal-only" }, 403)
			}
			const validated = validateCustomMcpServerUrl(serverUrl, c.env)
			if (!validated.ok) return c.json({ error: validated.error }, 400)
			serverUrl = validated.normalizedUrl
		}

		await upsertStaticConnection(c.env, {
			orgId: org.id,
			userId: body.shared ? null : user.id,
			serverSlug: slug,
			serverUrl,
			token: body.token,
			headerName: headerName.value,
			extraHeaders: extraHeaders.value,
		})
		c.executionCtx.waitUntil(
			getAgentByName(c.env.COMPANY_BRAIN_AGENT, org.id)
				.then((agent) => agent.onConnectionChanged(slug))
				.catch((error) => {
					console.warn(
						`[mcp-connect] catalog invalidation failed: ${error instanceof Error ? error.message : String(error)}`,
					)
				}),
		)
		return c.json({ ok: true })
	})
	// Disconnect.
	.delete("/:slug", async (c) => {
		const org = c.get("org")
		const user = c.get("user")
		if (!org || !user) return c.json({ error: "unauthorized" }, 401)

		const slug = c.req.param("slug").toLowerCase()
		const shared = c.req.query("shared") === "true"
		if (shared && !canManageShared(c))
			return c.json({ error: "org admin required for shared connections" }, 403)
		if (slug === "gmail") {
			if (shared) return c.json({ error: "Gmail is personal-only" }, 400)
			const connection = await listConnectionsForActor(
				c.env,
				org.id,
				user.id,
			).then((rows) =>
				rows.find(
					(row) => row.serverSlug === "gmail" && row.userId === user.id,
				),
			)
			if (!connection?.googleWorkspaceGrantId) {
				return c.json({ error: "not connected" }, 404)
			}
			await disconnectGoogleWorkspaceBinding(c.env, connection.id)
			return c.json({ ok: true })
		}
		const removed = await deleteConnection(
			c.env,
			org.id,
			slug,
			shared ? null : user.id,
		)
		if (!removed) return c.json({ error: "not connected" }, 404)
		return c.json({ ok: true })
	})
