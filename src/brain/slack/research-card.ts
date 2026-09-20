import { decryptToken } from "@/lib/crypto"
import { RESEARCH_ASPECT_PLAN, type ResearchEvent } from "../turn/research"
import { postSlackMessage, updateSlackMessage } from "./client"
import { richTextEntity, taskCardSources } from "./stream"
import { getWorkspaceByTeamId } from "./workspace"

// Aspects before this are internal setup beats, not findings worth showing.
const HIDDEN_ASPECTS = new Set(["workspace", "prepare"])
const MAX_TASKS = 8

function hostLabel(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "")
	} catch {
		return url.slice(0, 40)
	}
}

function taskStatus(status: string): "in_progress" | "complete" | "error" {
	if (status === "complete") return "complete"
	if (status === "error") return "error"
	return "in_progress"
}

export function researchCardBlocks(args: {
	companyName: string
	events: ResearchEvent[]
	done: boolean
	blockId: string
}): unknown[] {
	// Render every planned aspect so the plan never looks finished early.
	const byAspect = new Map(
		args.events
			.filter((event) => !HIDDEN_ASPECTS.has(event.aspect))
			.map((event) => [event.aspect, event]),
	)
	const shown: ResearchEvent[] = RESEARCH_ASPECT_PLAN.slice(0, MAX_TASKS).map(
		(planned) =>
			byAspect.get(planned.key) ?? {
				aspect: planned.key,
				label: planned.title,
				status: "pending",
				detail: null,
				stats: [],
				highlights: [],
				sources: [],
				createdAt: 0,
			},
	)
	return [
		{
			type: "plan",
			block_id: args.blockId,
			title: (args.done
				? `Read up on ${args.companyName}`
				: `Reading up on ${args.companyName}`
			).slice(0, 150),
			tasks: shown.map((event) => {
				const sources = taskCardSources(
					event.sources.slice(0, 3).map((url) => ({
						url,
						text: hostLabel(url),
					})),
				)
				return {
					type: "task_card",
					task_id: event.aspect,
					title: event.label.slice(0, 150),
					status: taskStatus(event.status),
					...(event.detail ? { output: richTextEntity(event.detail) } : {}),
					...(sources ? { sources } : {}),
				}
			}),
		},
	]
}

// Posts once, then edits in place as aspects land. Returns the message ts so
// the caller can persist it; a failed update means the card is gone, so callers
// should stop rather than repost.
export async function upsertResearchCard(
	env: Env,
	args: {
		teamId: string
		channelId: string
		companyName: string
		events: ResearchEvent[]
		done: boolean
		blockId: string
		messageTs?: string
	},
): Promise<string | undefined> {
	const ws = await getWorkspaceByTeamId(env, args.teamId)
	if (!ws) return undefined
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	const blocks = researchCardBlocks({
		companyName: args.companyName,
		events: args.events,
		done: args.done,
		blockId: args.blockId,
	})
	const text = args.done
		? `Read up on ${args.companyName}`
		: `Reading up on ${args.companyName}`

	if (args.messageTs) {
		const ok = await updateSlackMessage(
			botToken,
			args.channelId,
			args.messageTs,
			text,
			blocks,
		)
		return ok ? args.messageTs : undefined
	}
	return postSlackMessage(botToken, args.channelId, text, undefined, blocks)
}
