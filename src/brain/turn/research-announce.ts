import { generateText, Output } from "ai"
import { z } from "zod"
import { fastModel } from "@/config"
import { getGenerateTextStructuredOutput } from "@/lib/ai-utils"
import { decryptToken } from "@/lib/crypto"
import {
	BrainCostLedger,
	chargeBrainLlmCost,
	responseBodyFromResult,
} from "../billing/cost"
import { postSlackMessage } from "../slack/client"
import { getWorkspaceByTeamId } from "../slack/workspace"
import { brainAgent, type CompanyBrainAgent } from "./agent"
import { getHomeChannel } from "./home-channel"
import { TRIAGE_MODEL } from "./model-profile"
import { getResearchState } from "./research"
import { researchBrief } from "./research-brief"

const DigestSchema = z.object({
	facts: z
		.array(z.string())
		.length(2)
		.describe(
			"Exactly two punchy facts, each under 14 words, plain text, no bullet characters, no trailing period. Prefer the sharpest number and the competitive position. Concrete beats vague.",
		),
	questions: z
		.array(z.string())
		.length(2)
		.describe(
			"Exactly two short, concrete questions a teammate could ask right now that this research can answer. Each under 12 words, phrased as a natural ask.",
		),
})

function ensureAnnouncedTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS research_announced (
			id INTEGER PRIMARY KEY,
			announced_at INTEGER NOT NULL
		)
	`
}

function alreadyAnnounced(agent: CompanyBrainAgent): boolean {
	ensureAnnouncedTable(agent)
	return Boolean(
		agent.sql<{
			id: number
		}>`SELECT id FROM research_announced WHERE id = 1`[0],
	)
}

function markAnnounced(agent: CompanyBrainAgent): void {
	ensureAnnouncedTable(agent)
	agent.sql`
		INSERT INTO research_announced (id, announced_at)
		VALUES (1, ${Date.now()})
		ON CONFLICT (id) DO UPDATE SET announced_at = ${Date.now()}
	`
}

// Cleared when a new run is scheduled so the next completion announces again.
export function clearResearchAnnounced(agent: CompanyBrainAgent): void {
	ensureAnnouncedTable(agent)
	agent.sql`DELETE FROM research_announced WHERE id = 1`
}

// Install-time path: research may already be done, in which case no new run will
// ever fire the completion hook, so post what we already know.
export async function announceResearchIfDone(
	agent: CompanyBrainAgent,
): Promise<void> {
	if (getResearchState(agent).status !== "done") return
	await announceResearchDone(agent)
}

// Best-effort: the home channel may not exist yet, never throws.
export async function announceResearchDone(
	agent: CompanyBrainAgent,
): Promise<void> {
	try {
		const home = getHomeChannel(agent)
		if (!home) return
		if (alreadyAnnounced(agent)) return
		const env = brainAgent(agent).env
		// By teamId, not orgId: the channel belongs to one workspace, and an org
		// can have more than one installed.
		const ws = await getWorkspaceByTeamId(env, home.teamId)
		if (!ws) return
		const token = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)

		const state = getResearchState(agent)
		const brief = researchBrief(state.events)
		if (!brief) return

		const result = await generateText({
			model: fastModel(),
			prompt:
				`You are Company Brain, posting in the #company-brain Slack channel right after finishing your first research pass on ${state.domain ?? "the company"}. Use only facts from the research below, never invent.\n\n` +
				`Research:\n${brief}\n\n` +
				"Write the digest described by the schema: two sharp facts (one should name who they compete with, if the research says), then two starter questions teammates can ask you.",
			output: Output.object({ schema: DigestSchema }),
		})
		const ledger = new BrainCostLedger()
		ledger.recordFromGeneration({
			model: TRIAGE_MODEL,
			usage: result.usage,
			providerMetadata: result.providerMetadata,
			responseBody: responseBodyFromResult(result),
		})
		await chargeBrainLlmCost({
			orgId: agent.name,
			ledger,
			source: "research_announce",
			env,
		}).catch((err) => {
			console.warn(
				"[company-brain-billing] research_announce failed:",
				err instanceof Error ? err.message : err,
			)
		})
		const out = getGenerateTextStructuredOutput(result, DigestSchema)
		const facts = (out.facts ?? [])
			.flatMap((f) => {
				const clean = f.trim()
				return clean ? [clean] : []
			})
			.slice(0, 2)
		if (!facts.length) return

		const questions = (out.questions ?? [])
			.flatMap((q) => {
				const clean = q.trim()
				return clean ? [clean] : []
			})
			.slice(0, 2)
		const companyLabel = ws.orgName?.trim() || state.domain || "your company"
		const text = [
			`*That's ${companyLabel} in a nutshell.*`,
			...facts.map((f) => `• ${f}`),
			"",
			"*Try me:*",
			...questions.map((q) => `• _${q}_`),
			"_Answers get sharper as I read your channels and connect your tools._",
		].join("\n")
		// postSlackMessage returns undefined instead of throwing, so only latch the
		// guard on a real ts — otherwise one transient failure kills every retry.
		const ts = await postSlackMessage(token, home.channelId, text)
		if (!ts) {
			console.warn("[company-brain] research announce: post failed, will retry")
			return
		}
		markAnnounced(agent)
	} catch (err) {
		console.warn("[company-brain] research announce failed:", err)
	}
}
