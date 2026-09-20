import type { ToolSet } from "ai"
import { logPreview } from "../observability/log-utils"
import {
	checkAskerCanSearchChannel,
	resolveChannel,
} from "../slack/channel-directory"
import {
	lookupSlackUserInfo,
	openSlackConversation,
	postSlackMessage,
} from "../slack/client"
import { toSlackMrkdwn } from "../slack/format"
import type { CompanyBrainAgent } from "../turn/agent"
import type { TurnDeps } from "../turn/deps"

const SEND_TO_HOURLY_LIMIT = 10
const MAX_MESSAGE_CHARS = 11_200
const SECTION_CHARS = 2_800

export type SendToContext = {
	env: Env
	botToken: string
	teamId: string
	orgId: string
	currentChannel: string
	initiatorUserId?: string
	initiatorSlackUserId: string
	isOrgMember?: boolean
	askerIsRestricted?: boolean
}

function ensureSendToTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_send_to_log (
			id TEXT PRIMARY KEY,
			org_id TEXT NOT NULL,
			initiator_user_id TEXT,
			initiator_slack_user_id TEXT NOT NULL,
			target_kind TEXT NOT NULL,
			target_id TEXT NOT NULL,
			message TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)
	`
}

function sendsInLastHour(
	agent: CompanyBrainAgent,
	slackUserId: string,
): number {
	const rows = agent.sql<{ n: number }>`
		SELECT COUNT(*) AS n FROM brain_send_to_log
		WHERE initiator_slack_user_id = ${slackUserId}
		AND created_at > ${Date.now() - 3_600_000}
	`
	return rows[0]?.n ?? 0
}

function messageSections(message: string): string[] {
	const sections: string[] = []
	let rest = message
	while (rest.length > SECTION_CHARS) {
		const window = rest.slice(0, SECTION_CHARS)
		const cut = window.lastIndexOf("\n")
		const at = cut > SECTION_CHARS / 2 ? cut : SECTION_CHARS
		sections.push(rest.slice(0, at))
		rest = rest.slice(at)
	}
	if (rest.trim()) sections.push(rest)
	return sections
}

function deliveryBlocks(message: string, initiatorSlackUserId: string) {
	return [
		...messageSections(message).map((chunk) => ({
			type: "section",
			text: { type: "mrkdwn", text: toSlackMrkdwn(chunk) },
		})),
		{
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: `Sent by <@${initiatorSlackUserId}>`,
				},
			],
		},
	]
}

export function createSendToTools(
	agent: CompanyBrainAgent,
	deps: TurnDeps,
	ctx: SendToContext,
	traceId: string,
): ToolSet {
	ensureSendToTable(agent)
	return {
		send_to: deps.tool({
			description:
				"Deliver a message you compose to a different Slack channel or a teammate's DM, on behalf of the requester. Use only when the requester explicitly asks to send/post something somewhere else (e.g. 'post this analysis in #growth', 'DM this to Alice'). The requester must approve the exact message before it sends, and the delivered message shows their name. Never use this to reply in the current conversation.",
			inputSchema: deps.z.object({
				channel: deps.z
					.string()
					.optional()
					.describe(
						"Destination channel name or ID (e.g. '#growth' or C0123456789). Omit when sending a DM.",
					),
				slackUserId: deps.z
					.string()
					.optional()
					.describe(
						"Destination Slack user ID (e.g. U0123456789) for a direct message. Omit when posting to a channel.",
					),
				message: deps.z
					.string()
					.describe(
						"The complete, final message to deliver, exactly as the recipient should read it.",
					),
			}),
			needsApproval: true,
			execute: async ({ channel, slackUserId, message }) => {
				const targetRef = channel?.trim()
				const targetUser = slackUserId?.trim()
				if (!message.trim()) return "The message is empty; nothing was sent."
				if (message.length > MAX_MESSAGE_CHARS)
					return "That message is too long to deliver as one Slack post. Shorten it and try again."
				if (Boolean(targetRef) === Boolean(targetUser))
					return "Pick exactly one destination: a channel or a Slack user for a DM."
				const recent = sendsInLastHour(agent, ctx.initiatorSlackUserId)
				if (recent >= SEND_TO_HOURLY_LIMIT)
					return `Send limit reached (${SEND_TO_HOURLY_LIMIT}/hour per person). Try again later.`

				let deliverChannel: string
				let targetKind: "channel" | "dm"
				let targetId: string
				let targetLabel: string
				if (targetUser) {
					const info = await lookupSlackUserInfo(ctx.botToken, targetUser)
					if (!info.ok)
						return "I couldn't verify that Slack user, so nothing was sent."
					if (
						info.user.isBot ||
						info.user.isRestricted ||
						info.user.isStranger ||
						(info.user.teamId && info.user.teamId !== ctx.teamId)
					) {
						return "I can only DM full members of this workspace, so nothing was sent."
					}
					const dm = await openSlackConversation(ctx.botToken, targetUser)
					if (!dm) return "I couldn't open a DM with that user."
					deliverChannel = dm
					targetKind = "dm"
					targetId = targetUser
					targetLabel = `<@${targetUser}>`
				} else {
					const resolution = await resolveChannel(
						ctx.env,
						ctx.teamId,
						ctx.botToken,
						targetRef ?? "",
					)
					if (resolution.status === "unknown")
						return "I couldn't find that channel. Check the name, or invite me to it with /invite."
					if (resolution.status === "not_member")
						return `I'm not a member of #${resolution.name}. Invite me there with /invite first.`
					const target = resolution.channel
					const access = await checkAskerCanSearchChannel(
						ctx.env,
						ctx.teamId,
						ctx.botToken,
						target,
						ctx.initiatorSlackUserId,
						{
							currentChannelId: ctx.currentChannel,
							isOrgMember: ctx.isOrgMember,
							responseSurface: target.isPrivate
								? "private_channel"
								: "public_channel",
							responseChannelId: target.id,
							askerIsRestricted: ctx.askerIsRestricted,
						},
					)
					if (!access.ok)
						return `I can't post in #${target.name} for you — you need to be a member of it.`
					deliverChannel = target.id
					targetKind = "channel"
					targetId = target.id
					targetLabel = `#${target.name}`
				}

				const ts = await postSlackMessage(
					ctx.botToken,
					deliverChannel,
					message,
					undefined,
					deliveryBlocks(message, ctx.initiatorSlackUserId),
				)
				if (!ts)
					return `Slack rejected the post to ${targetLabel}; nothing was delivered.`
				agent.sql`
					INSERT INTO brain_send_to_log (
						id, org_id, initiator_user_id, initiator_slack_user_id,
						target_kind, target_id, message, created_at
					) VALUES (
						${crypto.randomUUID()}, ${ctx.orgId}, ${ctx.initiatorUserId ?? null},
						${ctx.initiatorSlackUserId}, ${targetKind}, ${targetId},
						${message}, ${Date.now()}
					)
				`
				console.log(
					`[company-brain][${traceId}] send_to delivered kind=${targetKind} target=${targetId} initiator=${ctx.initiatorSlackUserId} chars=${message.length} preview="${logPreview(message)}"`,
				)
				return {
					sent: true,
					target: targetLabel,
					instruction:
						"Delivered. Tell the requester it was sent — do not repeat the full message.",
				}
			},
		}),
	}
}
