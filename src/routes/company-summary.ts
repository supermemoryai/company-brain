import { createXai } from "@ai-sdk/xai"
import { generateText } from "ai"
import { Hono } from "hono"
import {
	BrainCostLedger,
	chargeBrainLlmCost,
	responseBodyFromResult,
} from "@/lib/brain/billing/cost"
import { RESEARCH_MODEL } from "@/lib/brain/turn/model-profile"
import type { AppContext } from "@/types"

const MAX_CHARS = 360

const GENERIC_DOMAINS = new Set([
	"gmail.com",
	"googlemail.com",
	"yahoo.com",
	"outlook.com",
	"hotmail.com",
	"live.com",
	"icloud.com",
	"me.com",
	"proton.me",
	"protonmail.com",
	"aol.com",
])

function normalizeDomain(input: string): string | null {
	const raw = input
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/\/.*$/, "")
		.replace(/^www\./, "")
	if (!raw || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw)) return null
	if (GENERIC_DOMAINS.has(raw)) return null
	return raw
}

function clean(text: string): string | null {
	const out = text
		.trim()
		.replace(/^["']|["']$/g, "")
		.replace(/\s+/g, " ")
		.trim()
	if (!out) return null
	return out.length > MAX_CHARS ? `${out.slice(0, MAX_CHARS).trimEnd()}…` : out
}

const PROMPT = (domain: string) =>
	`Describe what the company at ${domain} does in 2-3 plain sentences — what they build and who they serve. Write it as the company's own short "about" blurb. No preamble, no markdown, max ~50 words.`

async function summarizeCompany(
	env: Env,
	domain: string,
	orgId?: string,
): Promise<string | null> {
	if (!env.XAI_API_KEY?.trim()) return null
	try {
		const xai = createXai({ apiKey: env.XAI_API_KEY })
		const result = await generateText({
			model: xai.responses(RESEARCH_MODEL),
			prompt: `Use web search on the company website ${domain}. ${PROMPT(domain)}`,
			tools: { web_search: xai.tools.webSearch() },
		})
		if (orgId) {
			const ledger = new BrainCostLedger()
			ledger.recordFromGeneration({
				model: RESEARCH_MODEL,
				usage: result.usage,
				providerMetadata: result.providerMetadata,
				responseBody: responseBodyFromResult(result),
			})
			await chargeBrainLlmCost({
				orgId,
				ledger,
				source: "company_summary",
				env,
			}).catch((err) => {
				console.warn(
					"[company-brain-billing] company_summary failed:",
					err instanceof Error ? err.message : err,
				)
			})
		}
		return clean(result.text)
	} catch (err) {
		console.warn("[company-brain] company-summary xai error:", err)
		return null
	}
}

// Drafts a "what this company does" blurb from a domain for Team Brain onboarding.
export const brainCompanySummaryRoutes = new Hono<AppContext>().post(
	"/",
	async (c) => {
		const user = c.get("user")
		if (!user) return c.json({ error: "unauthorized" }, 401)
		const org = c.get("org")

		const body = await c.req
			.json<{ domain?: string }>()
			.catch(() => ({}) as { domain?: string })
		const domain = normalizeDomain(body.domain ?? "")
		if (!domain) return c.json({ summary: null, reason: "invalid_domain" })

		const summary = await summarizeCompany(c.env, domain, org?.id)
		return c.json({ summary, domain })
	},
)
