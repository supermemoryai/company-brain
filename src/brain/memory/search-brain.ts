import type { Query } from "@repo/validation/api"
import { BRAIN_TAGS_METADATA_KEY } from "@/lib/memory-entry-metadata"
import { logPreview } from "../observability/log-utils"
import {
	BRAIN_RELEVANCE_THRESHOLD,
	formatBrainScoreSummary,
} from "../search-brain-format"
import type { SlackOrg } from "../slack/workspace"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { getTurnDeps } from "../turn/deps"
import type { SlackMemoryScope } from "."
import { resolveBrainReadContainerTags } from "./read-scope"

export {
	BRAIN_RELEVANCE_THRESHOLD,
	brainCardTitle,
	countBrainResults,
	formatBrainResults,
	formatBrainScoreSummary,
	relevantBrainResults,
	textBrainResults,
} from "../search-brain-format"

export async function searchBrain(
	agent: CompanyBrainAgent,
	org: SlackOrg,
	userId: string,
	q: string,
	scope?: SlackMemoryScope,
	traceId?: string,
	focusTags?: string[],
	containerTagsOverride?: string[],
) {
	const startedAt = Date.now()
	const deps = await getTurnDeps()
	const c = deps.makeSlackSearchContext(
		brainAgent(agent).env,
		undefined,
		org,
		userId,
	)
	const vectordb = await deps.Effect.runPromise(
		deps.Effect.gen(function* () {
			return yield* deps.VectorDBService
		}).pipe(
			deps.Effect.provide(
				deps.makeAppLayer({ env: brainAgent(agent).env, orgId: org.id }),
			),
		),
	)
	const include = {
		documents: false,
		summaries: false,
		relatedMemories: false,
		forgottenMemories: false,
		chunks: true,
	}
	const containerTags = resolveBrainReadContainerTags(
		agent,
		scope,
		containerTagsOverride,
	)
	const filters = buildBrainFocusFilter(focusTags)
	if (traceId) {
		console.log(
			`[company-brain][${traceId}] searchBrain start query="${logPreview(q, 240)}" queryChars=${q.length} scope=${scope?.kind ?? "none"} containers=${containerTags.join(",")} focus=${focusTags?.length ? focusTags.join("|") : "none"}`,
		)
	}
	const searchContainer = async (containerTag: string) => {
		const t = Date.now()
		const result = await deps.searchMemoryEntries({
			q,
			limit: 40,
			threshold: BRAIN_RELEVANCE_THRESHOLD,
			include,
			rerank: false,
			aggregate: false,
			rewriteQuery: false,
			searchMode: "hybrid",
			containerTag,
			filters,
			org: org as Parameters<typeof deps.searchMemoryEntries>[0]["org"],
			env: brainAgent(agent).env,
			c,
			vectordb,
		})
		if (traceId) {
			console.log(
				`[company-brain][${traceId}] searchBrain container=${containerTag} results=${result.results.length} total=${result.total} engineMs=${result.timing} wallMs=${Date.now() - t} scores=${formatBrainScoreSummary(result.results)}`,
			)
		}
		return result
	}
	// Search every accessible container, but bound peak concurrency so a DM whose
	// asker is in many private channels doesn't fan out into one huge burst of
	// vector queries (connection-pool / vector-service load).
	const CONTAINER_SEARCH_CONCURRENCY = 6
	const searches: Awaited<ReturnType<typeof searchContainer>>[] = []
	for (let i = 0; i < containerTags.length; i += CONTAINER_SEARCH_CONCURRENCY) {
		const batch = containerTags.slice(i, i + CONTAINER_SEARCH_CONCURRENCY)
		searches.push(...(await Promise.all(batch.map(searchContainer))))
	}
	const byId = new Map<string, (typeof searches)[number]["results"][number]>()
	let duplicates = 0
	for (const result of searches.flatMap((search) => search.results)) {
		const existing = byId.get(result.id)
		if (!existing || result.similarity > existing.similarity) {
			if (existing) duplicates += 1
			byId.set(result.id, result)
		} else {
			duplicates += 1
		}
	}
	const results = [...byId.values()]
		.sort((a, b) => b.similarity - a.similarity)
		.slice(0, 40)
	if (traceId) {
		console.log(
			`[company-brain][${traceId}] searchBrain finish containers=${containerTags.length} raw=${searches.reduce((total, search) => total + search.results.length, 0)} deduped=${byId.size} duplicates=${duplicates} returned=${results.length} totalMs=${Date.now() - startedAt} finalScores=${formatBrainScoreSummary(results)}`,
		)
	}
	return {
		results,
		timing: searches.reduce((total, search) => total + search.timing, 0),
		total: results.length,
	}
}

// Scope a semantic search to memories carrying ANY of the given canonical brain
// tag keys (person_/topic_/project_/customer_/team_), matched against the
// brain_tags metadata array. Returns undefined when no focus is requested so
// the search stays unfiltered.
function buildBrainFocusFilter(focusTags?: string[]): Query | undefined {
	const keys = [
		...new Set((focusTags ?? []).map((tag) => tag.trim()).filter(Boolean)),
	]
	if (!keys.length) return undefined
	return {
		OR: keys.map((key) => ({
			key: BRAIN_TAGS_METADATA_KEY,
			value: key,
			filterType: "array_contains" as const,
			negate: false,
		})),
	}
}
