import { BRAIN_TAG_LABELS_METADATA_KEY } from "@/lib/memory-entry-metadata"
import type { BrainMemory } from "./memories"

export type MemoryExportSection = {
	heading: string
	description: string
	memories: BrainMemory[]
}

function labelsFor(memory: BrainMemory): string[] {
	const labels = memory.metadata?.[BRAIN_TAG_LABELS_METADATA_KEY]
	if (!Array.isArray(labels)) return []
	return [
		...new Set(
			labels
				.filter((label): label is string => typeof label === "string")
				.map((label) => label.trim())
				.filter(Boolean),
		),
	]
}

// One memory per list item: fold line breaks so a multi-line memory can't
// break out of its bullet, and escape characters that would start markup.
function memoryLine(memory: BrainMemory): string {
	const text = memory.memory
		.replace(/\s*\n\s*/g, " ")
		.trim()
		.replace(/([\\`*_[\]<>])/g, "\\$1")
	const date = memory.updatedAt.slice(0, 10)
	const labels = labelsFor(memory)
	const meta = [date, ...labels].join(" · ")
	return `- ${text} _(${meta})_`
}

/**
 * What the brain remembers, as one Markdown file a person can read, grep,
 * diff or drop into a wiki. Memories are listed newest first under the
 * container they came from, so shared and private memories stay apart.
 */
export function memoriesToMarkdown(params: {
	orgName: string | null
	exportedAt: Date
	sections: MemoryExportSection[]
}): string {
	const total = params.sections.reduce(
		(sum, section) => sum + section.memories.length,
		0,
	)
	const title = params.orgName?.trim()
		? `# What Company Brain remembers about ${params.orgName.trim()}`
		: "# What Company Brain remembers"
	const lines = [
		title,
		"",
		`Exported ${params.exportedAt.toISOString()}. ${total} ${total === 1 ? "memory" : "memories"}, newest first.`,
	]
	for (const section of params.sections) {
		lines.push("", `## ${section.heading}`, "", section.description, "")
		if (section.memories.length === 0) {
			lines.push("_Nothing here yet._")
			continue
		}
		const sorted = [...section.memories].sort((a, b) =>
			b.updatedAt.localeCompare(a.updatedAt),
		)
		for (const memory of sorted) lines.push(memoryLine(memory))
	}
	return `${lines.join("\n")}\n`
}

/** `company-brain-memories-2026-09-25.md` */
export function memoryExportFilename(exportedAt: Date): string {
	return `company-brain-memories-${exportedAt.toISOString().slice(0, 10)}.md`
}
