import { Hono } from "hono"
import { db } from "@repo/db"
import { organization } from "@repo/db/schema/auth"
import { ROLE_ADMIN, roleAtLeast } from "@repo/lib/permissions"
import { availableProviders } from "@/lib/brain/turn/brain-model"
import type { AppContext } from "@/types"
import { slackCredentials, storeSlackCredentials } from "./config-store"
import { slackAppManifest } from "./manifest"
import { setupPage } from "./page"

export const setupRoutes = new Hono<AppContext>()
	.get("/", async (c) => {
		const origin = c.env.PUBLIC_URL ?? new URL(c.req.url).origin
		const providers = availableProviders(c.env)
		// A query failing here almost always means the migrations never ran.
		const databaseReady = await db(c.env)
			.select({ id: organization.id })
			.from(organization)
			.limit(1)
			.then(() => true)
			.catch(() => false)
		const slack = databaseReady
			? await slackCredentials(c.env).catch(() => null)
			: null
		return c.html(
			setupPage({
				origin,
				databaseReady,
				hasMemoryKey: Boolean(c.env.SUPERMEMORY_API_KEY?.trim()),
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
