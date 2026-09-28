import { BRAIN_TAG_LABELS_METADATA_KEY } from "@/lib/memory-entry-metadata"
import { type BrainMemory, readStringArray } from "./memories"

export type MemoryExportSection = {
	heading: string
	description: string
	memories: BrainMemory[]
}

function labelsFor(memory: BrainMemory): string[] {
	const labels = readStringArray(
		memory.metadata?.[BRAIN_TAG_LABELS_METADATA_KEY],
	)
	return [...new Set(labels.map((label) => label.trim()).filter(Boolean))]
}

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

export function memoryExportFilename(exportedAt: Date): string {
	return `company-brain-memories-${exportedAt.toISOString().slice(0, 10)}.md`
}
