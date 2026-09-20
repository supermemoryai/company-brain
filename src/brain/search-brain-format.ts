export const BRAIN_RELEVANCE_THRESHOLD = 0.3

type BrainResultForFormat = {
	id?: string
	memory?: string
	chunk?: string
	filepath?: string | null
	resultType?: "memory" | "chunk"
	similarity?: number
}

export function formatBrainResults(
	results: ReadonlyArray<BrainResultForFormat>,
	opts: { filterByScore?: boolean; limit?: number } = {},
): string {
	const { filterByScore = true, limit } = opts
	const filtered = filterByScore
		? relevantBrainResults(results)
		: textBrainResults(results)
	const visible =
		typeof limit === "number" ? filtered.slice(0, limit) : filtered
	const lines = visible
		.map((r) => {
			const text = (r.memory ?? r.chunk)?.trim().replace(/\s+/g, " ")
			if (!text) return undefined
			const type = r.chunk || r.resultType === "chunk" ? "Chunk" : "Memory"
			const score =
				typeof r.similarity === "number"
					? ` (${(r.similarity * 100).toFixed(0)}%)`
					: ""
			const id = r.id ? ` ${r.id}` : ""
			const source = r.filepath ? ` (${r.filepath})` : ""
			return `${type}${score}${id}${source}: ${text}`
		})
		.filter((m): m is string => Boolean(m))
		.map((m, i) => `${i + 1}. ${m}`)
	return lines.length ? lines.join("\n") : "(none found)"
}

export function textBrainResults<T extends BrainResultForFormat>(
	results: ReadonlyArray<T>,
): T[] {
	return results.filter((r) => Boolean((r.memory ?? r.chunk)?.trim()))
}

export function relevantBrainResults<T extends BrainResultForFormat>(
	results: ReadonlyArray<T>,
): T[] {
	return textBrainResults(results).filter((r) => {
		return (
			r.similarity === undefined || r.similarity >= BRAIN_RELEVANCE_THRESHOLD
		)
	})
}

export function formatBrainScoreSummary(
	results: ReadonlyArray<BrainResultForFormat>,
): string {
	const scores = results
		.map((r) => r.similarity)
		.filter((score): score is number => typeof score === "number")
		.slice(0, 12)
		.map((score) => score.toFixed(3))
	return scores.length ? scores.join(",") : "-"
}

export function countBrainResults(formatted: string): number {
	const t = formatted.trim()
	if (!t || t === "(none found)") return 0
	return (t.match(/^\d+\.\s/gm) ?? []).length
}

export function brainCardTitle(count: number): string {
	if (count <= 0) return "No relevant memories found"
	return `Found ${count} relevant ${count === 1 ? "memory" : "memories"}`
}
