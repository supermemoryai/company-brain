import {
	TEAM_INVITE_NOTIFY_ALL_ACTION_ID,
	TEAM_INVITE_PICK_BLOCK_ID,
	TEAM_INVITE_SELECT_ACTION_ID,
	TEAM_INVITE_SEND_ACTION_ID,
} from "../constants"
import type { SlackMember } from "./client"

export const TEAM_INVITE_CARD_FALLBACK = "Bring your team in"
export const AUTOMATIC_TEAM_INVITE_FALLBACK = "Adding your workspace members"
export const MEMBER_CONNECT_ACTION_PREFIX = "brain_member_connect_"

const DEFAULT_MEMBER_STARTERS = [
	"Catch me up on what the team shipped this week.",
	"What has the team decided recently, and who owns it?",
]

// Slackbot has a fixed workspace-independent id.
const SLACKBOT_ID = "USLACKBOT"

export function isEligibleFullMember(
	m: Pick<
		SlackMember,
		| "id"
		| "isBot"
		| "isRestricted"
		| "isUltraRestricted"
		| "isStranger"
		| "teamId"
	> | null,
	botUserId?: string | null,
	teamId?: string,
): boolean {
	if (!m?.id) return false
	if (m.id === SLACKBOT_ID || m.id === botUserId) return false
	if (m.isBot || m.isRestricted || m.isUltraRestricted || m.isStranger)
		return false
	return !teamId || !m.teamId || m.teamId === teamId
}

export type TeamInviteCardState = {
	status?: "idle" | "running" | "done" | "failed"
	sent?: number
	skipped?: number
	total?: number
}

export function automaticTeamInviteProgressBlocks(args: {
	phase: "enumerating" | "provisioning" | "notifying" | "done" | "failed"
	total?: number
	processed?: number
	sent?: number
	skipped?: number
	deduped?: number
}): unknown[] {
	const total = args.total ?? 0
	const processed = args.processed ?? 0
	const sent = args.sent ?? 0
	const skipped = args.skipped ?? 0
	const deduped = args.deduped ?? 0
	const status =
		args.phase === "enumerating"
			? "Finding eligible full workspace members…"
			: args.phase === "provisioning"
				? `Creating accounts and adding members… ${processed}/${total}`
				: args.phase === "notifying"
					? `Inviting members and sending welcome DMs… ${processed}/${total}`
					: args.phase === "done"
						? `✅ Rollout complete: ${sent} welcomed${deduped ? `, ${deduped} already notified` : ""}${skipped ? `, ${skipped} failed` : ""}.`
						: `⚠️ Rollout stopped: ${sent} welcomed${skipped ? `, ${skipped} failed` : ""}.`
	return [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: "*Adding your workspace to Company Brain* 👥\nFull members are being provisioned, invited to #company-brain, and sent a personal introduction. Guests and external members are excluded.",
			},
		},
		{
			type: "context",
			elements: [{ type: "mrkdwn", text: status }],
		},
	]
}

// The admin-facing "Add your team" card, posted into the installer DM.
export function teamInviteCardBlocks(
	state: TeamInviteCardState = {},
): unknown[] {
	const { status = "idle", sent = 0, skipped = 0, total = 0 } = state
	// multi-selects are invalid in `actions` blocks; an input block gives a
	// full-width picker, and the selection only submits via the Send button
	// (read from payload state.values), so picking is deliberate.
	const blocks: unknown[] = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: "*Bring your team in* 👥\nI'll DM each teammate a personal intro so they know what I can do for them.",
			},
		},
		{
			type: "input",
			block_id: TEAM_INVITE_PICK_BLOCK_ID,
			label: { type: "plain_text", text: "Pick teammates", emoji: true },
			element: {
				type: "multi_users_select",
				action_id: TEAM_INVITE_SELECT_ACTION_ID,
				placeholder: {
					type: "plain_text",
					text: "Search teammates…",
					emoji: true,
				},
			},
		},
		{
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: TEAM_INVITE_SEND_ACTION_ID,
					text: { type: "plain_text", text: "Send intros", emoji: true },
					value: "send",
					style: "primary",
				},
				{
					type: "button",
					action_id: TEAM_INVITE_NOTIFY_ALL_ACTION_ID,
					text: { type: "plain_text", text: "Notify everyone", emoji: true },
					value: "all",
					confirm: {
						title: { type: "plain_text", text: "Notify everyone?" },
						text: {
							type: "plain_text",
							text: "I'll DM every full member of this workspace a short intro. Guests and bots are skipped, and nobody is messaged twice.",
						},
						confirm: { type: "plain_text", text: "Notify everyone" },
						deny: { type: "plain_text", text: "Cancel" },
					},
				},
			],
		},
	]
	const progress =
		status === "running"
			? `Notifying your team… ${sent}/${total} sent${skipped ? `, ${skipped} skipped` : ""}`
			: status === "done"
				? `✅ Notified ${sent} teammate${sent === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped)` : ""}. Re-run anytime — nobody gets messaged twice.`
				: status === "failed"
					? `⚠️ Stopped after ${sent} of ${total}. Run it again to retry the rest.`
					: "Guests and external collaborators are never messaged."
	blocks.push({
		type: "context",
		elements: [{ type: "mrkdwn", text: progress }],
	})
	return blocks
}

export type MemberIntroParts = {
	firstName?: string | null
	companyName?: string | null
	homeChannelId?: string | null
	starters?: string[] | null
	teamId: string
	hasConnectActions?: boolean
}

// Deterministic member intro, same voice as installGreeting. Starters preview
// what to ask; the Connect button is the gate into actually asking.
export function memberIntroText(parts: MemberIntroParts): string {
	const { firstName, companyName, homeChannelId, starters } = parts
	const hi = firstName ? `Hey ${firstName},` : "Hey,"
	const subject = companyName ?? "your company"
	const home = homeChannelId ? `<#${homeChannelId}>` : "#company-brain"
	const picks = starters?.length ? starters : DEFAULT_MEMBER_STARTERS

	const lines = [
		`${hi} 👋`,
		"",
		`I'm *Supermemory*, ${subject}'s brain. I keep track of what the team ships, decides, and discusses, so nobody has to dig for it.`,
		"",
		`🔍  *What I can see:* public channels I've been added to (like ${home}) and the tools the team connects.`,
		"🔒  *What I can't see:* your DMs with anyone else, or private channels I'm not in.",
		"",
		"*Once you're connected, ask me things like:*",
		"",
	]
	for (const starter of picks) lines.push(`>${starter}`, "")
	lines.push(
		parts.hasConnectActions
			? "Connect a tool below—or just ask me something—and I'm all yours. 🚀"
			: "Ask me something and I'm all yours. 🚀",
	)
	return lines.join("\n")
}

export type MemberConnectAction = {
	slug: string
	label: string
}

export function memberIntroBlocks(
	parts: MemberIntroParts,
	connectActions: MemberConnectAction[] = [],
): unknown[] {
	return [
		{
			type: "section",
			text: { type: "mrkdwn", text: memberIntroText(parts) },
		},
		...(connectActions.length
			? [
					{
						type: "actions",
						elements: connectActions.map((action) => ({
							type: "button",
							action_id: `${MEMBER_CONNECT_ACTION_PREFIX}${action.slug}`,
							text: {
								type: "plain_text",
								text: `Connect ${action.label}`,
								emoji: true,
							},
							value: action.slug,
							style: "primary",
						})),
					},
				]
			: []),
	]
}
