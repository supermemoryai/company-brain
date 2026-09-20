import { Hono } from "hono"
import { availableProviders } from "@/lib/brain/turn/brain-model"
import type { AppContext } from "@/types"
import { slackCredentials, storeSlackCredentials } from "./config-store"
import { slackAppManifest } from "./manifest"
import { setupPage } from "./page"

export const setupRoutes = new Hono<AppContext>()
	.get("/", async (c) => {
		const origin = c.env.PUBLIC_URL ?? new URL(c.req.url).origin
		const providers = availableProviders(c.env)
		const slack = await slackCredentials(c.env).catch(() => null)
		return c.html(
			setupPage({
				origin,
				hasMemoryKey: Boolean(c.env.SUPERMEMORY_API_KEY?.trim()),
				providers,
				slackConfigured: Boolean(slack),
				manifest: slackAppManifest(origin, "company-brain"),
			}),
		)
	})
	.get("/manifest.json", (c) => {
		const origin = c.env.PUBLIC_URL ?? new URL(c.req.url).origin
		return c.json(slackAppManifest(origin, "company-brain"))
	})
	.post("/slack", async (c) => {
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
