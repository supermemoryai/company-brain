import type { ToolSet } from "ai"
import { logPreview } from "../observability/log-utils"
import type { TurnDeps } from "./deps"
import { recordSurfacedUpdate, type TurnState } from "./state"
import type { TurnProgress } from "./types"

// post_update is the only path that publishes a mid-turn message. Narration is
// opt-in: the model's inter-step reasoning is never posted, so nothing reaches
// the thread unless the model deliberately calls this tool.
export function createProgressTools(
	deps: TurnDeps,
	progress: TurnProgress | undefined,
	traceId: string,
	state?: TurnState,
): ToolSet {
	const narrate = progress?.narrate
	if (!narrate) return {}
	return {
		post_update: deps.tool({
			description:
				"Post one short standalone progress message to the thread mid-turn. There is no prescribed wording — phrase it however you genuinely would, and let it read differently each time rather than settling into one habitual line. When a request will take real work before you can answer (a connected-app query, sandbox job, or multi-step search), say something first so the person knows it's underway and roughly what you're doing. As the work runs, share a real finding when one lands. Mid-work updates go by need, not clock: post only when something genuinely new is worth sharing, stay quiet when nothing has changed, and never post to fill time or repeat yourself. A request you can answer right away needs none. Each call carries real content — never per step or per tool, never the machinery of how you work, never contentless status, never a substitute for the final answer.",
			inputSchema: deps.z.object({
				message: deps.z
					.string()
					.min(1)
					.describe(
						"The standalone update in plain Slack markdown. It must carry real content and stand on its own; do not repeat an earlier update or preview the final message.",
					),
			}),
			execute: async ({ message }) => {
				const text = message.trim()
				if (!text) return { posted: false }
				const posted = await narrate(text)
				// Recorded here, not per caller, so the approval-resume loop tracks
				// surfaced updates too.
				if (posted && state) recordSurfacedUpdate(state, text)
				console.log(
					`[company-brain][${traceId}] post_update posted=${posted} text="${logPreview(text, 180)}"`,
				)
				return { posted }
			},
		}),
	}
}
