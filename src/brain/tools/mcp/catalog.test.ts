import { describe, expect, it } from "vitest"
import { getMcpCatalogSlugs, MCP_CATALOG } from "./catalog"

describe("MCP catalog", () => {
	it("offers every connector nothing has paused", () => {
		// connect_app is only registered when this list is non-empty.
		expect(MCP_CATALOG.length).toBeGreaterThan(0)
		expect(getMcpCatalogSlugs()).toEqual(MCP_CATALOG.map((entry) => entry.slug))
		expect(getMcpCatalogSlugs()).toContain("linear")
	})
})
