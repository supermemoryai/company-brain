import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const root = fileURLToPath(new URL(".", import.meta.url))

/** Mirrors tsconfig paths so unit tests can import brain modules. */
export default defineConfig({
	resolve: {
		alias: [
			{ find: "@/lib/brain", replacement: `${root}src/brain` },
			{ find: "@/routes/brain", replacement: `${root}src/routes` },
			{ find: "@/lib", replacement: `${root}src/compat/lib` },
			{ find: "@/services", replacement: `${root}src/compat/services` },
			{ find: "@/routes", replacement: `${root}src/compat/routes` },
			{ find: "@repo/db/schema", replacement: `${root}src/db/schema` },
			{ find: "@repo/db", replacement: `${root}src/db/index.ts` },
			{ find: "@repo/lib", replacement: `${root}src/compat/repo-lib` },
			{ find: "@repo/validation", replacement: `${root}src/compat/validation` },
			{ find: "@/config", replacement: `${root}src/config/index.ts` },
			{ find: "@/types", replacement: `${root}src/types.ts` },
		],
	},
})
