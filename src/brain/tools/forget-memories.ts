import type { Tool } from "ai"
import { forgetMatchingMemories } from "@/routes/v4/memories/forget-matching"
import { AGENT_SELF_CONTAINER_TAG } from "@/lib/spaces/provisioning"
import { slackMemoryContainerTag } from "../memory/writeback"
import { logPreview } from "../observability/log-utils"
import type { SlackLookupContext } from "../slack/channel-lookup"
import type { SlackOrg } from "../slack/workspace"
import type { TurnDeps } from "../turn/deps"

const DEFAULT_THRESHOLD = 0.5
const DEFAULT_MAX_FORGET = 100
const SAMPLE_LIMIT = 8

// Bulk/semantic memory forget for Company Brain: dry-run previews candidates,
// the apply path rides the turn's approval card. Runs over this conversation's
// write tag plus the agent-self space, so a wrong learned habit is correctable
// the same way a wrong fact is. Never cross-tenant.
export function createForgetMemoriesTool(params: {
	deps: TurnDeps
	env: Env
	org: SlackOrg
	slackLookup?: SlackLookupContext
	traceId: string
}): Tool {
	const { deps, env, org, slackLookup, traceId } = params
	return deps.tool({
		description:
			"Forget memories in bulk by meaning, not just exact text (e.g. 'forget everything about the old pricing model'). One call covers both what you know and what you learned about yourself: team, project, and people facts, plus tone, habits, and anything shown to you as interaction style — all of it is forgettable, so when someone says something you know or do is wrong or out of date, fix it here rather than only agreeing in the reply. ALWAYS preview first with dryRun:true, then report the count and a few sample memories. Only when the requester wants to proceed, call again with dryRun:false AND the ids from the preview — that pauses for their approval and forgets exactly the previewed set, so do not ask a separate yes/no question. The forget cannot reach another team or channel. Prefer a specific target and raise threshold to avoid forgetting loosely-related memories.",
		inputSchema: deps.z.object({
			query: deps.z
				.string()
				.min(1)
				.max(2000)
				.describe(
					"What to forget: a natural instruction ('forget everything about Project Atlas') or a bare topic. Be specific; vague targets forget more than intended.",
				),
			dryRun: deps.z
				.boolean()
				.default(true)
				.describe(
					"Preview only. Keep true to see what WOULD be forgotten. Set false to actually forget — this requires the requester's approval before deletion.",
				),
			threshold: deps.z
				.number()
				.min(0)
				.max(1)
				.optional()
				.describe(
					`Match strictness 0-1 (default ${DEFAULT_THRESHOLD}). Raise it for a safer, tighter match on fuzzy requests.`,
				),
			maxForget: deps.z
				.number()
				.int()
				.min(1)
				.max(500)
				.optional()
				.describe(
					`Safety cap on how many memories one forget can remove (default ${DEFAULT_MAX_FORGET}).`,
				),
			reason: deps.z
				.string()
				.max(500)
				.optional()
				.describe(
					"Short reason recorded on each forgotten memory for auditability.",
				),
			ids: deps.z
				.array(deps.z.string())
				.optional()
				.describe(
					"Required to actually forget: the exact ids returned by a prior dryRun preview. Deletion is bound to this previewed set — pass them back verbatim.",
				),
		}),
		// Only the destructive apply needs approval; dry-run previews run freely.
		needsApproval: ({ dryRun }) => dryRun === false,
		execute: async ({
			query,
			dryRun = true,
			threshold,
			maxForget,
			reason,
			ids,
		}) => {
			// Fail closed: a destructive bulk forget must never default to the org-wide
			// shared brain when the conversation's scope can't be resolved (review #2674).
			if (!slackLookup?.memoryScope) {
				return {
					error:
						"I can't tell which memory space this conversation belongs to, so I won't run a bulk forget without a resolved scope. Nothing was changed.",
				}
			}
			const containerTag = slackMemoryContainerTag(slackLookup.memoryScope)
			if (!containerTag) {
				return {
					error:
						"I can't resolve a memory space for this conversation, so I won't run a forget without a safe scope. Nothing was changed.",
				}
			}
			const containerTags = [containerTag, AGENT_SELF_CONTAINER_TAG]
			if (dryRun === false && !ids?.length) {
				return {
					error:
						"To actually forget, first preview with dryRun:true, then call again with dryRun:false AND the ids it returned — deletion is bound to exactly that previewed set.",
				}
			}
			const t = Date.now()
			console.log(
				`[company-brain][${traceId}] forget_memories start dryRun=${dryRun} containers=${containerTags.join(",")} query="${logPreview(query)}"`,
			)
			try {
				const vectordb = await deps.Effect.runPromise(
					deps.Effect.gen(function* () {
						return yield* deps.VectorDBService
					}).pipe(
						deps.Effect.provide(deps.makeAppLayer({ env, orgId: org.id })),
					),
				)
				// On apply the same ids go to every container; each pass is
				// container-scoped in SQL and forgets only the ids it owns.
				const cap = maxForget ?? DEFAULT_MAX_FORGET
				const settled = await Promise.allSettled(
					containerTags.map((tag) =>
						forgetMatchingMemories({
							query,
							containerTag: tag,
							orgId: org.id,
							dryRun,
							threshold: threshold ?? DEFAULT_THRESHOLD,
							maxForget: cap,
							reason: reason ?? null,
							ids: dryRun === false ? ids : undefined,
							env,
							vectordb,
						}),
					),
				)
				const results = settled.flatMap((outcome, i) => {
					if (outcome.status === "fulfilled") return [outcome.value]
					console.error(
						`[company-brain][${traceId}] forget_memories container=${containerTags[i]} failed:`,
						outcome.reason instanceof Error
							? outcome.reason.message
							: outcome.reason,
					)
					return []
				})
				if (results.length === 0) {
					return {
						error:
							"The forget request failed before anything was changed. No memories were removed.",
					}
				}
				const partial = results.length < containerTags.length
				const candidates = results
					.flatMap((r) => r.candidates ?? [])
					.sort((a, b) => b.score - a.score)
					.slice(0, cap)
				const forgotten = results.flatMap((r) => r.forgotten ?? [])
				const count = dryRun ? candidates.length : forgotten.length
				const batchIds = results
					.map((r) => r.forgetBatchId)
					.filter((id): id is string => Boolean(id))
				console.log(
					`[company-brain][${traceId}] forget_memories finish dryRun=${dryRun} count=${count} batch=${batchIds.join(",") || "-"} partial=${partial} ms=${Date.now() - t}`,
				)
				const partialNote = partial
					? " One memory space couldn't be checked, so nothing there was touched."
					: ""
				if (count === 0) {
					return {
						dryRun,
						count: 0,
						message: `Nothing matched "${query}" in this conversation's memories or in what you've learned about yourself, so there's nothing to forget.${partialNote}`,
					}
				}
				const summary = `${results
					.filter((r) => r.count > 0)
					.map((r) => r.summary)
					.join(" ")}${partialNote}`
				if (dryRun) {
					return {
						dryRun: true,
						count,
						sampleMemories: candidates
							.slice(0, SAMPLE_LIMIT)
							.map((candidate) => candidate.memory),
						ids: candidates.map((candidate) => candidate.id),
						summary,
						next: "Report the count and a few sample memories. To actually forget, call again with dryRun:false and pass back these ids — that pauses for their approval and forgets exactly the previewed set, so do not ask a separate yes/no question.",
					}
				}
				return {
					dryRun: false,
					forgottenCount: count,
					sampleForgotten: forgotten
						.slice(0, SAMPLE_LIMIT)
						.map((candidate) => candidate.memory),
					forgetBatchId: batchIds.join(",") || null,
					summary,
				}
			} catch (error) {
				console.error(
					`[company-brain][${traceId}] forget_memories failed dryRun=${dryRun}:`,
					error instanceof Error ? error.message : error,
				)
				return {
					error:
						"The forget request failed before anything was changed. No memories were removed.",
				}
			}
		},
	})
}
