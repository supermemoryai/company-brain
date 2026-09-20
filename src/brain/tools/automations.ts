import type { Schedule } from "agents"
import { parseCronExpression } from "cron-schedule"
import { decryptToken } from "@/lib/crypto"
import { captureActivationRung } from "@/lib/posthog"
import { lookupSlackUserByEmail } from "../slack/client"
import {
	getWorkspaceTeamIdByOrgId,
	getWorkspaceTokenByOrgId,
} from "../slack/workspace"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import {
	cronToCadence,
	runScheduledTask,
	type ScheduledTaskPayload,
	scheduleBrainTask,
} from "./scheduling"

// Non-admins can own at most this many automations, to bound scheduled cost.
export const MEMBER_AUTOMATION_CAP = 20

// Automations are daily/weekly; reject anything firing more often than hourly.
const MIN_AUTOMATION_INTERVAL_SECONDS = 3600

function cronIntervalSeconds(cron: string): number | null {
	try {
		const sched = parseCronExpression(cron)
		const first = sched.getNextDate(new Date())
		const second = sched.getNextDate(first)
		return Math.round((second.getTime() - first.getTime()) / 1000)
	} catch {
		return null
	}
}

export const DEFAULT_AUTOMATION_PROMPT =
	"Summarize what's happened recently across the connected tools and channels: open items, unanswered questions, decisions, and anything the team should know. Keep it a short, scannable recap."

export type DeliverTo = "channel" | "dm"

export type AutomationInput = {
	title: string
	channelId?: string | null
	deliverTo?: DeliverTo
	prompt?: string | null
	cron: string
	timezone?: string | null
	enabled: boolean
}

export type Automation = {
	id: string
	enabled: boolean
	title: string
	channelId: string
	deliverTo: DeliverTo
	creatorSlackUserId: string | null
	prompt: string
	cron: string
	timezone: string | null
	scheduleId: string | null
	createdBy: string | null
	createdAt: number
	updatedAt: number
}

export class AutomationError extends Error {}

// Owner or admin only. Message is prefixed "forbidden" so the route maps it to 403.
function assertCanManage(
	a: Automation,
	userId: string,
	isAdmin: boolean,
): void {
	if (!isAdmin && a.createdBy !== userId)
		throw new AutomationError("forbidden: not your automation")
}

export function ensureAutomationTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_automation (
			id TEXT PRIMARY KEY,
			enabled INTEGER NOT NULL DEFAULT 1,
			title TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			deliver_to TEXT NOT NULL DEFAULT 'channel',
			creator_slack_user_id TEXT,
			prompt TEXT NOT NULL,
			cron TEXT NOT NULL,
			timezone TEXT,
			schedule_id TEXT,
			created_by TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`
	// Add columns for tables created before DM delivery existed.
	try {
		agent.sql`ALTER TABLE brain_automation ADD COLUMN deliver_to TEXT NOT NULL DEFAULT 'channel'`
	} catch {}
	try {
		agent.sql`ALTER TABLE brain_automation ADD COLUMN creator_slack_user_id TEXT`
	} catch {}
}

type AutomationRow = {
	id: string
	enabled: number
	title: string
	channel_id: string
	deliver_to: string | null
	creator_slack_user_id: string | null
	prompt: string
	cron: string
	timezone: string | null
	schedule_id: string | null
	created_by: string | null
	created_at: number
	updated_at: number
}

function rowToAutomation(row: AutomationRow): Automation {
	return {
		id: row.id,
		enabled: row.enabled === 1,
		title: row.title,
		channelId: row.channel_id,
		deliverTo: row.deliver_to === "dm" ? "dm" : "channel",
		creatorSlackUserId: row.creator_slack_user_id,
		prompt: row.prompt,
		cron: row.cron,
		timezone: row.timezone,
		scheduleId: row.schedule_id,
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

export function listAutomations(
	agent: CompanyBrainAgent,
	viewer: { userId: string; isAdmin: boolean },
): Automation[] {
	ensureAutomationTable(agent)
	const rows = viewer.isAdmin
		? agent.sql<AutomationRow>`
			SELECT id, enabled, title, channel_id, deliver_to, creator_slack_user_id, prompt, cron, timezone, schedule_id, created_by, created_at, updated_at
			FROM brain_automation ORDER BY created_at ASC
		`
		: agent.sql<AutomationRow>`
			SELECT id, enabled, title, channel_id, deliver_to, creator_slack_user_id, prompt, cron, timezone, schedule_id, created_by, created_at, updated_at
			FROM brain_automation WHERE created_by = ${viewer.userId} ORDER BY created_at ASC
		`
	return rows.map(rowToAutomation)
}

export function getAutomation(
	agent: CompanyBrainAgent,
	id: string,
): Automation | null {
	ensureAutomationTable(agent)
	const rows = agent.sql<AutomationRow>`
		SELECT id, enabled, title, channel_id, deliver_to, creator_slack_user_id, prompt, cron, timezone, schedule_id, created_by, created_at, updated_at
		FROM brain_automation WHERE id = ${id}
	`
	return rows[0] ? rowToAutomation(rows[0]) : null
}

type Validated = {
	title: string
	channelId: string
	deliverTo: DeliverTo
	prompt: string
	cron: string
	timezone: string | null
}

function validate(input: AutomationInput): Validated {
	const deliverTo: DeliverTo = input.deliverTo === "dm" ? "dm" : "channel"
	const title = input.title?.trim()
	const cron = input.cron?.trim()
	const channelId = input.channelId?.trim() ?? ""
	if (!title) throw new AutomationError("title required")
	if (!cron) throw new AutomationError("cron required")
	const interval = cronIntervalSeconds(cron)
	if (interval === null) throw new AutomationError("invalid cron expression")
	if (interval < MIN_AUTOMATION_INTERVAL_SECONDS)
		throw new AutomationError(
			`cron fires too often (every ${interval}s); minimum is ${MIN_AUTOMATION_INTERVAL_SECONDS}s.`,
		)
	if (deliverTo === "channel" && !channelId)
		throw new AutomationError("channel required")
	return {
		title,
		channelId,
		deliverTo,
		prompt: input.prompt?.trim() || DEFAULT_AUTOMATION_PROMPT,
		cron,
		timezone: input.timezone?.trim() || null,
	}
}

// Resolve the automation owner's Slack user id (for DM delivery) from their email.
async function resolveSlackUser(
	agent: CompanyBrainAgent,
	email: string,
): Promise<string> {
	const env = brainAgent(agent).env
	const ws = await getWorkspaceTokenByOrgId(env, agent.name)
	if (!ws) throw new AutomationError("slack workspace not connected")
	const token = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	const uid = await lookupSlackUserByEmail(token, email)
	if (!uid)
		throw new AutomationError(
			"your Slack account isn't in this workspace — the email must match",
		)
	return uid
}

// Automations are read-only and org-scoped: they read only org-shared
// connections (never an individual's personal creds) and post one summary.
function automationPayload(
	teamId: string,
	v: Pick<Validated, "title" | "channelId" | "prompt" | "cron" | "deliverTo">,
	creatorUserId: string,
	slackUserId: string | null,
	automationId: string,
	runTrigger: "scheduled" | "run_now" = "scheduled",
): ScheduledTaskPayload {
	return {
		teamId,
		channel: v.channelId,
		instruction: v.prompt,
		label: v.title,
		title: v.title,
		deliverTo: v.deliverTo === "dm" ? "dm" : "channel",
		creatorUserId,
		creatorSlackUserId: slackUserId ?? undefined,
		kind: "digest",
		cadence: cronToCadence(v.cron),
		// DM goes only to the owner, so its own personal connections are safe to
		// read when no org-shared one exists; channel posts stay org-shared only.
		personalConnectionsOnly: false,
		orgSharedOnly: v.deliverTo !== "dm",
		readOnly: true,
		automationId,
		runTrigger,
	}
}

async function armSchedule(
	agent: CompanyBrainAgent,
	v: Validated,
	creatorUserId: string,
	slackUserId: string | null,
	automationId: string,
): Promise<string> {
	const env = brainAgent(agent).env
	const teamId = await getWorkspaceTeamIdByOrgId(env, agent.name)
	if (!teamId) throw new AutomationError("slack workspace not connected")
	const scheduled = await scheduleBrainTask(
		agent,
		{ kind: "cron", cron: v.cron },
		automationPayload(teamId, v, creatorUserId, slackUserId, automationId),
	)
	return scheduled.id
}

export async function createAutomation(
	agent: CompanyBrainAgent,
	input: AutomationInput,
	creatorUserId: string,
	creatorEmail: string,
	isAdmin: boolean,
): Promise<Automation> {
	ensureAutomationTable(agent)
	if (!isAdmin) {
		const mine = agent.sql<{ n: number }>`
			SELECT COUNT(*) AS n FROM brain_automation WHERE created_by = ${creatorUserId}
		`
		if ((mine[0]?.n ?? 0) >= MEMBER_AUTOMATION_CAP)
			throw new AutomationError(
				`automation limit reached (${MEMBER_AUTOMATION_CAP} per member)`,
			)
	}
	const v = validate(input)
	const slackUserId =
		v.deliverTo === "dm" ? await resolveSlackUser(agent, creatorEmail) : null
	const id = crypto.randomUUID()
	const now = Date.now()
	// Insert disabled first, then arm and flip to enabled only once the schedule
	// id is persisted. A failed insert can't orphan a live schedule, and a failed
	// arm rolls the row back so we never leave an enabled row with no schedule.
	agent.sql`
		INSERT INTO brain_automation
			(id, enabled, title, channel_id, deliver_to, creator_slack_user_id, prompt, cron, timezone, schedule_id, created_by, created_at, updated_at)
		VALUES (${id}, ${0}, ${v.title}, ${v.channelId}, ${v.deliverTo}, ${slackUserId}, ${v.prompt}, ${v.cron}, ${v.timezone}, ${null}, ${creatorUserId}, ${now}, ${now})
	`
	if (input.enabled) {
		let scheduleId: string
		try {
			scheduleId = await armSchedule(agent, v, creatorUserId, slackUserId, id)
		} catch (err) {
			agent.sql`DELETE FROM brain_automation WHERE id = ${id}`
			throw err
		}
		try {
			agent.sql`UPDATE brain_automation SET enabled = ${1}, schedule_id = ${scheduleId} WHERE id = ${id}`
		} catch (err) {
			// Persisting the pointer failed; cancel the live schedule so it can't orphan.
			await agent.cancelSchedule(scheduleId).catch(() => {})
			agent.sql`DELETE FROM brain_automation WHERE id = ${id}`
			throw err
		}
	}
	const saved = getAutomation(agent, id)
	if (!saved) throw new AutomationError("failed to persist automation")
	// A disabled automation was never armed, so it isn't a granted rung.
	if (saved.enabled) {
		captureActivationRung({
			orgId: agent.name,
			userId: creatorUserId,
			rung: "digest",
			source: "automation",
			detail: { deliver_to: saved.deliverTo },
		})
	}
	return saved
}

// Arm the new schedule before cancelling the old so a failed sync leaves prior state intact.
export async function updateAutomation(
	agent: CompanyBrainAgent,
	id: string,
	input: AutomationInput,
	userId: string,
	editorEmail: string,
	isAdmin: boolean,
): Promise<Automation> {
	const existing = getAutomation(agent, id)
	if (!existing) throw new AutomationError("automation not found")
	assertCanManage(existing, userId, isAdmin)
	const v = validate(input)
	// Keep the owner's stored DM target. Resolve fresh only when the editor is the
	// owner — an admin must not bind another member's DM from their own email.
	let slackUserId: string | null = null
	if (v.deliverTo === "dm") {
		slackUserId = existing.creatorSlackUserId
		if (!slackUserId) {
			if (existing.createdBy && existing.createdBy !== userId)
				throw new AutomationError(
					"only the owner can switch this automation to DM delivery",
				)
			slackUserId = await resolveSlackUser(agent, editorEmail)
		}
	}
	const scheduleId = input.enabled
		? await armSchedule(agent, v, existing.createdBy ?? userId, slackUserId, id)
		: null
	if (existing.scheduleId && existing.scheduleId !== scheduleId) {
		// If the old schedule can't be cancelled, don't overwrite the DB pointer —
		// that would leave the old job firing with no reference to cancel it. Roll
		// back the just-armed schedule and fail so prior state stays intact.
		try {
			await agent.cancelSchedule(existing.scheduleId)
		} catch {
			if (scheduleId) await agent.cancelSchedule(scheduleId).catch(() => {})
			throw new AutomationError(
				"couldn't cancel the previous schedule; automation left unchanged",
			)
		}
	}
	const now = Date.now()
	try {
		agent.sql`
			UPDATE brain_automation SET
				enabled = ${input.enabled ? 1 : 0},
				title = ${v.title},
				channel_id = ${v.channelId},
				deliver_to = ${v.deliverTo},
				creator_slack_user_id = ${slackUserId},
				prompt = ${v.prompt},
				cron = ${v.cron},
				timezone = ${v.timezone},
				schedule_id = ${scheduleId},
				updated_at = ${now}
			WHERE id = ${id}
		`
	} catch (err) {
		// Persist failed after the schedule swap; cancel the new job and clear the dead pointer.
		if (scheduleId) await agent.cancelSchedule(scheduleId).catch(() => {})
		try {
			agent.sql`UPDATE brain_automation SET enabled = ${0}, schedule_id = ${null} WHERE id = ${id}`
		} catch {}
		throw err
	}
	const saved = getAutomation(agent, id)
	if (!saved) throw new AutomationError("failed to persist automation")
	// Enabling an existing automation is the grant; re-editing a live one is not.
	if (saved.enabled && !existing.enabled) {
		captureActivationRung({
			orgId: agent.name,
			userId,
			rung: "digest",
			source: "automation",
			detail: { deliver_to: saved.deliverTo },
		})
	}
	return saved
}

export async function deleteAutomation(
	agent: CompanyBrainAgent,
	id: string,
	userId: string,
	isAdmin: boolean,
): Promise<void> {
	const existing = getAutomation(agent, id)
	if (!existing) return
	assertCanManage(existing, userId, isAdmin)
	if (existing.scheduleId)
		await agent.cancelSchedule(existing.scheduleId).catch(() => {})
	agent.sql`DELETE FROM brain_automation WHERE id = ${id}`
}

export async function runAutomationNow(
	agent: CompanyBrainAgent,
	id: string,
	userId: string,
	isAdmin: boolean,
): Promise<{ ok: boolean; reason?: string }> {
	const a = getAutomation(agent, id)
	if (!a) return { ok: false, reason: "automation not found" }
	assertCanManage(a, userId, isAdmin)
	if (a.deliverTo === "dm" && !a.creatorSlackUserId)
		return { ok: false, reason: "DM target not set — re-save the automation" }
	const env = brainAgent(agent).env
	const teamId = await getWorkspaceTeamIdByOrgId(env, agent.name)
	if (!teamId) return { ok: false, reason: "slack workspace not connected" }
	await runScheduledTask(
		agent,
		automationPayload(
			teamId,
			{
				title: a.title,
				channelId: a.channelId,
				prompt: a.prompt,
				cron: a.cron,
				deliverTo: a.deliverTo,
			},
			a.createdBy ?? userId,
			a.creatorSlackUserId,
			a.id,
			"run_now",
		),
		{ id: `automation-${id}` } as Schedule<ScheduledTaskPayload>,
	)
	return { ok: true }
}
