import { generateText, Output } from "ai"
import { z } from "zod"
import { getGenerateTextStructuredOutput } from "@/lib/ai-utils"
import { captureException } from "@/lib/capture"
import { type BrainCostLedger, responseBodyFromResult } from "../billing/cost"
import { resolveBillableModel } from "../billing/model-prices"
import { getCompanyContext } from "../memory/company-context"
import { buildBrainProfileContext } from "../memory/profile-recall"
import { listBrainMemoryTags } from "../memory/tags"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { getBrainModel } from "../turn/brain-model"
import { TRIAGE_MODEL } from "../turn/model-profile"
import type { DraftRecipient } from "./roster"
import type { WatchTargetKind } from "./watchlist"

// Picks what this run investigates: outward targets, plus teammates worth a DM.

export type PlanTargetKind = WatchTargetKind | "question"
export type PlanTarget = { kind: PlanTargetKind; label: string; angle: string }
export type PlanPerson = { recipient: DraftRecipient; angle: string }

export type ResearchPlan = {
	focus: string
	targets: PlanTarget[]
	people: PlanPerson[]
}

// A run that plans nothing looks identical to a crash from the console, so the
// caller gets the reason rather than a bare null.
export type PlanOutcome =
	| { plan: ResearchPlan }
	| { plan: null; reason: "no_context" | "failed" }

const PlanSchema = z.object({
	focus: z
		.string()
		.describe(
			"1-2 sentences on what the company is currently working on or betting on — the lens for relevance.",
		),
	targets: z
		.array(
			z.object({
				kind: z.enum([
					"competitor",
					"person",
					"product",
					"topic",
					"term",
					"question",
				]),
				label: z.string(),
				angle: z
					.string()
					.describe("One line on what to look for and why it could matter."),
			}),
		)
		.max(6)
		.describe(
			"External things to investigate for the whole team: competitors/people/products to track, topics/standards to stay current on, or open questions to probe (kind 'question'). NEVER the company itself or its products.",
		),
	people: z
		.array(
			z.object({
				slackUserId: z
					.string()
					.describe("Must be one of the Slack ids from the roster."),
				angle: z
					.string()
					.describe(
						"What this specific person would find useful right now, and why them.",
					),
			}),
		)
		.max(4)
		.describe(
			"Teammates worth a direct note, chosen from the roster. Only people where you have a specific reason — skip rather than pad.",
		),
})

const SYSTEM = `You plan one round of proactive research for a company's brain. The company's description, the topics it tracks, and its recent activity are given ONLY as a LENS for relevance — you look OUTWARD, at the world and at what individual teammates are doing.

Produce three things:
1. "focus": 1-2 sentences on what the company is currently working on or betting on.
2. "targets": the most relevant EXTERNAL things to investigate for the whole team right now — competitors/people/products shipping things, topics or standards to stay current on, open questions worth probing (kind "question").
3. "people": teammates from the roster who deserve a note aimed just at them — an idea for something they're working on, a thing they'd want to know, a connection they'd miss. Their own tools and private context are available when drafting for them, so an angle that only makes sense for that one person is good.

Hard rules:
- NEVER research the company itself, its own products, its own launches, or its own people as a "target". Targets are outside things.
- Real and specific only. No market platitudes, no invented competitors.
- Label a target only with what you actually know. Never attach a founder, author, or company name to a product on a guess, and when several products share a name, say which one you mean by its domain — a wrong label sends the research after the wrong thing entirely.
- Precision over coverage: a few sharp items beat a long list. Most important first.
- One story, one target. If a single piece of news is the biggest thing this week, take it ONCE with the sharpest angle. Every other target must be genuinely different ground, not the same story relabelled, split into parts, or approached from another side.
- A target only belongs to the whole team if it stands on its own. If the reason it matters is one person's current work, make it a person entry instead.
- When the operator names specific teammates, those are person entries so each one becomes a direct message. Never turn a request for a note "for <name>" into a channel target.
- When the operator asks for a specific number of notes, that count is the whole round: return that many items in total across targets and people, not that many of each.
- Do not repeat anything in the already-sent or already-drafted lists, even reworded or under a different label.
- Only pick people whose Slack id appears in the roster. If nobody has a specific angle, return an empty list.`

export type DerivePlanInput = {
	steer?: string
	sentBodies: string[]
	/** Awaiting review. Unsent, so the sent list won't stop us redrafting them. */
	draftedBodies: string[]
	roster: DraftRecipient[]
	costLedger?: BrainCostLedger
}

export async function derivePlan(
	agent: CompanyBrainAgent,
	input: DerivePlanInput,
): Promise<PlanOutcome> {
	const env = brainAgent(agent).env
	const orgId = agent.name

	const [companyContext, profileContext] = await Promise.all([
		getCompanyContext(env, orgId),
		buildBrainProfileContext(agent, { orgId }),
	])
	const vocab = listBrainMemoryTags(agent, {
		kinds: ["topic", "project", "customer"],
		limit: 40,
	}).map((t) => t.label)
	if (!companyContext && !profileContext && !vocab.length) {
		console.log(
			`[company-brain] auto-research plan skipped org=${orgId}: no context`,
		)
		return { plan: null, reason: "no_context" }
	}

	const rosterBlock = input.roster.length
		? `Roster (pick "people" only from these):\n${input.roster
				.map(
					(r) =>
						`- ${r.slackUserId} — ${r.name}${r.personalApps.length ? ` (connected: ${r.personalApps.join(", ")})` : ""}`,
				)
				.join("\n")}`
		: null
	const sentBlock = input.sentBodies.length
		? `Already sent (never repeat these):\n${input.sentBodies.map((b) => `- ${b.replace(/\s+/g, " ").slice(0, 240)}`).join("\n")}`
		: null
	const draftedBlock = input.draftedBodies.length
		? `Already drafted and waiting for review (do not cover this ground again):\n${input.draftedBodies.map((b) => `- ${b.replace(/\s+/g, " ").slice(0, 240)}`).join("\n")}`
		: null
	// Operator steering outranks the derived lens: it's a human telling the run
	// what this round is for.
	const steerBlock = input.steer?.trim()
		? `Direction from the operator running this — follow it over your own instincts:\n${input.steer.trim()}`
		: null

	try {
		const result = await generateText({
			model: getBrainModel(TRIAGE_MODEL, env),
			system: SYSTEM,
			prompt: [
				companyContext ? `Company:\n${companyContext}` : null,
				vocab.length ? `Topics it already tracks: ${vocab.join(", ")}` : null,
				profileContext,
				rosterBlock,
				sentBlock,
				draftedBlock,
				steerBlock,
			]
				.filter(Boolean)
				.join("\n\n"),
			output: Output.object({ schema: PlanSchema }),
		})
		input.costLedger?.recordFromGeneration({
			model: resolveBillableModel(result.response?.modelId, TRIAGE_MODEL),
			usage: result.usage,
			providerMetadata: result.providerMetadata,
			responseBody: responseBodyFromResult(result),
		})
		const out = getGenerateTextStructuredOutput(result, PlanSchema)
		const bySlackId = new Map(input.roster.map((r) => [r.slackUserId, r]))
		const plan: ResearchPlan = {
			focus: out.focus.trim(),
			targets: out.targets
				.filter((t) => t.label.trim())
				.map((t) => ({ kind: t.kind, label: t.label.trim(), angle: t.angle })),
			// Drop hallucinated ids: a draft may only be scoped to a real member.
			people: out.people.flatMap((p) => {
				const recipient = bySlackId.get(p.slackUserId)
				return recipient ? [{ recipient, angle: p.angle }] : []
			}),
		}
		console.log(
			`[company-brain] auto-research plan org=${orgId} targets=${plan.targets.length} people=${plan.people.length}`,
		)
		return { plan }
	} catch (err) {
		captureException(err instanceof Error ? err : new Error(String(err)), {
			tags: { component: "auto-research-plan" },
		})
		return { plan: null, reason: "failed" }
	}
}
