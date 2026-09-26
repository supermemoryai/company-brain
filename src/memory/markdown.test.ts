import { describe, expect, it } from "vitest"
import { memoriesToMarkdown, memoryExportFilename } from "./markdown"
import type { BrainMemory } from "./memories"

function memory(
	partial: Partial<BrainMemory> & { memory: string },
): BrainMemory {
	return {
		id: partial.id ?? partial.memory,
		metadata: null,
		tags: [],
		buckets: [],
		documentIds: [],
		sourceCount: 1,
		updatedAt: "2026-09-20T10:00:00.000Z",
		...partial,
	}
}

const exportedAt = new Date("2026-09-25T18:30:00.000Z")

describe("memoriesToMarkdown", () => {
	it("lists each section's memories newest first, with date and tag labels", () => {
		const markdown = memoriesToMarkdown({
			orgName: "Acme",
			exportedAt,
			sections: [
				{
					heading: "Shared team brain",
					description: "What everyone can draw on.",
					memories: [
						memory({
							memory: "Kush owns the search API.",
							updatedAt: "2026-09-18T09:00:00.000Z",
						}),
						memory({
							memory: "We ship on Tuesdays.",
							updatedAt: "2026-09-24T09:00:00.000Z",
							metadata: {
								brain_tag_labels: ["Releases", "Eng", "Releases"],
							},
						}),
					],
				},
				{
					heading: "Only you",
					description: "Your private memories.",
					memories: [],
				},
			],
		})
		expect(markdown).toBe(
			[
				"# What Company Brain remembers about Acme",
				"",
				"Exported 2026-09-25T18:30:00.000Z. 2 memories, newest first.",
				"",
				"## Shared team brain",
				"",
				"What everyone can draw on.",
				"",
				"- We ship on Tuesdays. _(2026-09-24 · Releases · Eng)_",
				"- Kush owns the search API. _(2026-09-18)_",
				"",
				"## Only you",
				"",
				"Your private memories.",
				"",
				"_Nothing here yet._",
				"",
			].join("\n"),
		)
	})

	it("keeps a multi-line memory on one bullet and escapes markup", () => {
		const markdown = memoriesToMarkdown({
			orgName: null,
			exportedAt,
			sections: [
				{
					heading: "Shared team brain",
					description: "",
					memories: [
						memory({ memory: "Deploys use `wrangler`\n\n# not a heading <b>" }),
					],
				},
			],
		})
		expect(markdown).toContain("# What Company Brain remembers\n")
		expect(markdown).toContain("1 memory, newest first.")
		expect(markdown).toContain(
			"- Deploys use \\`wrangler\\` # not a heading \\<b\\> _(2026-09-20)_",
		)
		expect(markdown).not.toMatch(/^# not a heading/m)
	})
})

describe("memoryExportFilename", () => {
	it("dates the file by the export day", () => {
		expect(memoryExportFilename(exportedAt)).toBe(
			"company-brain-memories-2026-09-25.md",
		)
	})
})
