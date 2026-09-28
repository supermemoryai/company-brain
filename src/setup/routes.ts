import { Hono, type Context } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { db } from "@repo/db"
import { organization } from "@repo/db/schema/auth"
import { slackWorkspace } from "@repo/db/schema/slack"
import { ROLE_ADMIN, roleAtLeast } from "@repo/lib/permissions"
import { applyMigrations, migrationStatus } from "../db/migrate"
import { availableProviders } from "@/lib/brain/turn/brain-model"
import type { AppContext } from "@/types"
import { slackCredentials, storeSlackCredentials } from "./config-store"
import { slackAppManifest } from "./manifest"
import {
	completeOrcaOob,
	connectOrcaApiKey,
	disconnectOrca,
	ORCA_PENDING_COOKIE,
	ORCA_PENDING_TTL_SECONDS,
	pollOrcaDevice,
	startOrcaDevice,
	startOrcaOob,
} from "./orca"
import { orcaCredentialSummary } from "@/lib/brain/turn/orcarouter-store"
import { setupPage, type OrcaSetupView } from "./page"
import { providerForModelKey } from "./secrets"
import { sandboxBackend } from "@/lib/brain/tools/sandbox/availability"

type OrcaFlash = {
	message?: string
	error?: boolean
	handle?: string
	authorizeUrl?: string
	device?: OrcaSetupView["device"]
}

/**
 * The pending authorization handle and the flash message travel in cookies so
 * the setup page stays a plain server-rendered form. Neither carries a key or
 * a PKCE verifier.
 */
function readFlash(c: Context<AppContext>): OrcaFlash | null {
	const raw = getCookie(c, ORCA_FLASH_COOKIE)
	if (!raw) return null
	try {
		const parsed: unknown = JSON.parse(raw)
		return typeof parsed === "object" && parsed !== null
			? (parsed as OrcaFlash)
			: null
	} catch {
		return null
	}
}

const ORCA_FLASH_COOKIE = "orca_flash"

export const setupRoutes = new Hono<AppContext>()
	.get("/", async (c) => {
		const origin = c.env.PUBLIC_URL ?? new URL(c.req.url).origin
		const providers = availableProviders(c.env)
		const migrations = await migrationStatus(c.env).catch((error) => ({
			applied: [] as string[],
			pending: [] as string[],
			error: error instanceof Error ? error.message : String(error),
		}))
		const databaseReady =
			!("error" in migrations) && migrations.pending.length === 0
		const slack = databaseReady
			? await slackCredentials(c.env).catch(() => null)
			: null
		const [installed] = databaseReady
			? await db(c.env)
					.select({ teamName: slackWorkspace.teamName })
					.from(slackWorkspace)
					.limit(1)
					.catch(() => [])
			: []
		// The OrcaRouter step needs a database to read its stored credential.
		const orca = databaseReady
			? await orcaCredentialSummary(c.env).catch(() => null)
			: null
		const flash = readFlash(c)
		deleteCookie(c, ORCA_FLASH_COOKIE, { path: "/setup" })
		const pending = getCookie(c, ORCA_PENDING_COOKIE)
		const orcaView: OrcaSetupView | null = orca
			? {
					configured: orca.configured,
					needsReauth: orca.needsReauth,
					hint: orca.hint,
					sourceLabel:
						orca.source === "orcarouter-oauth"
							? "Connect with OrcaRouter"
							: orca.source === "orcarouter"
								? "API key"
								: "",
					credentialLabel:
						orca.source === "orcarouter-oauth"
							? "Connect with OrcaRouter"
							: "an API key you pasted",
					/** Only an attempt still waiting for a code shows this. */
					authorizeUrl: pending ? flash?.authorizeUrl : undefined,
					device: pending ? flash?.device : undefined,
					message: flash?.message,
					error: flash?.error,
				}
			: null
		return c.html(
			setupPage({
				origin,
				databaseReady,
				pendingMigrations: migrations.pending,
				migrationError:
					c.req.query("migrate_error") ??
					("error" in migrations ? migrations.error : null),
				hasMemoryKey: Boolean(c.env.SUPERMEMORY_API_KEY?.trim()),
				modelKeyUnrecognized: Boolean(
					c.env.MODEL_API_KEY?.trim() &&
						!providerForModelKey(c.env.MODEL_API_KEY.trim()),
				),
				sandbox: sandboxBackend(c.env),
				providers,
				slackConfigured: Boolean(slack),
				signedIn: Boolean(c.get("user")),
				installedTeam: installed ? (installed.teamName ?? "your workspace") : null,
				manifest: slackAppManifest(origin),
				orca: orcaView,
			}),
		)
	})
	.get("/manifest.json", (c) => {
		const origin = c.env.PUBLIC_URL ?? new URL(c.req.url).origin
		return c.json(slackAppManifest(origin))
	})
	// OrcaRouter: paste a key the operator already has. The key goes straight
	// into the deployment's encrypted store; it is never rendered back.
	.post("/orca/key", async (c) => {
		const form = await c.req.formData()
		const key = String(form.get("key") ?? "")
		const outcome = await connectOrcaApiKey(c.env, key)
		return orcaRedirect(c, outcome.message, !outcome.ok)
	})
	// OrcaRouter: Flow B. Mint an attempt, send the browser to the consent
	// screen, and hold the verifier server-side until the code comes back.
	.post("/orca/authorize", async (c) => {
		const form = await c.req.formData()
		const flow = String(form.get("flow") ?? "oob") === "device" ? "device" : "oob"
		const outcome =
			flow === "device" ? await startOrcaDevice(c.env) : await startOrcaOob(c.env)
		if (!outcome.ok) return orcaRedirect(c, outcome.message, true)
		setCookie(c, ORCA_PENDING_COOKIE, outcome.handle, {
			path: "/setup",
			httpOnly: true,
			sameSite: "Lax",
			secure: new URL(c.req.url).protocol === "https:",
			maxAge: ORCA_PENDING_TTL_SECONDS,
		})
		const device = outcome.start.deviceCode
			? {
					verificationUri: outcome.start.url,
					verificationUriComplete: outcome.start.verificationUriComplete,
					userCode: outcome.start.userCode,
				}
			: undefined
		if (device) {
			return orcaRedirect(
				c,
				"Approve the code on your other device, then reload this page.",
				false,
				{ handle: outcome.handle, device },
			)
		}
		return orcaRedirect(
			c,
			"Waiting for you to approve in the browser, then paste the code below.",
			false,
			{ handle: outcome.handle, authorizeUrl: outcome.start.url },
		)
	})
	// Finish Flow B with the code the consent screen showed.
	.post("/orca/complete", async (c) => {
		const form = await c.req.formData()
		const code = String(form.get("code") ?? "")
		const handle = getCookie(c, ORCA_PENDING_COOKIE) ?? ""
		const outcome = await completeOrcaOob(c.env, handle, code)
		deleteCookie(c, ORCA_PENDING_COOKIE, { path: "/setup" })
		return orcaRedirect(c, outcome.message, !outcome.ok)
	})
	// Poll the device grant once, on demand.
	.post("/orca/device/poll", async (c) => {
		const handle = getCookie(c, ORCA_PENDING_COOKIE) ?? ""
		const outcome = await pollOrcaDevice(c.env, handle)
		if (outcome.ok) {
			deleteCookie(c, ORCA_PENDING_COOKIE, { path: "/setup" })
		}
		return orcaRedirect(c, outcome.message, !outcome.ok)
	})
	.post("/orca/clear", async (c) => {
		await disconnectOrca(c.env)
		deleteCookie(c, ORCA_PENDING_COOKIE, { path: "/setup" })
		return orcaRedirect(
			c,
			"Disconnected. Models fall back to whichever provider key is set.",
			false,
		)
	})
	// Normally the worker migrates itself on first request; this is the manual
	// retry. It only ever applies the migrations bundled into this build.
	.post("/migrate", async (c) => {
		try {
			await applyMigrations(c.env)
			return c.redirect("/setup")
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			return c.redirect(`/setup?migrate_error=${encodeURIComponent(message)}`)
		}
	})
	.post("/slack", async (c) => {
		// Before anyone has signed in there is nobody to ask. After that, only an
		// admin may swap the Slack app out from under the workspace.
		const claimed = await db(c.env)
			.select({ id: organization.id })
			.from(organization)
			.limit(1)
		if (claimed.length > 0 && !roleAtLeast(c.get("memberRole"), ROLE_ADMIN)) {
			return c.text("Only a workspace admin can change the Slack app.", 403)
		}
		const form = await c.req.formData()
		const clientId = String(form.get("clientId") ?? "").trim()
		const clientSecret = String(form.get("clientSecret") ?? "").trim()
		const signingSecret = String(form.get("signingSecret") ?? "").trim()
		if (!clientId || !clientSecret || !signingSecret) {
			return c.text("All three Slack values are required.", 400)
		}
		await storeSlackCredentials(c.env, {
			clientId,
			clientSecret,
			signingSecret,
		})
		return c.redirect("/setup#step-signin")
	})


/**
 * Send the operator back to the OrcaRouter step with a result. The flash rides
 * a short-lived cookie rather than a query string, so a message can never
 * carry anything from the credential exchange.
 */
function orcaRedirect(
	c: Context<AppContext>,
	message: string,
	error: boolean,
	extra: {
		handle?: string
		authorizeUrl?: string
		device?: OrcaSetupView["device"]
	} = {},
): Response {
	setCookie(
		c,
		"orca_flash",
		JSON.stringify({ message, error, ...extra }),
		{
			path: "/setup",
			httpOnly: true,
			sameSite: "Lax",
			secure: new URL(c.req.url).protocol === "https:",
			maxAge: 300,
		},
	)
	return c.redirect("/setup#step-orca")
}
