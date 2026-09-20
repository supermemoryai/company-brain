export const SUPERMEMORY_DOCS_SKILL = {
	id: "system:supermemory-docs",
	name: "Supermemory Docs",
	description:
		"Use for questions about Supermemory products, APIs, SDKs, integrations, MCP, setup, or supported capabilities.",
	body: `Answer public questions about Supermemory using the current official documentation rather than recollection.
Use search_web with a focused query constrained to site:supermemory.ai/docs before making product, API, SDK, integration, setup, or capability claims. Cite the direct documentation pages that support the answer.
If search_web is unavailable or the official documentation does not establish the answer, say that the documentation does not confirm it instead of guessing.
This skill is for public Supermemory documentation. Use Company Brain or connected apps for private company decisions, customer data, or the organization's own configuration.`,
	version: 1,
	usageCount: 0,
	lastUsedAt: null,
	updatedAt: Date.UTC(2026, 7, 10),
} as const
