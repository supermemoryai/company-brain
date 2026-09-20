import { count, db, eq } from "@repo/db"
import { member } from "@repo/db/schema/auth"
import { isCompanyBrainOrg } from "@repo/lib/features"
import { getAgentByName } from "agents"
import { Hono } from "hono"
import { getWorkspaceStatusByOrgId } from "@/lib/brain/slack/workspace"
import { listConnectionsForActor } from "@/lib/brain/tools/mcp/store"
import type { AppContext } from "@/types"

// One aggregate snapshot for the brain home; replaces N client round trips.
export const brainOverviewRoutes = new Hono<AppContext>().get(
	"/",
	async (c) => {
		const org = c.get("org")
		const user = c.get("user")
		if (!org || !user) return c.json({ error: "unauthorized" }, 401)
		if (!isCompanyBrainOrg(org)) {
			return c.json({ error: "forbidden" }, 403)
		}

		const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, org.id)
		const [research, rollout, slack, connections, memberRows] =
			await Promise.all([
				agent
					.getResearchState()
					.then((s) => s.status ?? null)
					.catch(() => null),
				agent.getPublicChannelRolloutOverview().catch(() => null),
				getWorkspaceStatusByOrgId(c.env, org.id).catch(() => ({
					connected: false,
					teamName: null as string | null,
				})),
				listConnectionsForActor(c.env, org.id, user.id).catch(() => []),
				db(c.env)
					.select({ value: count() })
					.from(member)
					.where(eq(member.organizationId, org.id))
					.catch(() => [{ value: 0 }]),
			])

		return c.json({
			research: { status: research },
			slack: {
				connected: slack.connected,
				teamName: slack.teamName,
				rollout,
			},
			connections: {
				apps: connections.filter((r) => r.status === "active").length,
			},
			members: { count: Number(memberRows[0]?.value ?? 0) },
		})
	},
)
