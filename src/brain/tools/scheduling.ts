import { generateId } from "@repo/lib/generate-id"
import type { Schedule } from "agents"
import { decryptToken } from "@/lib/crypto"
import { orgCanRunCompanyBrain } from "@/lib/payments/company-brain-entitlement"
import type { SlackMemoryScope } from "../memory"
import {
	type BrainObservabilityInput,
	flushBrainTelemetry,
} from "../observability"
import { openSlackConversation, postSlackReply } from "../slack/client"
import { isDirectSlackChannel } from "../slack/events"
import { recordMessageTrace } from "../slack/message-trace"
import { createSlackReplyReferenceResolver } from "../slack/references"
import { resolveScheduledSlackThreadTs } from "../slack/routing"
import { getWorkspaceByTeamId } from "../slack/workspace"
import { computeTurn } from "../turn"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { assessAutomationConnections } from "./automation-connections"

export const SCHEDULE_CALLBACK = "runScheduledTask" as const

export function scheduleNextRunIso(timeSeconds: number): string {
	return new Date(timeSeconds * 1000).toISOString()
}

export type ScheduledTaskPayload = {
	teamId: string
	channel: string
	channelName?: string
	instruction: string
	label: string
	threadTs?: string
	creatorUserId?: string
	creatorSlackUserId?: string
	deliverTo?: "origin" | "dm" | "channel"
	memoryScope?: SlackMemoryScope
	relatedSlackUserIds?: string[]
	scheduledWhen?: ScheduleWhen
	kind?: "reminder" | "digest"
	personalConnectionsOnly?: boolean
	// Cadence, derived from the cron; drives the heading + lookback window.
	cadence?: "daily" | "weekly"
	// Heading for the posted message; falls back to the cadence digest heading.
	title?: string
	// Read strictly org-shared connections (no creator personal creds).
	orgSharedOnly?: boolean
	// Block all MCP writes for this run (automations are read-only).
	readOnly?: boolean
	// Automation identity for observability (set for automation-backed runs).
	automationId?: string
	runTrigger?: "scheduled" | "run_now"
}

import { derivedScheduleFields } from "./schedule-derive"

export { cronToCadence, derivedScheduleFields } from "./schedule-derive"

export type ScheduleWhen =
	| { kind: "at"; iso: string }
	| { kind: "in"; delaySeconds: number }
	| { kind: "cron"; cron: string }

export function resolveWhen(when: ScheduleWhen): Date | number | string {
	switch (when.kind) {
		case "at":
			return new Date(when.iso)
		case "in":
			return when.delaySeconds
		case "cron":
			return when.cron
	}
}

export async function scheduleBrainTask(
	agent: CompanyBrainAgent,
	when: ScheduleWhen,
	payload: ScheduledTaskPayload,
): Promise<Schedule<ScheduledTaskPayload>> {
	return agent.schedule(resolveWhen(when), SCHEDULE_CALLBACK, payload)
}

function uniqueSlackIds(ids: Array<string | undefined>): string[] {
	return [
		...new Set(
			ids.map((id) => id?.trim()).filter((id): id is string => Boolean(id)),
		),
	]
}

export function normalizeRelatedSlackUserIds(
	ids: Array<string | undefined>,
	ownerSlackUserId?: string,
): string[] {
	return uniqueSlackIds(ids).filter((id) => id !== ownerSlackUserId)
}

function hasReminderPayloadShape(
	payload: ScheduledTaskPayload | undefined,
): payload is ScheduledTaskPayload {
	return Boolean(
		payload?.teamId && payload.channel && payload.instruction && payload.label,
	)
}

export function isManageableReminderSchedule(
	schedule: Schedule<ScheduledTaskPayload>,
): boolean {
	return (
		schedule.callback === SCHEDULE_CALLBACK &&
		hasReminderPayloadShape(schedule.payload) &&
		!schedule.payload.automationId
	)
}

export function scheduleRelationship(
	payload: ScheduledTaskPayload,
	requesterSlackUserId: string | undefined,
): "creator" | "related" | null {
	if (!requesterSlackUserId) return null
	if (payload.creatorSlackUserId === requesterSlackUserId) return "creator"
	if (payload.relatedSlackUserIds?.includes(requesterSlackUserId)) {
		return "related"
	}
	return null
}

export function listBrainTasksCreatedBy(
	agent: CompanyBrainAgent,
	creatorSlackUserId: string | undefined,
): Schedule<ScheduledTaskPayload>[] {
	if (!creatorSlackUserId) return []
	return agent
		.getSchedules<ScheduledTaskPayload>()
		.filter(
			(s) =>
				isManageableReminderSchedule(s) &&
				s.payload.creatorSlackUserId === creatorSlackUserId,
		)
}

export function listBrainTasks(
	agent: CompanyBrainAgent,
	requesterSlackUserId: string | undefined,
): Schedule<ScheduledTaskPayload>[] {
	if (!requesterSlackUserId) return []
	return agent
		.getSchedules<ScheduledTaskPayload>()
		.filter(
			(s) =>
				isManageableReminderSchedule(s) &&
				scheduleRelationship(s.payload, requesterSlackUserId) !== null,
		)
}

export async function cancelBrainTask(
	agent: CompanyBrainAgent,
	id: string,
	requesterSlackUserId: string | undefined,
): Promise<boolean> {
	const cancellable = agent
		.getSchedules<ScheduledTaskPayload>()
		.some(
			(schedule) =>
				schedule.id === id &&
				isManageableReminderSchedule(schedule) &&
				scheduleRelationship(schedule.payload, requesterSlackUserId) !== null,
		)
	if (!cancellable) return false
	return agent.cancelSchedule(id)
}

export type ReplaceBrainTaskChanges = {
	when?: ScheduleWhen
	payload?: Partial<
		Pick<
			ScheduledTaskPayload,
			| "instruction"
			| "label"
			| "deliverTo"
			| "channel"
			| "channelName"
			| "threadTs"
			| "memoryScope"
			| "relatedSlackUserIds"
		>
	>
}

export type ReplaceBrainTaskRequester = {
	slackUserId?: string
}

export type ReplaceBrainTaskResult =
	| {
			replaced: true
			oldId: string
			schedule: Schedule<ScheduledTaskPayload>
	  }
	| {
			replaced: false
			error:
				| "not_found"
				| "creator_only"
				| "missing_requester"
				| "missing_timing"
				| "schedule_failed"
				| "cancel_failed"
	  }

function preservedScheduleWhen(
	schedule: Schedule<ScheduledTaskPayload>,
): ScheduleWhen | undefined {
	const stored = schedule.payload.scheduledWhen
	if (!stored) return undefined
	if (stored.kind === "in") {
		return { kind: "at", iso: scheduleNextRunIso(schedule.time) }
	}
	return stored
}

export async function replaceBrainTask(
	agent: CompanyBrainAgent,
	id: string,
	requester: ReplaceBrainTaskRequester,
	changes: ReplaceBrainTaskChanges,
): Promise<ReplaceBrainTaskResult> {
	if (!requester.slackUserId)
		return { replaced: false, error: "missing_requester" }
	const existing = agent
		.getSchedules<ScheduledTaskPayload>()
		.find((schedule) => schedule.id === id)
	if (!existing || !isManageableReminderSchedule(existing)) {
		return { replaced: false, error: "not_found" }
	}
	const relationship = scheduleRelationship(
		existing.payload,
		requester.slackUserId,
	)
	if (relationship === null) return { replaced: false, error: "not_found" }
	if (relationship !== "creator") {
		return { replaced: false, error: "creator_only" }
	}

	const when = changes.when ?? preservedScheduleWhen(existing)
	if (!when) return { replaced: false, error: "missing_timing" }

	const relatedSlackUserIds = normalizeRelatedSlackUserIds(
		changes.payload?.relatedSlackUserIds ??
			existing.payload.relatedSlackUserIds ??
			[],
		existing.payload.creatorSlackUserId,
	)
	const merged = { ...existing.payload, ...changes.payload }
	const payload: ScheduledTaskPayload = {
		...merged,
		...derivedScheduleFields({
			when,
			kind: merged.kind,
			deliverTo: merged.deliverTo,
		}),
		creatorUserId: existing.payload.creatorUserId,
		creatorSlackUserId: existing.payload.creatorSlackUserId,
		relatedSlackUserIds,
		scheduledWhen: when,
	}

	let replacement: Schedule<ScheduledTaskPayload>
	try {
		replacement = await scheduleBrainTask(agent, when, payload)
	} catch {
		return { replaced: false, error: "schedule_failed" }
	}

	let cancelled = false
	try {
		cancelled = await agent.cancelSchedule(id)
	} catch {
		cancelled = false
	}
	if (!cancelled) {
		await agent.cancelSchedule(replacement.id).catch(() => false)
		return { replaced: false, error: "cancel_failed" }
	}

	return {
		replaced: true,
		oldId: id,
		schedule: replacement,
	}
}

export async function runScheduledTask(
	agent: CompanyBrainAgent,
	payload: ScheduledTaskPayload,
	schedule: Schedule<ScheduledTaskPayload>,
): Promise<void> {
	// PostHog capture is fire-and-forget; flush before the DO alarm isolate freezes.
	try {
		await runScheduledTaskInner(agent, payload, schedule)
	} finally {
		await flushBrainTelemetry()
	}
}

async function runScheduledTaskInner(
	agent: CompanyBrainAgent,
	payload: ScheduledTaskPayload,
	schedule: Schedule<ScheduledTaskPayload>,
): Promise<void> {
	const env = brainAgent(agent).env
	const ws = await getWorkspaceByTeamId(env, payload.teamId)
	if (!ws) {
		console.warn(
			`[company-brain] scheduled task ${schedule.id} cancelled: workspace gone team=${payload.teamId} expectedOrg=${agent.name}`,
		)
		await agent.cancelSchedule(schedule.id)
		return
	}
	// Cross-tenant: the task nearly ran against another org. Keep this at error
	// level so it stays distinguishable from a routine uninstall.
	if (ws.orgId !== agent.name) {
		console.error(
			`[company-brain] scheduled task ${schedule.id} cancelled: workspace rebound team=${payload.teamId} scheduledOrg=${agent.name} currentOrg=${ws.orgId}`,
		)
		await agent.cancelSchedule(schedule.id)
		return
	}

	const org = {
		id: ws.orgId,
		name: ws.orgName,
		slug: ws.orgSlug,
		metadata: ws.orgMetadata,
	}
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	const actor = {
		orgId: org.id,
		userId: payload.creatorUserId,
		personalConnectionsOnly: payload.personalConnectionsOnly ?? true,
		orgSharedOnly: payload.orgSharedOnly,
		readOnly: payload.readOnly,
		// Automation runs are created by a confirmed org member, so treat them as
		// members even without a resolved Slack id — otherwise scheduled channel
		// digests get denied cross-channel search. Plain reminders keep the
		// resolved-id behavior.
		memberLookup:
			payload.automationId || payload.creatorSlackUserId
				? ("found" as const)
				: undefined,
	}

	const dm = payload.deliverTo === "dm"
	const target = dm
		? await openSlackConversation(botToken, payload.creatorSlackUserId ?? "")
		: payload.channel
	if (!target) {
		console.warn(
			`[company-brain] scheduled task ${schedule.id} dropped: no delivery target deliverTo=${payload.deliverTo ?? "origin"} slackUser=${payload.creatorSlackUserId ?? "-"}`,
		)
		return
	}
	const directDelivery = isDirectSlackChannel(target)
	console.log(
		`[company-brain] scheduled task ${schedule.id} fire org=${org.id} deliverTo=${payload.deliverTo ?? "origin"} target=${target} label="${payload.label}"`,
	)

	const cadence = payload.cadence ?? "daily"
	const window = cadence === "weekly" ? "last 7 days" : "last 24 hours"
	const heading =
		payload.title ?? `${cadence === "weekly" ? "Weekly" : "Daily"} Digest`
	const framed =
		payload.kind === "digest"
			? `Produce the scheduled update "${heading}" to post to the team now. Cover activity from the ${window} only. Start your reply with the heading "${heading}", then follow this instruction:\n\n${payload.instruction}\n\nThis is read-only: do NOT create, modify, comment, post, send, or connect anything — only read and summarize. Your reply text is posted to the channel automatically.`
			: `A scheduled reminder you set earlier is now due. Write the message to deliver — your reply text is posted to Slack automatically, so do NOT use any tool to post, send, or connect Slack. Just produce the reminder itself.\n\nReminder: ${payload.instruction}`

	const traceId = generateId()
	const obs: BrainObservabilityInput = {
		traceId,
		source: payload.automationId ? "automation" : "scheduled_reminder",
		channel: dm ? undefined : payload.channel,
		automationId: payload.automationId,
		automationTitle: payload.title,
		automationCadence: cadence,
		deliverTo: payload.deliverTo,
		runTrigger: payload.runTrigger ?? "scheduled",
	}

	// DM digests post to the owner's DM, so scope reads to that DM surface;
	// otherwise the run resolves as a public channel and search_slack_channels
	// rejects the owner's private-channel reads. Channel digests keep their scope.
	const memoryScope: SlackMemoryScope | undefined =
		dm && payload.creatorSlackUserId
			? { kind: "dm", channelId: target, userId: payload.creatorSlackUserId }
			: payload.memoryScope

	// Alarms outlive the trial: block spend once entitlement lapses.
	if (
		!(await orgCanRunCompanyBrain(brainAgent(agent).env, org.id, (promise) =>
			agent.waitUntil(promise),
		))
	) {
		console.log(
			`[company-brain] scheduled task ${schedule.id} blocked: entitlement org=${org.id}`,
		)
		return
	}

	const out = await computeTurn({
		agent,
		org,
		userId: payload.creatorUserId ?? ws.installedByUserId ?? ws.orgId,
		actor,
		question: framed,
		threadText: "",
		slackLookup: {
			botToken,
			channel: target,
			teamId: payload.teamId,
			memoryScope,
		},
		asker: payload.creatorSlackUserId
			? { slackUserId: payload.creatorSlackUserId }
			: undefined,
		scheduledRun: true,
		obs,
		env,
	})

	if (out.status !== "completed") {
		console.warn(
			`[company-brain] scheduled task ${schedule.id} did not complete status=${out.status}`,
		)
		return
	}
	let reply = await createSlackReplyReferenceResolver({
		env,
		teamId: payload.teamId,
		botToken,
	})(out.reply)
	// Run-time honesty: name apps this channel automation can't use so a thin
	// digest explains itself instead of looking broken.
	if (
		payload.kind === "digest" &&
		payload.deliverTo === "channel" &&
		payload.creatorUserId
	) {
		const { warnings } = await assessAutomationConnections(
			env,
			org.id,
			payload.creatorUserId,
			"channel",
		).catch(() => ({ warnings: [] }))
		if (warnings.length) {
			const apps = warnings.map((w) => w.app).join(", ")
			reply += `\n\n_${apps} ${warnings.length === 1 ? "is" : "are"} only connected personally, so this automation can't use ${warnings.length === 1 ? "it" : "them"}. Share the connection with the workspace in supermemory settings to include ${warnings.length === 1 ? "it" : "them"}._`
		}
	}
	// Channel destinations post as a new root; DMs use the unified agent_view
	// helper so scheduled DMs don't continue an old thread.
	const deliveryThreadTs =
		payload.deliverTo === "channel"
			? undefined
			: resolveScheduledSlackThreadTs(directDelivery, payload.threadTs)

	const ts = await postSlackReply(botToken, target, reply, deliveryThreadTs)
	if (ts) {
		recordMessageTrace(agent, target, ts, traceId, deliveryThreadTs)
		console.log(
			`[company-brain] scheduled task ${schedule.id} posted ts=${ts} target=${target} trace=${traceId} replyChars=${reply.length}`,
		)
	} else {
		console.warn(
			`[company-brain] scheduled task ${schedule.id} post produced no message target=${target} replyChars=${reply.length}`,
		)
	}
}
