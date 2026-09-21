import type { Config } from "drizzle-kit"

export default {
	schema: "./src/db/schema/index.ts",
	out: "./drizzle",
	dialect: "sqlite",
	driver: "d1-http",
} satisfies Config
