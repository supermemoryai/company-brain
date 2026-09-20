import { listActiveConnectionsForActor } from "./mcp/store"

export type AutomationConnectionWarning = {
	app: string
	reason: "personal_only"
}

export type AutomationConnectionAssessment = {
	warnings: AutomationConnectionWarning[]
	automationApps: string[]
}

// Channel automations only see org-shared connections (privacy: a personal
// credential must not feed content the whole channel reads). Flag apps the
// creator can use interactively that the automation cannot.
export async function assessAutomationConnections(
	env: Env,
	orgId: string,
	creatorUserId: string,
	deliverTo: "channel" | "dm",
): Promise<AutomationConnectionAssessment> {
	const visible = await listActiveConnectionsForActor(env, orgId, creatorUserId)
	if (deliverTo === "dm") {
		return {
			warnings: [],
			automationApps: [...new Set(visible.map((c) => c.serverSlug))],
		}
	}
	const shared = new Set(
		visible.filter((c) => c.userId === null).map((c) => c.serverSlug),
	)
	const personalOnly = new Set(
		visible
			.filter((c) => c.userId !== null && !shared.has(c.serverSlug))
			.map((c) => c.serverSlug),
	)
	return {
		warnings: [...personalOnly].map((app) => ({
			app,
			reason: "personal_only" as const,
		})),
		automationApps: [...shared],
	}
}
