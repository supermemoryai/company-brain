import { db, eq } from "@repo/db"
import { organization } from "@repo/db/schema/auth"
import { isCompanyBrainOrg } from "@repo/lib/features"
import { decryptToken } from "@/lib/crypto"
import {
	getSlackUserInfo,
	lookupSlackUserByEmail,
	openSlackConversation,
	postSlackMessage,
} from "./client"
import { getWorkspaceTokenByOrgId } from "./workspace"

const DEFAULT_STARTERS = [
	"Catch me up on what I missed this week.",
	"What has the team decided recently, and who owns it?",
]

export type InstallGreetingParts = {
	firstName?: string | null
	companyName?: string | null
	homeChannelId?: string | null
	starters?: string[]
	trialActive?: boolean
}

// Deterministic skeleton so the voice never drifts; only the starters are generated.
export function installGreeting(parts: InstallGreetingParts = {}): string {
	const { firstName, companyName, homeChannelId, starters, trialActive } = parts
	const hi = firstName ? `Hey ${firstName},` : "Hey,"
	const home = homeChannelId ? `<#${homeChannelId}>` : "#company-brain"
	const subject = companyName ?? "your company"

	const picks = starters?.length ? starters : DEFAULT_STARTERS

	// Blank lines between every beat — Slack collapses tight blocks into a wall of text.
	const lines = [
		`${hi} thanks for bringing me on. 👋`,
		"",
		"I'm *Supermemory*, your company's brain. I keep track of what your team ships, decides, and discusses, so nobody has to dig for it.",
		"",
		"*Three ways to work with me*",
		"",
		"💬  *DM me here*",
		"Ask me anything, like a teammate who's read everything.",
		"",
		"📣  *@Supermemory in any channel*",
		"Mention me and I'll jump in with the whole thread as context.",
		"",
		"🔌  *Connect your tools*",
		"Linear, Notion, GitHub, Gmail and more, so I can answer from those too.",
		"",
		`📨  *Your team is joining ${home}*`,
		`I'm adding every full workspace member to ${home}, creating their Supermemory account, and sending each person a welcome DM. Guests and external members are excluded.`,
		"",
		`🔍  I'm reading up on ${subject} right now. I'll post what I learn in ${home} shortly.`,
		"",
	]

	if (trialActive) {
		lines.push(
			"⏳  You're on a *14-day free trial*. No credit card needed.",
			"",
		)
	}

	lines.push("*Try one of these — copy, paste, send:*", "")

	for (const starter of picks) lines.push(`>${starter}`, "")

	lines.push("Or just tell me what you need and I'll take it from there. 🚀")
	return lines.join("\n")
}

export function firstNameOf(name?: string): string | undefined {
	const first = name?.trim().split(/\s+/)[0]
	return first || undefined
}

export function memberGreeting(
	firstName?: string | null,
	org?: string | null,
): string {
	const hi = firstName ? `Hey ${firstName},` : "Hey,"
	const place = org ? ` to *${org}*` : ""
	return `${hi} welcome${place}. I'm Supermemory, I keep track of what the team's working on. Need to get up to speed? Just ask me anything.`
}

export async function orgWithBrain(
	env: Env,
	orgId: string,
): Promise<{ name: string | null; trialActive: boolean } | null> {
	const [row] = await db(env)
		.select({ name: organization.name, metadata: organization.metadata })
		.from(organization)
		.where(eq(organization.id, orgId))
		.limit(1)
	const metadata = row?.metadata as Record<string, unknown> | null
	// Not hasCompanyBrain: onboarding greets before Autumn attaches the add-on.
	if (!isCompanyBrainOrg({ metadata })) {
		return null
	}
	return {
		name: row?.name ?? null,
		trialActive: metadata?.brainTrialStatus === "active",
	}
}

async function dmSlackUser(
	botToken: string,
	slackUserId: string,
	text: string,
): Promise<void> {
	const channel = await openSlackConversation(botToken, slackUserId)
	if (!channel) return
	await postSlackMessage(botToken, channel, text)
}

// Best-effort member welcome; resolves bot token + Slack id by email, never throws.
export async function greetOrgMemberByEmail(
	env: Env,
	orgId: string,
	email: string | null | undefined,
	orgName?: string | null,
): Promise<void> {
	try {
		if (!email) return
		const ws = await getWorkspaceTokenByOrgId(env, orgId)
		if (!ws) return
		const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
		const slackUserId = await lookupSlackUserByEmail(botToken, email)
		if (!slackUserId) return
		const info = await getSlackUserInfo(botToken, slackUserId)
		const firstName = firstNameOf(info.displayName || info.name)
		await dmSlackUser(botToken, slackUserId, memberGreeting(firstName, orgName))
	} catch (error) {
		console.warn("[slack] greet member failed:", error)
	}
}
