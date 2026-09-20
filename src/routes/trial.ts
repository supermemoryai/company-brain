import { isCompanyBrainOrg } from "@repo/lib/features"
import { ROLE_ADMIN, ROLE_OWNER } from "@repo/lib/permissions"
import { Hono } from "hono"
import { getCompanyBrainEntitlement } from "@/lib/payments/company-brain-entitlement"
import type { AppContext } from "@/types"

export const brainTrialRoutes = new Hono<AppContext>()
	.get("/status", async (c) => {
		const org = c.get("org")
		if (!org) return c.json({ error: "unauthorized" }, 401)
		const entitlement = await getCompanyBrainEntitlement(
			c.env,
			org.id,
			(promise) => c.executionCtx.waitUntil(promise),
		)
		return c.json({
			ok: true as const,
			active: entitlement.allowed,
			reason: entitlement.reason ?? null,
		})
	})
	.post("/start", async (c) => {
		const org = c.get("org")
		const user = c.get("user")
		if (!org || !user) return c.json({ error: "unauthorized" }, 401)
		if (!isCompanyBrainOrg(org)) {
			return c.json({ error: "forbidden" }, 403)
		}
		const role = c.get("memberRole")
		if (role !== ROLE_ADMIN && role !== ROLE_OWNER) {
			return c.json({ error: "forbidden" }, 403)
		}

		const existing = await getCompanyBrainEntitlement(
			c.env,
			org.id,
			(promise) => c.executionCtx.waitUntil(promise),
		)
		if (existing.allowed) {
			return c.json({ ok: true as const, status: "already_active" as const })
		}

		return c.json({ error: "trial_unavailable" as const }, 409)
	})
