import { type BrainOrgLike, isCompanyBrainOrg } from "@repo/lib/features"
import { ROLE_ADMIN, ROLE_OWNER } from "@repo/lib/permissions"
import { getAgentByName } from "agents"
import { Hono } from "hono"
import { getCompanyBrainEntitlement } from "@/lib/payments/company-brain-entitlement"
import type { AppContext } from "@/types"

const DOMAIN_RE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/

function normalizeDomain(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/^www\./, "")
		.replace(/\/.*$/, "")
}

// isCompanyBrainOrg (not hasCompanyBrain) so onboarding works before Autumn attaches the add-on.
function orgHasBrain(org: BrainOrgLike | null | undefined): boolean {
	return isCompanyBrainOrg(org)
}

// Research status + chain-of-thought for the onboarding UI to poll.
export const brainResearchRoutes = new Hono<AppContext>()
	.get("/status", async (c) => {
		const org = c.get("org")
		const user = c.get("user")
		if (!org || !user) return c.json({ error: "unauthorized" }, 401)
		if (!orgHasBrain(org)) return c.json({ error: "forbidden" }, 403)
		const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, org.id)
		const state = await agent.getResearchState()
		return c.json(state)
	})
	// Explicitly start research (works for existing orgs re-entering onboarding).
	// Admin/owner only: each run burns web-search + LLM calls and resets phases.
	.post("/start", async (c) => {
		const org = c.get("org")
		const user = c.get("user")
		if (!org || !user) return c.json({ error: "unauthorized" }, 401)
		if (!orgHasBrain(org)) return c.json({ error: "forbidden" }, 403)
		const entitlement = await getCompanyBrainEntitlement(
			c.env,
			org.id,
			(promise) => c.executionCtx.waitUntil(promise),
		)
		if (!entitlement.allowed) {
			return c.json({ error: "not_entitled", reason: entitlement.reason }, 403)
		}
		const role = c.get("memberRole")
		if (role !== ROLE_ADMIN && role !== ROLE_OWNER) {
			return c.json({ error: "forbidden" }, 403)
		}
		const body = await c.req
			.json<{ domain?: string }>()
			.catch(() => ({}) as { domain?: string })
		const domain = normalizeDomain(body.domain ?? "")
		if (!domain || !DOMAIN_RE.test(domain)) {
			return c.json({ error: "invalid_domain" }, 400)
		}
		const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, org.id)
		// Don't let a fresh request wipe an in-flight run.
		const state = await agent.getResearchState()
		if (state.status === "queued" || state.status === "running") {
			return c.json({ ok: true, alreadyRunning: true })
		}
		// Same-domain rerun of a finished pass is pure repeat spend — skip it.
		if (state.status === "done" && state.domain === domain) {
			return c.json({ ok: true, alreadyRan: true })
		}
		await agent.researchCompanyOnSignup({
			domain,
			ownerId: user.id,
			force: true,
		})
		return c.json({ ok: true })
	})
