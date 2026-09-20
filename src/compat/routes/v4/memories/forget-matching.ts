import type Supermemory from "supermemory"
import { memoryClient } from "../../../../memory/client"

export interface ForgetMatchingParams {
	/** Natural-language instruction ("forget everything about X") or a bare query. */
	query?: string
	containerTag: string
	orgId: string
	dryRun: boolean
	threshold: number
	maxForget: number
	reason: string | null
	/** Apply bound to a previewed set: forget exactly these ids. */
	ids?: string[]
	env: Env
	vectordb?: Supermemory
	executionCtx?: ExecutionContext
}

export interface ForgetCandidate {
	id: string
	memory: string
	score: number
}

export interface ForgetMatchingResult {
	dryRun: boolean
	count: number
	forgetBatchId: string | null
	summary: string
	/** Populated on dryRun: what WOULD be forgotten. */
	candidates?: ForgetCandidate[]
	/** Populated on apply: what WAS forgotten. */
	forgotten?: ForgetCandidate[]
}

/**
 * Forget memories matching a query. The hosted version ran its own vector
 * search and an LLM selection pass; supermemory's forget endpoint does the
 * matching server-side, so this searches for the preview and forgets by id.
 */
export async function forgetMatchingMemories(
	params: ForgetMatchingParams,
): Promise<ForgetMatchingResult> {
	const client = params.vectordb ?? memoryClient(params.env)
	const { containerTag, dryRun, threshold, maxForget, reason } = params

	const explicit = params.ids?.length ? [...new Set(params.ids)] : null
	const candidates: ForgetCandidate[] = explicit
		? explicit.map((id) => ({ id, memory: "", score: 1 }))
		: await searchCandidates()

	if (dryRun) {
		return {
			dryRun: true,
			count: candidates.length,
			forgetBatchId: null,
			summary: summarize(candidates.length, true),
			candidates,
		}
	}

	const settled = await Promise.allSettled(
		candidates.map((candidate) =>
			client.memories.forget({
				containerTag,
				id: candidate.id,
				...(reason ? { reason } : {}),
			}),
		),
	)
	const forgotten = candidates.filter(
		(_, index) => settled[index]?.status === "fulfilled",
	)
	for (const [index, outcome] of settled.entries()) {
		if (outcome.status === "rejected") {
			console.error(
				`[memory] forget failed id=${candidates[index]?.id} ${String(outcome.reason)}`,
			)
		}
	}
	return {
		dryRun: false,
		count: forgotten.length,
		forgetBatchId: crypto.randomUUID(),
		summary: summarize(forgotten.length, false),
		forgotten,
	}

	async function searchCandidates(): Promise<ForgetCandidate[]> {
		if (!params.query?.trim()) return []
		const response = await client.search.memories({
			q: params.query,
			containerTag,
			limit: maxForget,
			threshold,
		})
		return response.results
			.filter((result) => result.similarity >= threshold)
			.slice(0, maxForget)
			.map((result) => ({
				id: result.id,
				memory: result.memory ?? result.chunk ?? "",
				score: result.similarity,
			}))
	}
}

function summarize(count: number, preview: boolean): string {
	if (count === 0) return "Nothing matched."
	const noun = count === 1 ? "memory" : "memories"
	return preview ? `Would forget ${count} ${noun}.` : `Forgot ${count} ${noun}.`
}
