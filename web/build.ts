import { cp, rm } from "node:fs/promises"
import tailwind from "bun-plugin-tailwind"

const outdir = `${import.meta.dir}/../dist/web`
await rm(outdir, { recursive: true, force: true })

// Bundles the app UI into dist/web, which wrangler serves as static assets.
const result = await Bun.build({
	entrypoints: [`${import.meta.dir}/index.html`],
	outdir,
	// Absolute, so deep links like /configure/models still find the bundle.
	publicPath: "/",
	plugins: [tailwind],
	minify: true,
	sourcemap: "linked",
	target: "browser",
	define: { "process.env.NODE_ENV": JSON.stringify("production") },
})

if (!result.success) {
	for (const log of result.logs) console.error(log)
	process.exit(1)
}
// Files the app references by absolute path (/images/...), served as-is.
await cp(`${import.meta.dir}/public`, outdir, { recursive: true })
console.log(`web: ${result.outputs.length} files → dist/web`)
