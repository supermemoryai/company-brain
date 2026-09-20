import { decryptToken } from "@/lib/crypto"
import {
	COMPANY_BRAIN_TRIAL_REMINDER_DAYS,
	type CompanyBrainTrialReminderDay,
	markBrainTrialReminderSent,
	shouldSendBrainTrialReminder,
} from "@/lib/payments/company-brain-trial"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { openSlackConversation, postSlackMessage } from "./client"
import { getWorkspaceByTeamId } from "./workspace"

export type TrialReminderArm = {
	teamId: string
	installerSlackUserId: string
	trialStartedAtMs: number
}

export type TrialReminderPayload = {
	day: CompanyBrainTrialReminderDay
	teamId: string
	installerSlackUserId: string
}

const PLAN_CHOICE =
	"• *Max*: $100/mo, $130 of credits, unlimited seats\n" +
	"• *Scale*: $399/mo, $600 of credits, plus GitHub, S3 and Web Crawler"

/** Aggregate metered usage on the account, not trial-scoped. State it plainly. */
function usageLine(creditsUsed: number | undefined): string {
	if (creditsUsed == null) return ""
	return `Your team has used *$${Math.round(creditsUsed)}* of credits so far.\n`
}

function reminderCopy(
	day: CompanyBrainTrialReminderDay,
	activateUrl: string,
	creditsUsed?: number,
): string {
	const opening =
		day === 12
			? "Friendly heads-up: your *Company Brain* trial ends in about *2 days*.\n"
			: day === 15
				? "Your *Company Brain* trial has ended.\n"
				: "It's been 3 days since your *Company Brain* trial ended, and I'm still on pause.\n"
	const closing =
		day === 12
			? "Pick a plan to keep me in your workspace without interruption.\n"
			: "Pick a plan and I'll pick up where we left off.\n"
	return (
		opening +
		usageLine(creditsUsed) +
		closing +
		`${PLAN_CHOICE}\n` +
		`→ <${activateUrl}|Choose a plan>`
	)
}

function ensureTrialReminderArmTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_trial_reminder_arm (
			arm_key TEXT NOT NULL,
			day INTEGER NOT NULL,
			armed_at INTEGER NOT NULL,
			PRIMARY KEY (arm_key, day)
		)
	`
}

/** Idempotent per (team, trial start) — every OAuth callback carries historical trial metadata. */
export async function armCompanyBrainTrialReminders(
	agent: CompanyBrainAgent,
	payload: TrialReminderArm,
): Promise<void> {
	ensureTrialReminderArmTable(agent)
	const armKey = `${payload.teamId}:${payload.trialStartedAtMs}`
	const now = Date.now()
	const armed: CompanyBrainTrialReminderDay[] = []

	for (const day of COMPANY_BRAIN_TRIAL_REMINDER_DAYS) {
		const claimed = agent.sql<{ day: number }>`
			INSERT INTO brain_trial_reminder_arm (arm_key, day, armed_at)
			VALUES (${armKey}, ${day}, ${now})
			ON CONFLICT (arm_key, day) DO NOTHING
			RETURNING day
		`[0]
		if (!claimed) continue

		const fireAtMs = payload.trialStartedAtMs + day * 24 * 60 * 60 * 1000
		const delaySeconds = Math.max(1, Math.floor((fireAtMs - now) / 1000))
		try {
			await agent.schedule(delaySeconds, "runCompanyBrainTrialReminder", {
				day,
				teamId: payload.teamId,
				installerSlackUserId: payload.installerSlackUserId,
			} satisfies TrialReminderPayload)
			armed.push(day)
		} catch (error) {
			agent.sql`
				DELETE FROM brain_trial_reminder_arm
				WHERE arm_key = ${armKey} AND day = ${day}
			`
			console.warn(
				`[company-brain-trial] arm day=${day} failed org=${agent.name} team=${payload.teamId}:`,
				error instanceof Error ? error.message : error,
			)
		}
	}

	if (armed.length > 0) {
		console.log(
			`[company-brain-trial] armed reminders org=${agent.name} team=${payload.teamId} days=${armed.join(",")}`,
		)
	}
}

export async function runCompanyBrainTrialReminder(
	agent: CompanyBrainAgent,
	payload: TrialReminderPayload,
): Promise<void> {
	try {
		const env = brainAgent(agent).env
		const decision = await shouldSendBrainTrialReminder(
			env,
			agent.name,
			payload.day,
		)
		if (!decision.send) return

		const slackUserId =
			decision.installerSlackUserId ?? payload.installerSlackUserId
		if (!slackUserId) return

		const ws = await getWorkspaceByTeamId(env, payload.teamId)
		if (!ws?.botTokenEnc) return
		const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
		const channel = await openSlackConversation(botToken, slackUserId)
		if (!channel) return

		await postSlackMessage(
			botToken,
			channel,
			reminderCopy(payload.day, decision.activateUrl, decision.creditsUsed),
		)
		await markBrainTrialReminderSent(env, agent.name, payload.day)
		console.log(
			`[company-brain-trial] reminder day=${payload.day} org=${agent.name} user=${slackUserId}`,
		)
	} catch (error) {
		console.warn(
			`[company-brain-trial] reminder day=${payload.day} failed:`,
			error,
		)
	}
}
