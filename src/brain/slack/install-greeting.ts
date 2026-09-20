import { getAgentByName } from "agents"
import { generateText, Output } from "ai"
import { z } from "zod"
import { fastModel } from "@/config"
import { getGenerateTextStructuredOutput } from "@/lib/ai-utils"
import {
	BrainCostLedger,
	chargeBrainLlmCost,
	responseBodyFromResult,
} from "../billing/cost"
import { resolveBillableModel } from "../billing/model-prices"
import { TRIAGE_MODEL } from "../turn/model-profile"
import { researchBrief } from "../turn/research-brief"
import { installGreeting } from "./greet"

export const BUBBLE_DELAY_MS = 1000

const StartersSchema = z.object({
	starters: z
		.array(z.string())
		.length(2)
		.describe(
			"Exactly two copy-ready questions a teammate could paste back right now, each answerable from the company research. Each under 14 words, written as a direct ask, no leading bullet or number, no quotes.",
		),
})

export async function composeStarters(
	env: Env,
	orgId: string,
	brief: string,
	company: string,
	source = "install_starters",
): Promise<string[] | null> {
	const result = await generateText({
		model: fastModel(),
		prompt:
			`You are Supermemory, just added to ${company}'s Slack. Using only the research below, write two questions the team could ask you right now that you could genuinely answer.\n\n` +
			`Research:\n${brief}\n\n` +
			`Make them specific to ${company}, not generic. Never invent facts.`,
		output: Output.object({ schema: StartersSchema }),
	})
	const ledger = new BrainCostLedger()
	// fastModel() resolves through a fallback chain — bill the model that
	// actually answered, not the triage default.
	ledger.recordFromGeneration({
		model: resolveBillableModel(result.response?.modelId, TRIAGE_MODEL),
		usage: result.usage,
		providerMetadata: result.providerMetadata,
		responseBody: responseBodyFromResult(result),
	})
	await chargeBrainLlmCost({
		orgId,
		ledger,
		source,
		env,
	}).catch((err) => {
		console.warn(
			`[company-brain-billing] ${source} failed:`,
			err instanceof Error ? err.message : err,
		)
	})
	const out = getGenerateTextStructuredOutput(result, StartersSchema)
	const starters = (out.starters ?? [])
		.flatMap((s) => {
			const clean = s.trim().replace(/^["'>\-\d.\s]+/, "")
			return clean ? [clean] : []
		})
		.slice(0, 2)
	return starters.length ? starters : null
}

export async function composeInstallBubbles(
	env: Env,
	orgId: string,
	firstName: string | undefined,
	opts: {
		companyName?: string | null
		homeChannelId?: string | null
		trialActive?: boolean
	} = {},
): Promise<string[] | null> {
	const base = {
		firstName,
		companyName: opts.companyName,
		homeChannelId: opts.homeChannelId,
		trialActive: opts.trialActive,
	}
	try {
		const agent = await getAgentByName(env.COMPANY_BRAIN_AGENT, orgId)
		const state = await agent.getResearchState()
		const brief = state.status === "done" ? researchBrief(state.events) : ""
		if (!brief) return [installGreeting(base)]

		const starters = await composeStarters(
			env,
			orgId,
			brief,
			opts.companyName ?? state.domain ?? "the company",
		)
		return [installGreeting({ ...base, starters: starters ?? undefined })]
	} catch (err) {
		console.warn("[slack] compose install bubbles failed:", err)
		return [installGreeting(base)]
	}
}
