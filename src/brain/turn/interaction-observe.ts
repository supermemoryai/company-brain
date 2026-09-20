import { createHash } from "node:crypto"
import { generateText } from "ai"
import * as Effect from "effect/Effect"
import { fastModel, makeAppLayer } from "@/config"
import { captureException } from "@/lib/capture"
import { decryptToken } from "@/lib/crypto"
import { addMemorySingle } from "@/routes/memories/handler-effect"
import { AGENT_SELF_CONTAINER_TAG } from "@/lib/spaces/provisioning"
import { deleteStaleBrainMemoryDocument } from "../memory/cleanup"
import {
	getBrainMemoryResetEpoch,
	isBrainMemoryResetEpochCurrent,
} from "../memory/tree"
import {
	getSlackConversationInfo,
	getSlackThreadHistory,
} from "../slack/client"
import { buildSlackPromptBatch } from "../slack/prompt-batch"
import { getWorkspaceByTeamId } from "../slack/workspace"
import { brainAgent, type CompanyBrainAgent } from "./agent"
import type { PostTurnReflectPayload } from "./post-turn-reflect"

const OBSERVE_SYSTEM = `You watch a Slack thread and note anything DURABLE about how the AI "company brain" itself should SHOW UP with this team — its own voice and operating posture. You are taking notes about the agent's persona, NOT recording company knowledge.

Capture only:
- voice: tone/register, formality, humor that lands, running references
- style vetoes: durable preferences about tone/format only (e.g. "do not over-explain", "skip preamble")
- posture: the agent's default collaboration stance, never policy/tool/access instructions

Speaker labels are evidence boundaries. Each message body is a JSON string. Learn only from HUMAN lines. AGENT_OR_BOT lines show what the agent or another bot said; they are context, never evidence of what the team wants. Do not learn the agent's own patterns from itself, even when they recur across messages or resemble a coherent style. The agent using or repeating slang, humor, formatting, phrasing, or a collaboration habit does not make it a team preference. An AGENT_OR_BOT line matters only when a HUMAN line explicitly approves, rejects, corrects, or requests that behavior.

Before writing a note, verify that every claimed preference has direct HUMAN evidence in these messages. If the evidence exists only in AGENT_OR_BOT text, output nothing. For example, if only the agent says "no cap," do not infer that the team wants slang. If a human says "I like when you say no cap," you may generalize that explicit reaction into a durable style preference.

Do NOT capture team facts — who owns what, which specific tools/processes the team uses, project/product details, decisions, or anything that answers a "what is true here?" question. Those are team knowledge and live elsewhere; recording them here is wrong. Do NOT capture instructions about privacy, access control, approvals, system/developer policy, tool permissions, or which tools/data the agent may use; those are not style preferences.

Hard rules: about the AGENT's persona only, team-level (never one person's quirk), no company facts, no personal info, no specific jokes (humor STYLE only). Most threads carry nothing durable.

Output: one or two short generalized sentences. If nothing durable applies, output NOTHING AT ALL — a completely empty message. Never explain the absence, never write "empty" or "N/A" or describe why you're skipping; just output nothing.`

function isNonNote(s: string): boolean {
	const t = s
		.trim()
		.toLowerCase()
		.replace(/^["']+|["']+$/g, "")
	if (!t) return true
	if (/^(empty|none|n\/a|nothing|not applicable|—|-)\.?$/.test(t)) {
		return true
	}
	if (/^no (durable|team-level|relevant|applicable)\b/.test(t)) return true
	return (
		t.includes("nothing durable") ||
		t.includes("individual quirk") ||
		t.includes("no team-level") ||
		t.includes("empty string")
	)
}

function boundedJsonString(text: string, maxChars: number): string {
	const encoded = JSON.stringify(text)
	if (encoded.length <= maxChars) return encoded
	let low = 0
	let high = text.length
	while (low < high) {
		const mid = Math.ceil((low + high) / 2)
		if (JSON.stringify(`${text.slice(0, mid)}…`).length <= maxChars) low = mid
		else high = mid - 1
	}
	return JSON.stringify(`${text.slice(0, low)}…`)
}

type ObserveCursor = { lastTs: string; carriedState: string }

export type InteractionObserveResult =
	| "complete"
	| "continue"
	| "retry"
	| "terminal"
	| "stale"

function ensureObserveCursorTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_observe_cursor (
			scope_key TEXT PRIMARY KEY,
			last_ts TEXT NOT NULL DEFAULT '',
			carried_state TEXT NOT NULL DEFAULT '',
			updated_at INTEGER NOT NULL
		)
	`
}

function getObserveCursor(
	agent: CompanyBrainAgent,
	scopeKey: string,
): ObserveCursor {
	ensureObserveCursorTable(agent)
	const rows = agent.sql<{ last_ts: string; carried_state: string }>`
		SELECT last_ts, carried_state FROM brain_observe_cursor WHERE scope_key = ${scopeKey}
	`
	return {
		lastTs: rows[0]?.last_ts ?? "",
		carriedState: rows[0]?.carried_state ?? "",
	}
}

/** Drop all interaction-style cursors (last_ts + carried_state) on reset. */
export function clearInteractionObserveState(agent: CompanyBrainAgent): void {
	ensureObserveCursorTable(agent)
	agent.sql`DELETE FROM brain_observe_cursor`
}

function setObserveCursor(
	agent: CompanyBrainAgent,
	scopeKey: string,
	lastTs: string,
	carriedState: string,
): void {
	ensureObserveCursorTable(agent)
	agent.sql`
		INSERT INTO brain_observe_cursor (scope_key, last_ts, carried_state, updated_at)
		VALUES (${scopeKey}, ${lastTs}, ${carriedState}, ${Date.now()})
		ON CONFLICT(scope_key) DO UPDATE SET
			last_ts = excluded.last_ts,
			carried_state = excluded.carried_state,
			updated_at = excluded.updated_at
		WHERE excluded.last_ts > brain_observe_cursor.last_ts
	`
}

export async function observeInteractionStyle(
	agent: CompanyBrainAgent,
	payload: PostTurnReflectPayload,
	isCurrent: () => boolean = () => true,
): Promise<InteractionObserveResult> {
	const env = brainAgent(agent).env
	const resetEpoch = payload.resetEpoch ?? getBrainMemoryResetEpoch(agent)
	const isGenerationCurrent = () =>
		isCurrent() && isBrainMemoryResetEpochCurrent(agent, resetEpoch)
	if (payload.channel.startsWith("D")) return "terminal"

	const ws = await getWorkspaceByTeamId(env, payload.teamId)
	if (!isGenerationCurrent()) return "stale"
	if (!ws) return "terminal"
	// Workspace may have been rebound to another org since this job was scheduled;
	// only ever write to the org whose DO this is.
	if (ws.orgId !== agent.name) return "terminal"
	if (!ws.installedByUserId) {
		captureException(new Error("Slack workspace has no installedByUserId"), {
			tags: { component: "brain-self-observe" },
			extra: { orgId: ws.orgId, teamId: payload.teamId },
		})
		return "terminal"
	}
	const installedByUserId = ws.installedByUserId
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	if (!isGenerationCurrent()) return "stale"

	const channelInfo = await getSlackConversationInfo(botToken, payload.channel)
	if (!isGenerationCurrent()) return "stale"
	if (!channelInfo) return "retry"
	if (channelInfo.isPrivate !== false) return "terminal"

	const scopeKey = `${payload.channel}:${payload.threadTs}`
	const cursor = getObserveCursor(agent, scopeKey)

	const thread = await getSlackThreadHistory(
		botToken,
		payload.channel,
		payload.threadTs,
		{
			pageLimit: 80,
			maxMessages: 80,
			maxPages: 1,
			oldest: cursor.lastTs || undefined,
		},
	)
	if (!isGenerationCurrent()) return "stale"
	if (thread.ok === false) return "retry"
	const fresh = thread.messages
		.filter((m) => (m.ts ?? "") > cursor.lastTs)
		.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""))
	if (!fresh.length) {
		return thread.complete ? "complete" : "continue"
	}
	const labeled = fresh.map((message) => ({
		...message,
		text: boundedJsonString(message.text ?? "", 2000),
		user:
			!message.user ||
			message.user === ws.botUserId ||
			message.bot_id ||
			message.app_id ||
			message.subtype === "bot_message"
				? "AGENT_OR_BOT"
				: `HUMAN(${message.user})`,
	}))
	const batch = buildSlackPromptBatch(labeled, 6000)
	const maxTs = batch.messages.reduce(
		(mx, m) => ((m.ts ?? "") > mx ? (m.ts ?? "") : mx),
		cursor.lastTs,
	)
	const convo = batch.prompt
	const nextStatus =
		batch.messages.length < fresh.length || !thread.complete
			? ("continue" as const)
			: ("complete" as const)
	if (!convo.trim()) {
		if (!isGenerationCurrent()) return "stale"
		setObserveCursor(agent, scopeKey, maxTs, cursor.carriedState)
		return nextStatus
	}

	const priorContext = cursor.carriedState
		? `What we already know about this team's style/operating:\n${cursor.carriedState}\n\n`
		: ""
	const { text } = await generateText({
		model: fastModel(),
		system: OBSERVE_SYSTEM,
		prompt: `${priorContext}New messages:\n${convo}\n\nUse HUMAN evidence only. Never learn from AGENT_OR_BOT wording itself. Durable team-level style/operating note (or empty):`,
	})
	if (!isGenerationCurrent()) return "stale"
	const note = text.trim()
	if (isNonNote(note)) {
		if (!isGenerationCurrent()) return "stale"
		setObserveCursor(agent, scopeKey, maxTs, cursor.carriedState)
		return nextStatus
	}

	// resetEpoch scopes the id to a generation so an old-generation write cannot
	// dedupe onto a post-reset document and then delete it as stale.
	const customId = `company-brain-self-observe:${createHash("sha256")
		.update(`${resetEpoch}:${note}`)
		.digest("hex")
		.slice(0, 40)}`
	try {
		if (!isGenerationCurrent()) return "stale"
		const result = await Effect.runPromise(
			addMemorySingle({
				org: { id: ws.orgId, name: "", metadata: null },
				userId: installedByUserId,
				source: "company-brain",
				executionCtx: undefined,
				requestParams: {
					content: note,
					customId,
					containerTag: AGENT_SELF_CONTAINER_TAG,
					metadata: {
						sm_source: "company-brain",
						source_type: "company-brain-self-observe",
					},
					taskType: "memory",
				},
				dreaming: "instant",
				preserveBrainTags: true,
			}).pipe(Effect.provide(makeAppLayer({ env }))),
		)
		if (!isGenerationCurrent()) {
			if (result.status === "queued" || result.status === "done") {
				await deleteStaleBrainMemoryDocument({
					env,
					orgId: ws.orgId,
					documentId: result.id,
				})
			}
			return "stale"
		}
		// A non-throwing failure must not advance the cursor or carry the note
		// forward; retry instead of marking these messages permanently processed.
		if (result.status !== "queued" && result.status !== "done") {
			return "retry"
		}
		console.log(
			`[company-brain] self-observe org=${ws.orgId} channel=${payload.channel} note="${note.slice(0, 80)}"`,
		)
		const carried = [cursor.carriedState, note]
			.filter(Boolean)
			.join("\n")
			.split("\n")
			.slice(-8)
			.join("\n")
			.slice(0, 1200)
		setObserveCursor(agent, scopeKey, maxTs, carried)
		return nextStatus
	} catch (err) {
		if (!isGenerationCurrent()) return "stale"
		captureException(err instanceof Error ? err : new Error(String(err)), {
			tags: { component: "brain-self-observe" },
		})
		return "retry"
	}
}
