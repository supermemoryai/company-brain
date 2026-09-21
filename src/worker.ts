import { Hono } from "hono"
import { brainRoutes } from "./routes"
import { configureFromEnv } from "./config"
import { setupRoutes } from "./setup/routes"
import { hydrateSecrets, rememberPublicUrl } from "./setup/secrets"
import type { AppContext } from "./types"

export { CodemodeRuntime } from "@cloudflare/codemode"
export { CompanyBrainAgent } from "./brain/turn/agent"

const app = new Hono<AppContext>()

app.use("*", async (c, next) => {
	await hydrateSecrets(c.env)
	await rememberPublicUrl(c.env, new URL(c.req.url).origin)
	configureFromEnv(c.env)
	c.set("trackedEvents", new Set<string>())
	await next()
})

app.route("/setup", setupRoutes)
app.route("/", brainRoutes)

app.get("/health", (c) => c.json({ ok: true }))

export default app
