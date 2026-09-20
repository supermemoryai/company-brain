import { generateId } from "@repo/lib/generate-id"
import type { ModelMessage } from "ai"
import { houseStyle, stripScaffolding, VOICE } from "../auto-research/draft"
import { recentDraftOutcomes } from "../auto-research/outcome"
import {
	getAutoResearchDraft,
	listAutoResearchDrafts,
} from "../auto-research/store"
import type { SlackLookupContext } from "../slack/channel-lookup"
import { openSlackConversation } from "../slack/client"
import { loadOrgSlackContext } from "../slack/org-context"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { computeTurn } from "../turn/compute"
import { loadOrg } from "../turn/research"
import { listBrainSurfaces } from "./surfaces"

// Runs the workspace's own agent from the admin console: read-only, never billed.

export type AdminChatTurn = { role: "user" | "assistant"; content: string }

export type AdminChatInput = {
	question: string
	/** Refine this draft instead of answering freely; the reply is a replacement. */
	refineDraftId?: string
	/** Prior turns of this conversation, oldest first. The console holds the thread. */
	history?: AdminChatTurn[]
	/** Surface ids from listBrainSurfaces. Empty means the shared team brain. */
	surfaceIds?: string[]
}

export type AdminChatResult =
	| {
			ok: true
			reply: string
			scope: "org_shared" | "person"
			/** Who we ran as, when scoped to a person. */
			actingAs: string | null
			/** The surfaces actually read, after validating what was asked for. */
			surfaces: string[]
			/** A replacement draft body, when refining. Already house-styled. */
			proposedBody?: string
			/** What it touched, by tool and what was asked of it. */
			trail: Array<{ tool: string; label: string }>
	  }
	| { ok: false; error: string }

const MAX_HISTORY_TURNS = 20

// Refining is a different job from answering: the operator wants replacement
// wording, so ask for exactly that and hold it to the same voice as a fresh draft.
function refineFrame(
	question: string,
	draftBody: string,
	destination: string,
	surfaces: string[],
): string {
	return `An internal Supermemory operator is refining a draft that would be sent to ${destination}. Nothing is sent by you: they review your wording and apply it themselves.

Memory is scoped to these surfaces, and you can investigate with your tools before rewriting: ${surfaces.join(", ")}. This is read-only: do not post, send, schedule, create, modify, or connect anything.

The draft as it stands:
---
${draftBody}
---

What they want changed: ${question}

Reply with the complete replacement message and nothing else, no preamble and no explanation. Keep every factual claim the draft made unless they asked you to change it, and never invent a fact to fill a gap. Hold to the same voice:
${VOICE}`
}

// Posts we sent are not memories and their replies are not searchable, so the
// only way an operator can ask how one landed is if we hand it over.
function sentBlock(outcomes: Awaited<ReturnType<typeof recentDraftOutcomes>>) {
	if (!outcomes.length) return ""
	const lines = outcomes.map((o) => {
		const engagement = !o.engagementKnown
			? "engagement unknown, Slack could not be read"
			: [
					o.reactions.length
						? o.reactions.map((r) => `:${r.name}: x${r.count}`).join(" ")
						: "no reactions",
					o.replies.length
						? o.replies
								.map((r) => `"${r.text.replace(/\s+/g, " ")}"`)
								.join(" | ")
						: "no replies",
					o.repliesTruncated ? "(more replies not fetched)" : "",
				]
					.filter(Boolean)
					.join("; ")
		const when = o.sentAt
			? ` on ${new Date(o.sentAt).toISOString().slice(0, 16).replace("T", " ")}`
			: ""
		return `- to ${o.destination ?? "unknown"}${when}${o.targetLabel ? ` about ${o.targetLabel}` : ""}, opening "${o.opening}": ${engagement}`
	})
	return `\n\nPosts this workspace's proactive research has actually sent, and how they landed. This is the only record of them, so use it when asked how something we sent was received and do not go looking in memory. Match a question to a post by its subject or opening, and never read "engagement unknown" as no engagement:\n${lines.join("\n")}`
}

// Drafts waiting for review are neither memory nor Slack messages, so without
// this the agent cannot see the queue the operator is staring at.
function pendingBlock(
	drafts: ReturnType<typeof listAutoResearchDrafts>,
): string {
	if (!drafts.length) return ""
	const lines = drafts.map(
		(d) =>
			`- for ${d.destination ?? "unknown"}${d.targetLabel ? ` (${d.targetLabel})` : ""}: "${d.body.replace(/\s+/g, " ").slice(0, 200)}"`,
	)
	return `\n\nDrafts currently waiting for review in the console. If the operator asks about one of these, this is the only record of it, so do not go looking in memory. You can discuss or propose new wording for one, but you cannot change it: applying an edit is the operator's click on that card.\n${lines.join("\n")}`
}

function frame(
	question: string,
	actingAs: string | null,
	surfaces: string[],
	sent: string,
	pending: string,
): string {
	const who = actingAs
		? `You are answering as ${actingAs}'s view of this workspace, so their private context and personal connections are in scope.`
		: "You are answering from the workspace's shared context and org-shared connections."
	return `An internal Supermemory operator is asking about this workspace from an admin console. ${who}

The operator has scoped your memory to exactly these surfaces, so answer from them and say plainly when something falls outside: ${surfaces.join(", ")}.${sent}${pending}

Answer them directly and concretely, the way you would answer a colleague looking at the same data. Investigate with the tools you have rather than guessing, say plainly when something is not there, and never invent activity. This is read-only: do not post, send, schedule, create, modify, or connect anything. Your reply is shown only to the operator, never to anyone in the workspace, so skip the Slack niceties and just answer.

Keep it skimmable, because this is read in a narrow side panel. Lead with the answer in one or two sentences, then only as much detail as the question needs. Short paragraphs, a bulleted list when you are genuinely listing things, and bold on the occasional load-bearing fact. Don't pad, don't restate the question, and don't write a report when a few lines will do.

${question}`
}

// Only what we asked a tool, never what it returned: the operator sees the reply,
// and this is just the trail of how it got there.
function trailFrom(
	trace: Array<{ tool: string; input?: unknown }> | undefined,
): Array<{ tool: string; label: string }> {
	const seen = new Set<string>()
	const out: Array<{ tool: string; label: string }> = []
	for (const entry of trace ?? []) {
		const raw =
			typeof entry.input === "string"
				? entry.input
				: entry.input
					? Object.values(entry.input as Record<string, unknown>)
							.filter((v) => typeof v === "string" || typeof v === "number")
							.join(" · ")
					: ""
		const label = raw.slice(0, 140)
		const key = `${entry.tool}:${label}`
		if (seen.has(key)) continue
		seen.add(key)
		out.push({ tool: entry.tool, label })
	}
	return out.slice(0, 20)
}

export async function runAdminChat(
	agent: CompanyBrainAgent,
	input: AdminChatInput,
): Promise<AdminChatResult> {
	const question = input.question.trim()
	if (!question) return { ok: false, error: "question_required" }
	const org = await loadOrg(agent)
	if (!org) return { ok: false, error: "org_not_found" }

	const env = brainAgent(agent).env
	const slack = await loadOrgSlackContext(agent)

	// Resolve against the real surface list rather than trusting ids from the
	// caller: this decides which private channels and whose DMs get read.
	const available = await listBrainSurfaces(agent)
	const wanted = input.surfaceIds?.length
		? available.filter((s) => input.surfaceIds?.includes(s.id))
		: available.filter((s) => s.kind === "shared")
	if (!wanted.length) return { ok: false, error: "no_valid_surfaces" }
	const containerTags = wanted.map((s) => s.containerTag)

	// Personal connections belong to one identity, so they only open when exactly
	// one DM surface is selected. Any other combination reads as the org.
	const dmSurfaces = wanted.filter((s) => s.kind === "dm")
	const soleDm = dmSurfaces.length === 1 ? dmSurfaces[0] : undefined
	const person =
		soleDm?.userId && soleDm.slackUserId
			? {
					userId: soleDm.userId,
					slackUserId: soleDm.slackUserId,
					name: soleDm.label.replace(/^DM with /, ""),
				}
			: null

	const dmChannelId = person
		? await openSlackConversation(slack?.botToken ?? "", person.slackUserId)
		: undefined

	const actor = person
		? {
				orgId: org.id,
				userId: person.userId,
				personalConnectionsOnly: true,
				readOnly: true,
				memberLookup: "found" as const,
			}
		: {
				orgId: org.id,
				orgSharedOnly: true,
				readOnly: true,
				memberLookup: "found" as const,
			}

	const slackLookup: SlackLookupContext | undefined = slack
		? person && dmChannelId
			? {
					botToken: slack.botToken,
					channel: dmChannelId,
					teamId: slack.teamId,
					memoryScope: {
						kind: "dm",
						channelId: dmChannelId,
						userId: person.userId,
						slackUserId: person.slackUserId,
					},
					memoryContainerTags: containerTags,
				}
			: slack.channelId
				? {
						botToken: slack.botToken,
						channel: slack.channelId,
						teamId: slack.teamId,
						memoryScope: { kind: "shared", channelId: slack.channelId },
						memoryContainerTags: containerTags,
					}
				: undefined
		: undefined

	const history: ModelMessage[] = (input.history ?? [])
		.slice(-MAX_HISTORY_TURNS)
		.map((turn) => ({ role: turn.role, content: turn.content }))

	// A refine takes its target from the store, so a bad id cannot smuggle in text.
	const refining = input.refineDraftId
		? getAutoResearchDraft(agent, input.refineDraftId)
		: null
	if (input.refineDraftId && !refining)
		return { ok: false, error: "draft_not_found" }
	if (refining && refining.status !== "draft")
		return { ok: false, error: `draft_already_${refining.status}` }

	// Cheap when nothing has been sent; a handful of Slack reads when it has.
	// Refining works from the draft in hand, so it needs neither block.
	const outcomes = refining
		? []
		: await recentDraftOutcomes(agent, {
				// Shared surface covers channel sends; a person's DM replies need that
				// person's surface to have been selected.
				channel: wanted.some((s) => s.kind === "shared"),
				recipientUserIds: wanted.flatMap((s) =>
					s.kind === "dm" && s.userId ? [s.userId] : [],
				),
			}).catch(() => [])
	const pending = refining
		? []
		: listAutoResearchDrafts(agent, { status: "draft", limit: 10 })

	const traceId = generateId()
	const out = await computeTurn({
		agent,
		org,
		userId: person?.userId ?? slack?.installedByUserId ?? org.id,
		actor,
		question: refining
			? refineFrame(
					question,
					refining.body,
					refining.destination ?? "this workspace",
					wanted.map((s) => s.label),
				)
			: frame(
					question,
					person?.name ?? null,
					wanted.map((s) => s.label),
					sentBlock(outcomes),
					pendingBlock(pending),
				),
		threadText: "",
		conversationMessages: history.length ? history : undefined,
		slackLookup,
		asker: person ? { slackUserId: person.slackUserId } : undefined,
		// Same posture as an automation: read-only, no scheduling, no approvals.
		scheduledRun: true,
		skipBilling: true,
		// Borrowed context: leave nothing behind in the workspace's own threads.
		ephemeral: true,
		// An operator is waiting on this, and it is a lookup rather than a hard
		// reasoning problem: default high effort just makes them stare at a spinner.
		effortOverride: "low",
		obs: { traceId, source: "api" },
		env,
	})
	if (out.status !== "completed") return { ok: false, error: out.status }

	console.log(
		`[company-brain] admin chat org=${org.id} scope=${person ? "person" : "org_shared"} surfaces=${wanted.length} trace=${traceId}`,
	)
	const reply = out.reply.trim()
	return {
		ok: true,
		reply,
		scope: person ? "person" : "org_shared",
		actingAs: person?.name ?? null,
		surfaces: wanted.map((s) => s.label),
		...(refining ? { proposedBody: houseStyle(stripScaffolding(reply)) } : {}),
		trail: trailFrom(out.toolTrace),
	}
}
