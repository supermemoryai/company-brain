export type ResearchEventLite = {
	label: string
	status: string
	detail: string | null
}

// Completed research aspects as prompt context; empty string when nothing landed.
export function researchBrief(events: ResearchEventLite[]): string {
	return events
		.flatMap((e) => {
			const detail = e.detail?.trim()
			return e.status === "complete" && detail ? [`${e.label}: ${detail}`] : []
		})
		.join("\n\n")
}
