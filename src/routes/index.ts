import { Hono } from "hono"
import type { AppContext } from "@/types"
import { brainAutomationsRoutes } from "./automations"
import { brainCompanySummaryRoutes } from "./company-summary"
import { brainMcpConnectionsRoutes } from "./mcp-connections"
import { brainModelsRoutes } from "./models"
import { brainOverviewRoutes } from "./overview"
import { brainResearchRoutes } from "./research"
import { brainSettingsRoutes } from "./settings"
import { brainSkillsRoutes } from "./skills"
import { slackRoutes } from "./slack"
import { brainTrialRoutes } from "./trial"

// Root for all Company Brain routes (Slack agent, connections, future CB endpoints).
export const brainRoutes = new Hono<AppContext>()
	.route("/slack", slackRoutes)
	.route("/mcp-connections", brainMcpConnectionsRoutes)
	.route("/company-summary", brainCompanySummaryRoutes)
	.route("/automations", brainAutomationsRoutes)
	.route("/skills", brainSkillsRoutes)
	.route("/research", brainResearchRoutes)
	.route("/models", brainModelsRoutes)
	.route("/settings", brainSettingsRoutes)
	.route("/overview", brainOverviewRoutes)
	.route("/trial", brainTrialRoutes)
