/**
 * GUI verification harness for the OrcaRouter provider.
 *
 * It serves the deployment's own interfaces over HTTP so a browser can be
 * driven against them:
 *
 *  - `/setup`            the real server-rendered page from `setupPage()`
 *  - `/configure/models` the real built app bundle
 *  - `/brain/models`     the real `orcaCatalogFor()` catalog, filtered per
 *                        surface, so the selectors hold exactly what a
 *                        deployment with an OrcaRouter credential would show
 *
 * Only the deployment's own modules render anything here; nothing is stubbed
 * with fake markup. `ORCA_API_KEY` is optional — without it the verified seed
 * is served and the run is labelled degraded, exactly as in production.
 *
 * Usage: bun scripts/orca-evidence/harness.ts   (then run capture.py)
 */

import { readFile } from "node:fs/promises"
import { extname, join, resolve } from "node:path"
import { orcaCatalogFor } from "../../src/brain/turn/orcarouter-models"
import { setupPage } from "../../src/setup/page"

const ROOT = resolve(import.meta.dir, "..", "..")
const DIST = join(ROOT, "dist/web")
const PORT = Number(process.env.ORCA_EVIDENCE_PORT ?? 8787)

const key = process.env.ORCA_API_KEY?.trim()
const env = { ORCA_API_KEY: key } as unknown as Env

const main = await orcaCatalogFor(env, "chat-multimodal", {
	apiKey: key,
})
const triage = await orcaCatalogFor(env, "chat", { apiKey: key })
console.log(
	"catalog: main(multimodal)=%d triage(chat)=%d source=%s degraded=%s",
	main.models.length,
	triage.models.length,
	triage.source,
	main.degradedReason ?? "-",
)

const option = (m: { id: string; name: string; contextLength?: number }) => ({
	id: m.id,
	name: m.name,
	contextLength: m.contextLength,
})
const section = (models: typeof main.models, catalog: typeof main) => ({
	degraded: catalog.source === "seed" || catalog.degradedReason !== undefined,
	degradedReason: catalog.degradedReason,
	source: catalog.source,
	options: models.map(option),
})

const modelsBody = {
	resolved: {
		main: main.models[0]?.id ?? "",
		mainEffort: "auto",
		triage: triage.models[0]?.id ?? "",
		triageEffort: "auto",
	},
	defaults: {
		main: main.models[0]?.id ?? "",
		mainEffort: "auto",
		triage: triage.models[0]?.id ?? "",
		triageEffort: "auto",
	},
	router: "orcarouter",
	orca: { main: section(main.models, main), triage: section(triage.models, triage) },
	choices: {
		main: triage.models.map((m) => m.id),
		mainEffort: ["auto", "low", "medium", "high", "xhigh"],
		triage: triage.models.map((m) => m.id),
		triageEffort: ["auto", "low", "medium", "high"],
	},
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".map": "application/json",
	".png": "image/png",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
	".json": "application/json",
}

const setupHtml = setupPage({
	origin: `http://127.0.0.1:${PORT}`,
	databaseReady: true,
	pendingMigrations: [],
	migrationError: null,
	hasMemoryKey: true,
	modelKeyUnrecognized: false,
	sandbox: null,
	providers: ["orcarouter"],
	slackConfigured: true,
	signedIn: true,
	installedTeam: "Evidence Workspace",
	manifest: {},
	// A fresh deployment: the OrcaRouter step is current, which is the state
	// that renders both credential methods.
	orca: {
		configured: false,
		needsReauth: false,
		hint: "",
		sourceLabel: "",
		credentialLabel: "OrcaRouter - API",
	},
})

const server = Bun.serve({
	port: PORT,
	async fetch(request) {
		const url = new URL(request.url)
		if (url.pathname === "/setup") {
			return new Response(setupHtml, {
				headers: { "Content-Type": "text/html; charset=utf-8" },
			})
		}
		if (url.pathname === "/auth/session") {
			return Response.json({
				user: { id: "evidence", email: "evidence@example.test", name: "Evidence", image: null },
				org: { id: "evidence", name: "Evidence", slug: "evidence", logo: null },
				role: "owner",
			})
		}
		if (url.pathname.startsWith("/brain/models")) return Response.json(modelsBody)
		let path = url.pathname === "/" ? "/index.html" : url.pathname
		if (!extname(path)) path = "/index.html"
		try {
			const body = await readFile(join(DIST, path))
			return new Response(body, {
				headers: { "Content-Type": MIME[extname(path)] ?? "application/octet-stream" },
			})
		} catch {
			try {
				const body = await readFile(join(DIST, "index.html"))
				return new Response(body, { headers: { "Content-Type": "text/html" } })
			} catch {
				return new Response(
					"the app bundle is missing — run `bun run web/build.ts` first",
					{ status: 404 },
				)
			}
		}
	},
})

console.log("evidence harness on", server.url.toString())
await new Promise(() => {})
