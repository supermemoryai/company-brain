import { Hono } from "hono"
import { db } from "@repo/db"
import { organization } from "@repo/db/schema/auth"
import { ROLE_ADMIN, roleAtLeast } from "@repo/lib/permissions"
import { applyMigrations, migrationStatus } from "../db/migrate"
import { availableProviders } from "@/lib/brain/turn/brain-model"
import type { AppContext } from "@/types"
import { slackCredentials, storeSlackCredentials } from "./config-store"
import { slackAppManifest } from "./manifest"
import { setupPage } from "./page"
import { providerForModelKey } from "./secrets"
import { sandboxBackend } from "@/lib/brain/tools/sandbox/availability"

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
				paidFeatures: Boolean(c.env.LOADER),
				sandbox: sandboxBackend(c.env),
				providers,
				slackConfigured: Boolean(slack),
				signedIn: Boolean(c.get("user")),
				manifest: slackAppManifest(origin, "company-brain"),
			}),
		)
	})
	.get("/manifest.json", (c) => {
		const origin = c.env.PUBLIC_URL ?? new URL(c.req.url).origin
		return c.json(slackAppManifest(origin, "company-brain"))
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
		return c.redirect("/setup")
	})
