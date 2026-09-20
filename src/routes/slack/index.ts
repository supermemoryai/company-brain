import { slackCredentials } from "../../setup/config-store"
import { ROLE_ADMIN, ROLE_OWNER } from "@repo/lib/permissions"
import { getAgentByName } from "agents"
import { Hono } from "hono"
import {
	PUBLIC_CHANNEL_ROLLOUT_ACTION_ID,
	TEAM_INVITE_NOTIFY_ALL_ACTION_ID,
	TEAM_INVITE_PICK_BLOCK_ID,
	TEAM_INVITE_SELECT_ACTION_ID,
	TEAM_INVITE_SEND_ACTION_ID,
} from "@/lib/brain/constants"
import {
	completeSlackAccountLink,
	getSlackAccountLinkPreview,
	notifySlackAccountLinked,
} from "@/lib/brain/slack/account-link"
import { bootstrapSlackWorkspace } from "@/lib/brain/slack/bootstrap"
import {
	isBotAddressedByName,
	resolveBotAddressAliases,
} from "@/lib/brain/slack/bot-address"
import {
	exchangeSlackOAuth,
	postSlackMessage,
	updateSlackInteractionResponse,
} from "@/lib/brain/slack/client"
import {
	isAddressedToOtherSlackUser,
	isAgentSurfaceEvent,
	isAnsweredEvent,
	isChannelMembershipEvent,
	isChimeInEvent,
	isContextRetentionEvent,
	isDebugReactionEvent,
	isDirectMessage,
	isMuteReactionEvent,
	isNameWakeCandidate,
	SlackEnvelopeSchema,
	type SlackEventInner,
	SlackTeamJoinEnvelopeSchema,
	type SlackTurnMessage,
	SlackUserChangeEnvelopeSchema,
} from "@/lib/brain/slack/events"
import {
	mcpConnectButtonsBlocks,
	recordSlackMcpConnectResponseUrl,
} from "@/lib/brain/slack/mcp-connect"
import { greetSlackInstaller } from "@/lib/brain/slack/onboarding-card"
import { MEMBER_CONNECT_ACTION_PREFIX } from "@/lib/brain/slack/team-invite-card"
import { isSlackRetry, verifySlackSignature } from "@/lib/brain/slack/verify"
import {
	disconnectSlackWorkspace,
	ensureWorkspaceBotUserId,
	getOrgActorBySlackIdentity,
	getWorkspaceByTeamId,
	getWorkspaceStatusByOrgId,
	SlackWorkspaceOrgConflictError,
	upsertWorkspace,
} from "@/lib/brain/slack/workspace"
import { publicApiOrigin, startMcpConnect } from "@/lib/brain/tools/mcp/connect"
import { mcpAppDisplayName } from "@/lib/brain/tools/mcp/directory"
import type { CompanyBrainAgent } from "@/lib/brain/turn/agent"
import { decryptToken, encryptToken } from "@/lib/crypto"
import { getCompanyBrainEntitlement } from "@/lib/payments/company-brain-entitlement"
import type { AppContext } from "@/types"

const SLACK_SCOPES = [
	"app_mentions:read",
	"assistant:write",
	"chat:write",
	"channels:history",
	"channels:join",
	"channels:manage",
	"channels:read",
	"channels:write.invites",
	"files:read",
	"files:write",
	"groups:history",
	"groups:read",
	"im:history",
	"im:write",
	"reactions:read",
	"reactions:write",
	"team:read",
	"usergroups:read",
	"users:read",
	"users:read.email",
].join(",")

const OAUTH_STATE_TTL_SECONDS = 600
const EVENT_DEDUP_TTL_SECONDS = 60 * 60 * 24

const NOT_CONNECTED_TEXT =
	"Supermemory isn't connected to this Slack workspace yet. Sign up for Company Brain to set it up."
const NOT_CONNECTED_BLOCKS = [
	{
		type: "section",
		text: {
			type: "mrkdwn",
			text: "Supermemory isn't connected to this Slack workspace yet. Sign up for Company Brain to set it up.",
		},
	},
	{
		type: "actions",
		elements: [
			{
				type: "button",
				text: {
					type: "plain_text",
					text: "Sign up for Company Brain",
					emoji: true,
				},
				url: "https://app.supermemory.ai",
				style: "primary",
			},
		],
	},
]

const DEFAULT_CONSUMER_ORIGIN = "https://app.supermemory.ai"

function consumerAppOrigin(c: {
	req: { header: (k: string) => string | undefined }
	env?: { CONSUMER_APP_URL?: string }
}): string {
	const allowed = new Set<string>([DEFAULT_CONSUMER_ORIGIN])
	const configured = c.env?.CONSUMER_APP_URL
	if (configured) {
		try {
			allowed.add(new URL(configured).origin)
		} catch {}
	}
	const referer = c.req.header("referer")
	if (!referer) return DEFAULT_CONSUMER_ORIGIN
	try {
		const origin = new URL(referer).origin
		if (allowed.has(origin)) return origin
		if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
			return origin
		if (/^https:\/\/[a-z0-9-]+\.dev\.supermemory\.ai$/.test(origin))
			return origin
	} catch {}
	return DEFAULT_CONSUMER_ORIGIN
}

function callbackUrl(env: Env): string {
	return `${(env.PUBLIC_URL ?? "").replace(/\/$/, "")}/brain/slack/oauth/callback`
}

function readBrainTrialStartedAt(metadata: unknown): number | undefined {
	if (!metadata || typeof metadata !== "object") return undefined
	const started = (metadata as Record<string, unknown>).brainTrialStartedAt
	if (typeof started !== "string") return undefined
	const ms = Date.parse(started)
	return Number.isFinite(ms) ? ms : undefined
}

function logSlackEvent(
	msg: string,
	event: SlackEventInner,
	extra?: Record<string, string | null | undefined>,
): void {
	const parts = [
		`type=${event.type}`,
		`subtype=${event.subtype ?? "-"}`,
		`channel=${event.channel ?? "?"}`,
		`thread=${event.thread_ts ?? "-"}`,
		`user=${event.user ?? "?"}`,
	]
	if (extra) {
		for (const [key, value] of Object.entries(extra)) {
			parts.push(`${key}=${value ?? "?"}`)
		}
	}
	console.log(`[slack] ${msg} ${parts.join(" ")}`)
}

async function loadWorkspace(env: Env, teamId: string) {
	const ws = await getWorkspaceByTeamId(env, teamId)
	if (!ws) return null
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	const botUserId = await ensureWorkspaceBotUserId(env, ws, botToken)
	return botUserId ? { ...ws, botUserId } : ws
}

function parseInteractionPayload(rawBody: Uint8Array): {
	teamId: string
	userId: string
	approvalId: string
	approved: boolean
	responseUrl?: string
} | null {
	const body = new TextDecoder().decode(rawBody)
	const payload = new URLSearchParams(body).get("payload")
	if (!payload) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(payload)
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== "object") return null
	const p = parsed as {
		type?: unknown
		team?: { id?: unknown }
		user?: { id?: unknown }
		response_url?: unknown
		actions?: Array<{ action_id?: unknown; value?: unknown }>
	}
	if (p.type !== "block_actions") return null
	const action = p.actions?.[0]
	const actionId =
		typeof action?.action_id === "string" ? action.action_id : undefined
	const approvalId =
		typeof action?.value === "string" ? action.value : undefined
	const teamId = typeof p.team?.id === "string" ? p.team.id : undefined
	const userId = typeof p.user?.id === "string" ? p.user.id : undefined
	if (!teamId || !userId || !approvalId || !actionId) return null
	if (
		actionId !== "brain_approval_approve" &&
		actionId !== "brain_approval_deny"
	) {
		return null
	}
	return {
		teamId,
		userId,
		approvalId,
		approved: actionId === "brain_approval_approve",
		responseUrl:
			typeof p.response_url === "string" ? p.response_url : undefined,
	}
}

function parseLeaseInteractionPayload(rawBody: Uint8Array): {
	teamId: string
	approverSlackUser: string
	decision: "approve" | "deny" | "revoke"
	requestId?: string
	leaseId?: string
	responseUrl?: string
} | null {
	const body = new TextDecoder().decode(rawBody)
	const payload = new URLSearchParams(body).get("payload")
	if (!payload) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(payload)
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== "object") return null
	const p = parsed as {
		type?: unknown
		team?: { id?: unknown }
		user?: { id?: unknown }
		response_url?: unknown
		actions?: Array<{ action_id?: unknown; value?: unknown }>
	}
	if (p.type !== "block_actions") return null
	const action = p.actions?.[0]
	const actionId =
		typeof action?.action_id === "string" ? action.action_id : undefined
	const value = typeof action?.value === "string" ? action.value : undefined
	const teamId = typeof p.team?.id === "string" ? p.team.id : undefined
	const userId = typeof p.user?.id === "string" ? p.user.id : undefined
	if (!teamId || !userId || !value || !actionId) return null
	const decision =
		actionId === "brain_lease_approve"
			? ("approve" as const)
			: actionId === "brain_lease_deny"
				? ("deny" as const)
				: actionId === "brain_lease_revoke"
					? ("revoke" as const)
					: undefined
	if (!decision) return null
	return {
		teamId,
		approverSlackUser: userId,
		decision,
		requestId: decision === "revoke" ? undefined : value,
		leaseId: decision === "revoke" ? value : undefined,
		responseUrl:
			typeof p.response_url === "string" ? p.response_url : undefined,
	}
}

function parseMcpConnectInteractionPayload(rawBody: Uint8Array): {
	teamId: string
	slackUserId: string
	stateToken: string
	responseUrl: string
} | null {
	const body = new TextDecoder().decode(rawBody)
	const payload = new URLSearchParams(body).get("payload")
	if (!payload) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(payload)
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== "object") return null
	const p = parsed as {
		type?: unknown
		team?: { id?: unknown }
		user?: { id?: unknown }
		response_url?: unknown
		actions?: Array<{ action_id?: unknown; value?: unknown }>
	}
	if (p.type !== "block_actions") return null
	const action = p.actions?.[0]
	const actionId =
		typeof action?.action_id === "string" ? action.action_id : undefined
	const stateToken =
		typeof action?.value === "string" ? action.value : undefined
	const teamId = typeof p.team?.id === "string" ? p.team.id : undefined
	const slackUserId = typeof p.user?.id === "string" ? p.user.id : undefined
	const responseUrl =
		typeof p.response_url === "string" ? p.response_url : undefined
	if (
		!actionId?.startsWith("brain_mcp_connect_") ||
		!stateToken ||
		!teamId ||
		!slackUserId ||
		!responseUrl
	) {
		return null
	}
	return { teamId, slackUserId, stateToken, responseUrl }
}

function parseMemberConnectInteractionPayload(rawBody: Uint8Array): {
	teamId: string
	slackUserId: string
	channelId: string
	messageTs: string
	slug: string
	responseUrl: string
} | null {
	const body = new TextDecoder().decode(rawBody)
	const payload = new URLSearchParams(body).get("payload")
	if (!payload) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(payload)
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== "object") return null
	const p = parsed as {
		type?: unknown
		team?: { id?: unknown }
		user?: { id?: unknown }
		channel?: { id?: unknown }
		message?: { ts?: unknown }
		response_url?: unknown
		actions?: Array<{ action_id?: unknown; value?: unknown }>
	}
	if (p.type !== "block_actions") return null
	const action = p.actions?.[0]
	const actionId =
		typeof action?.action_id === "string" ? action.action_id : undefined
	const value = typeof action?.value === "string" ? action.value : undefined
	if (!actionId?.startsWith(MEMBER_CONNECT_ACTION_PREFIX)) return null
	const slug = actionId.slice(MEMBER_CONNECT_ACTION_PREFIX.length)
	const teamId = typeof p.team?.id === "string" ? p.team.id : undefined
	const slackUserId = typeof p.user?.id === "string" ? p.user.id : undefined
	const channelId = typeof p.channel?.id === "string" ? p.channel.id : undefined
	const messageTs = typeof p.message?.ts === "string" ? p.message.ts : undefined
	const responseUrl =
		typeof p.response_url === "string" ? p.response_url : undefined
	if (
		value !== slug ||
		(slug !== "linear" && slug !== "notion") ||
		!teamId ||
		!slackUserId ||
		!channelId ||
		!messageTs ||
		!responseUrl
	) {
		return null
	}
	return { teamId, slackUserId, channelId, messageTs, slug, responseUrl }
}

function parsePublicChannelRolloutInteractionPayload(rawBody: Uint8Array): {
	teamId: string
	slackUserId: string
	homeChannelId: string
} | null {
	const body = new TextDecoder().decode(rawBody)
	const payload = new URLSearchParams(body).get("payload")
	if (!payload) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(payload)
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== "object") return null
	const p = parsed as {
		type?: unknown
		team?: { id?: unknown }
		user?: { id?: unknown }
		channel?: { id?: unknown }
		actions?: Array<{ action_id?: unknown }>
	}
	if (
		p.type !== "block_actions" ||
		p.actions?.[0]?.action_id !== PUBLIC_CHANNEL_ROLLOUT_ACTION_ID
	) {
		return null
	}
	const teamId = typeof p.team?.id === "string" ? p.team.id : undefined
	const slackUserId = typeof p.user?.id === "string" ? p.user.id : undefined
	const homeChannelId =
		typeof p.channel?.id === "string" ? p.channel.id : undefined
	return teamId && slackUserId && homeChannelId
		? { teamId, slackUserId, homeChannelId }
		: null
}

// The Send button reads the input block's picks out of the message state —
// the picker itself never dispatches.
function parseTeamInviteInteractionPayload(rawBody: Uint8Array): {
	teamId: string
	slackUserId: string
	cardChannel: string
	cardTs?: string
	mode: "selected" | "all"
	userIds?: string[]
} | null {
	const body = new TextDecoder().decode(rawBody)
	const payload = new URLSearchParams(body).get("payload")
	if (!payload) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(payload)
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== "object") return null
	const p = parsed as {
		type?: unknown
		team?: { id?: unknown }
		user?: { id?: unknown }
		channel?: { id?: unknown }
		message?: { ts?: unknown }
		state?: {
			values?: Record<string, Record<string, { selected_users?: unknown }>>
		}
		actions?: Array<{ action_id?: unknown }>
	}
	if (p.type !== "block_actions") return null
	const action = p.actions?.[0]
	const actionId =
		typeof action?.action_id === "string" ? action.action_id : undefined
	if (
		actionId !== TEAM_INVITE_SEND_ACTION_ID &&
		actionId !== TEAM_INVITE_NOTIFY_ALL_ACTION_ID
	) {
		return null
	}
	const mode: "selected" | "all" =
		actionId === TEAM_INVITE_SEND_ACTION_ID ? "selected" : "all"
	let userIds: string[] | undefined
	if (mode === "selected") {
		const picked =
			p.state?.values?.[TEAM_INVITE_PICK_BLOCK_ID]?.[
				TEAM_INVITE_SELECT_ACTION_ID
			]?.selected_users
		userIds = Array.isArray(picked)
			? picked.filter((u): u is string => typeof u === "string")
			: []
		if (!userIds.length) return null
	}
	const teamId = typeof p.team?.id === "string" ? p.team.id : undefined
	const slackUserId = typeof p.user?.id === "string" ? p.user.id : undefined
	const cardChannel =
		typeof p.channel?.id === "string" ? p.channel.id : undefined
	const cardTs = typeof p.message?.ts === "string" ? p.message.ts : undefined
	return teamId && slackUserId && cardChannel
		? { teamId, slackUserId, cardChannel, cardTs, mode, userIds }
		: null
}

function parseSkillInteractionPayload(rawBody: Uint8Array): {
	teamId: string
	slackUserId: string
	draftId: string
	action: "personal" | "org" | "cancel"
	responseUrl?: string
} | null {
	const body = new TextDecoder().decode(rawBody)
	const payload = new URLSearchParams(body).get("payload")
	if (!payload) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(payload)
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== "object") return null
	const p = parsed as {
		type?: unknown
		team?: { id?: unknown }
		user?: { id?: unknown }
		response_url?: unknown
		trigger_id?: unknown
		actions?: Array<{ action_id?: unknown; value?: unknown }>
	}
	if (p.type !== "block_actions") return null
	const action = p.actions?.[0]
	const actionId =
		typeof action?.action_id === "string" ? action.action_id : undefined
	const value = typeof action?.value === "string" ? action.value : undefined
	const teamId = typeof p.team?.id === "string" ? p.team.id : undefined
	const slackUserId = typeof p.user?.id === "string" ? p.user.id : undefined
	if (!actionId || !value || !teamId || !slackUserId) return null
	const responseUrl =
		typeof p.response_url === "string" ? p.response_url : undefined
	const draftAction =
		actionId === "brain_skill_scope_personal"
			? ("personal" as const)
			: actionId === "brain_skill_scope_org"
				? ("org" as const)
				: actionId === "brain_skill_cancel"
					? ("cancel" as const)
					: undefined
	if (draftAction) {
		return {
			teamId,
			slackUserId,
			draftId: value,
			action: draftAction,
			responseUrl,
		}
	}
	return null
}

export const slackRoutes = new Hono<AppContext>()
	.post("/events", async (c) => {
		const rawBody = new Uint8Array(await c.req.raw.clone().arrayBuffer())
		const signingSecret = (await slackCredentials(c.env))?.signingSecret ?? ""

		if (!verifySlackSignature(rawBody, c.req.raw.headers, signingSecret)) {
			return c.json({ error: "invalid signature" }, 401)
		}

		let envelope: unknown
		try {
			envelope = JSON.parse(new TextDecoder().decode(rawBody))
		} catch {
			return c.json({ error: "invalid json" }, 400)
		}

		// team_join first: its nested user object fails the generic inner schema.
		const teamJoin = SlackTeamJoinEnvelopeSchema.safeParse(envelope)
		if (teamJoin.success) {
			const { team_id, event_id, event } = teamJoin.data
			const joinKv = c.env.BRAIN_KV
			const joinKey = `slack:evt:${event_id}`
			if (joinKv) {
				const seen = await joinKv.get(joinKey).catch(() => null)
				if (seen) return c.json({ ok: true })
			} else if (isSlackRetry(c.req.raw.headers)) {
				return c.json({ ok: true })
			}
			const ws = await loadWorkspace(c.env, team_id)
			if (!ws) return c.json({ ok: true })
			// Cast: the agents RPC stub type silently drops newly-added DO methods.
			const agent = (await getAgentByName(
				c.env.COMPANY_BRAIN_AGENT,
				ws.orgId,
			)) as unknown as CompanyBrainAgent
			c.executionCtx.waitUntil(
				(async () => {
					try {
						const terminal = await agent.onSlackTeamJoin({
							teamId: team_id,
							user: event.user,
						})
						// Only dedup terminal outcomes so Slack's retries can redeliver
						// after transient send failures.
						if (terminal && joinKv) {
							await joinKv
								.put(joinKey, "1", { expirationTtl: EVENT_DEDUP_TTL_SECONDS })
								.catch(() => {})
						}
					} catch (err) {
						console.error("[slack] onSlackTeamJoin failed:", err)
					}
				})(),
			)
			return c.json({ ok: true })
		}

		const userChange = SlackUserChangeEnvelopeSchema.safeParse(envelope)
		if (userChange.success) {
			const { team_id, event_id, event } = userChange.data
			const changeKv = c.env.BRAIN_KV
			const changeKey = `slack:evt:${event_id}`
			if (changeKv) {
				const seen = await changeKv.get(changeKey).catch(() => null)
				if (seen) return c.json({ ok: true })
			} else if (isSlackRetry(c.req.raw.headers)) {
				return c.json({ ok: true })
			}
			const ws = await loadWorkspace(c.env, team_id)
			if (!ws) return c.json({ ok: true })
			const agent = (await getAgentByName(
				c.env.COMPANY_BRAIN_AGENT,
				ws.orgId,
			)) as unknown as CompanyBrainAgent
			c.executionCtx.waitUntil(
				(async () => {
					try {
						await agent.onSlackUserChange({
							teamId: team_id,
							user: event.user,
						})
						if (changeKv) {
							await changeKv
								.put(changeKey, "1", {
									expirationTtl: EVENT_DEDUP_TTL_SECONDS,
								})
								.catch(() => {})
						}
					} catch (err) {
						console.error("[slack] onSlackUserChange failed:", err)
					}
				})(),
			)
			return c.json({ ok: true })
		}

		const parsed = SlackEnvelopeSchema.safeParse(envelope)
		if (!parsed.success) {
			console.warn("[slack] envelope parse failed:", parsed.error.message)
			return c.json({ ok: true })
		}
		if (parsed.data.type === "url_verification") {
			return c.json({ challenge: parsed.data.challenge })
		}

		const { team_id, event_id, event } = parsed.data

		const kv = c.env.BRAIN_KV
		const idemKey = `slack:evt:${event_id}`
		if (kv) {
			const seen = await kv.get(idemKey).catch(() => null)
			if (seen) {
				logSlackEvent("dedup skip", event, { event_id })
				return c.json({ ok: true })
			}
		} else if (isSlackRetry(c.req.raw.headers)) {
			logSlackEvent("retry skip", event, { event_id })
			return c.json({ ok: true })
		}

		const markEventSeen = async (): Promise<void> => {
			if (!kv) return
			await kv
				.put(idemKey, "1", { expirationTtl: EVENT_DEDUP_TTL_SECONDS })
				.catch(() => {})
		}

		if (isAgentSurfaceEvent(event)) {
			logSlackEvent("agent surface", event, {
				event_id,
			})
			c.executionCtx.waitUntil(markEventSeen())
			return c.json({ ok: true })
		}

		if (isDebugReactionEvent(event) || isMuteReactionEvent(event)) {
			const ws = await loadWorkspace(c.env, team_id)
			if (!ws) return c.json({ ok: true })
			logSlackEvent("reaction", event, {
				event_id,
				botUserId: ws.botUserId,
				orgId: ws.orgId,
			})
			// Cast: the agents RPC stub type silently drops newly-added DO methods.
			const agent = (await getAgentByName(
				c.env.COMPANY_BRAIN_AGENT,
				ws.orgId,
			)) as unknown as CompanyBrainAgent
			c.executionCtx.waitUntil(
				(async () => {
					try {
						await agent.onSlackReaction({ teamId: team_id, event })
						await markEventSeen()
					} catch (err) {
						console.error("[slack] onSlackReaction failed:", err)
					}
				})(),
			)
			return c.json({ ok: true })
		}

		if (isChannelMembershipEvent(event)) {
			const ws = await loadWorkspace(c.env, team_id)
			if (!ws) return c.json({ ok: true })
			logSlackEvent("membership", event, {
				event_id,
				botUserId: ws.botUserId,
				orgId: ws.orgId,
			})
			// Cast: the agents RPC stub type silently drops newly-added DO methods.
			const agent = (await getAgentByName(
				c.env.COMPANY_BRAIN_AGENT,
				ws.orgId,
			)) as unknown as CompanyBrainAgent
			c.executionCtx.waitUntil(
				(async () => {
					try {
						await agent.onSlackMembershipEvent({ teamId: team_id, event })
						await markEventSeen()
					} catch (err) {
						console.error("[slack] onSlackMembershipEvent failed:", err)
					}
				})(),
			)
			return c.json({ ok: true })
		}

		const ws = await loadWorkspace(c.env, team_id)
		const addressedElsewhere = Boolean(
			ws &&
				!isDirectMessage(event) &&
				isAddressedToOtherSlackUser(event.text, ws.botUserId),
		)
		let isExplicitTurn =
			!addressedElsewhere && isAnsweredEvent(event, ws?.botUserId)
		let isChimeTurn = false
		let addressedByName = false

		if (
			ws &&
			!addressedElsewhere &&
			!isExplicitTurn &&
			isNameWakeCandidate(event, ws.botUserId)
		) {
			const aliases = await resolveBotAddressAliases(c.env, ws)
			if (isBotAddressedByName(event.text, aliases)) {
				isExplicitTurn = true
				addressedByName = true
				logSlackEvent("name wake", event, {
					event_id,
					botUserId: ws.botUserId,
					orgId: ws.orgId,
				})
			}
		}

		if (!addressedElsewhere && !isExplicitTurn) {
			isChimeTurn = ws ? isChimeInEvent(event, ws.botUserId) : false
		}
		const isContextTurn = Boolean(
			ws && isContextRetentionEvent(event, ws.botUserId),
		)

		if (!isExplicitTurn && !isChimeTurn && !isContextTurn) {
			logSlackEvent("ignored", event, {
				event_id,
				botUserId: ws?.botUserId,
				reason: ws?.botUserId ? "not_answered" : "not_answered_no_bot_user_id",
			})
			return c.json({ ok: true })
		}
		if (!ws) {
			// Explicit turns only (mention/DM/thread). Chime requires a linked workspace.
			const fallbackToken = c.env.SLACK_BOT_TOKEN
			if (isExplicitTurn && fallbackToken && event.channel) {
				c.executionCtx.waitUntil(
					postSlackMessage(
						fallbackToken,
						event.channel,
						NOT_CONNECTED_TEXT,
						event.thread_ts ?? event.ts,
						NOT_CONNECTED_BLOCKS,
					),
				)
			}
			return c.json({ ok: true })
		}

		logSlackEvent(
			isExplicitTurn
				? "dispatch"
				: isChimeTurn
					? "chime dispatch"
					: "context dispatch",
			event,
			{
				event_id,
				botUserId: ws.botUserId,
				orgId: ws.orgId,
				...(addressedElsewhere
					? { routingReason: "directed_to_other_user" }
					: {}),
			},
		)

		// Same user message can race in via multiple event types before either
		// finishes; lock on channel+ts for the lifetime of one turn.
		const turnKey =
			event.channel && event.ts
				? isChimeTurn
					? `slack:chime:${team_id}:${event.channel}:${event.ts}`
					: isExplicitTurn
						? `slack:turn:${team_id}:${event.channel}:${event.ts}`
						: `slack:context:${team_id}:${event.channel}:${event.ts}`
				: null
		if (kv && turnKey) {
			const inFlight = await kv.get(turnKey).catch(() => null)
			if (inFlight) {
				logSlackEvent("turn dedup skip", event, { event_id, turnKey })
				return c.json({ ok: true })
			}
			await kv
				.put(turnKey, "1", { expirationTtl: EVENT_DEDUP_TTL_SECONDS })
				.catch(() => {})
		}

		const message: SlackTurnMessage = {
			teamId: team_id,
			eventId: event_id,
			event,
			...(addressedByName ? { addressedByName: true } : {}),
			workspace: ws,
		}
		const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, ws.orgId)
		c.executionCtx.waitUntil(
			(async () => {
				try {
					if (isExplicitTurn) {
						await agent.onSlackEvent(message)
					} else if (isChimeTurn) {
						await agent.onSlackChimeIn(message)
					} else if (isContextTurn) {
						await agent.onSlackContextEvent(message)
					}
					await markEventSeen()
				} catch (err) {
					console.error(
						`[slack] ${isExplicitTurn ? "onSlackEvent" : isChimeTurn ? "onSlackChimeIn" : isContextTurn ? "onSlackContextEvent" : "event"} failed:`,
						err,
					)
				}
			})(),
		)

		return c.json({ ok: true })
	})
	.post("/interactions", async (c) => {
		const rawBody = new Uint8Array(await c.req.raw.clone().arrayBuffer())
		const signingSecret = (await slackCredentials(c.env))?.signingSecret ?? ""

		if (!verifySlackSignature(rawBody, c.req.raw.headers, signingSecret)) {
			return c.json({ error: "invalid signature" }, 401)
		}

		const skillInteraction = parseSkillInteractionPayload(rawBody)
		if (skillInteraction) {
			const ws = await getWorkspaceByTeamId(c.env, skillInteraction.teamId)
			if (!ws) return c.json({ ok: true })
			const agent = (await getAgentByName(
				c.env.COMPANY_BRAIN_AGENT,
				ws.orgId,
			)) as unknown as CompanyBrainAgent
			c.executionCtx.waitUntil(agent.onSkillDraftInteraction(skillInteraction))
			return c.json({ ok: true })
		}

		const approval = parseInteractionPayload(rawBody)
		if (approval) {
			const ws = await getWorkspaceByTeamId(c.env, approval.teamId)
			if (!ws) return c.json({ ok: true })

			const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, ws.orgId)
			c.executionCtx.waitUntil(
				agent.onApprovalDecision({
					teamId: approval.teamId,
					approvalId: approval.approvalId,
					approved: approval.approved,
					userId: approval.userId,
					responseUrl: approval.responseUrl,
				}),
			)
			return c.json({ ok: true })
		}

		const lease = parseLeaseInteractionPayload(rawBody)
		if (lease) {
			const ws = await getWorkspaceByTeamId(c.env, lease.teamId)
			if (!ws) return c.json({ ok: true })

			const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, ws.orgId)
			c.executionCtx.waitUntil(
				agent.onLeaseDecision({
					teamId: lease.teamId,
					approverSlackUser: lease.approverSlackUser,
					decision: lease.decision,
					requestId: lease.requestId,
					leaseId: lease.leaseId,
					responseUrl: lease.responseUrl,
				}),
			)
			return c.json({ ok: true })
		}

		const connect = parseMcpConnectInteractionPayload(rawBody)
		if (connect) {
			const recorded = await recordSlackMcpConnectResponseUrl({
				env: c.env,
				stateToken: connect.stateToken,
				teamId: connect.teamId,
				slackUserId: connect.slackUserId,
				responseUrl: connect.responseUrl,
			})
			if (!recorded) {
				console.warn(
					`[slack] connect interaction state not recorded team=${connect.teamId} user=${connect.slackUserId}`,
				)
			}
			return c.body(null, 200)
		}

		const memberConnect = parseMemberConnectInteractionPayload(rawBody)
		if (memberConnect) {
			const requestUrl = c.req.url
			c.executionCtx.waitUntil(
				(async () => {
					try {
						const ws = await getWorkspaceByTeamId(c.env, memberConnect.teamId)
						if (!ws) {
							await updateSlackInteractionResponse(memberConnect.responseUrl, {
								text: "This Slack workspace is no longer connected to Company Brain.",
								responseType: "ephemeral",
							})
							return
						}
						const actor = await getOrgActorBySlackIdentity(c.env, {
							orgId: ws.orgId,
							teamId: memberConnect.teamId,
							slackUserId: memberConnect.slackUserId,
						})
						if (!actor.actor) {
							await updateSlackInteractionResponse(memberConnect.responseUrl, {
								text: "I couldn't verify your Company Brain membership. Ask a workspace admin to restore your access.",
								responseType: "ephemeral",
							})
							return
						}
						const result = await startMcpConnect({
							env: c.env,
							orgId: ws.orgId,
							userId: actor.actor.userId,
							slug: memberConnect.slug,
							callbackOrigin: publicApiOrigin(c.env, requestUrl),
							slackContext: {
								teamId: memberConnect.teamId,
								channel: memberConnect.channelId,
								threadTs: memberConnect.messageTs,
								slackUserId: memberConnect.slackUserId,
							},
						})
						const label = mcpAppDisplayName(memberConnect.slug)
						if (result.ok && "alreadyAuthorized" in result) {
							await updateSlackInteractionResponse(memberConnect.responseUrl, {
								text: `${label} is already connected.`,
								responseType: "ephemeral",
							})
							return
						}
						if (!result.ok || !("authUrl" in result)) {
							await updateSlackInteractionResponse(memberConnect.responseUrl, {
								text: `I couldn't start the ${label} connection. Please try again.`,
								responseType: "ephemeral",
							})
							return
						}
						await updateSlackInteractionResponse(memberConnect.responseUrl, {
							text: `Connect ${label}`,
							blocks: mcpConnectButtonsBlocks([
								{
									slug: memberConnect.slug,
									label,
									authUrl: result.authUrl,
									stateToken: result.stateToken,
								},
							]),
							responseType: "ephemeral",
						})
					} catch (error) {
						console.warn(
							`[slack] member connect failed team=${memberConnect.teamId} user=${memberConnect.slackUserId} slug=${memberConnect.slug}:`,
							error,
						)
						await updateSlackInteractionResponse(memberConnect.responseUrl, {
							text: "I couldn't start that connection. Please try again.",
							responseType: "ephemeral",
						})
					}
				})(),
			)
			return c.body(null, 200)
		}

		const rollout = parsePublicChannelRolloutInteractionPayload(rawBody)
		if (rollout) {
			const ws = await getWorkspaceByTeamId(c.env, rollout.teamId)
			if (!ws) return c.body(null, 200)
			const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, ws.orgId)
			c.executionCtx.waitUntil(agent.startPublicChannelRollout(rollout))
			return c.body(null, 200)
		}

		const teamInvite = parseTeamInviteInteractionPayload(rawBody)
		if (teamInvite) {
			console.log(
				`[slack] team invite interaction mode=${teamInvite.mode} picks=${teamInvite.userIds?.length ?? 0} team=${teamInvite.teamId}`,
			)
			const ws = await getWorkspaceByTeamId(c.env, teamInvite.teamId)
			if (!ws) return c.body(null, 200)
			// Cast: the agents RPC stub type silently drops newly-added DO methods.
			const agent = (await getAgentByName(
				c.env.COMPANY_BRAIN_AGENT,
				ws.orgId,
			)) as unknown as CompanyBrainAgent
			c.executionCtx.waitUntil(
				agent.startTeamInviteWave({
					teamId: teamInvite.teamId,
					mode: teamInvite.mode,
					userIds: teamInvite.userIds,
					requestedBySlackUserId: teamInvite.slackUserId,
					cardChannel: teamInvite.cardChannel,
					cardTs: teamInvite.cardTs,
				}),
			)
			return c.body(null, 200)
		}

		// Non-approval interaction payloads (e.g. stray button clicks) just ack.
		try {
			const raw = new URLSearchParams(new TextDecoder().decode(rawBody)).get(
				"payload",
			)
			const p = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
			const action = (
				p?.actions as Array<{ action_id?: string }> | undefined
			)?.[0]
			console.log(
				`[slack] unhandled interaction type=${String(p?.type)} action=${action?.action_id ?? "?"}`,
			)
		} catch {}
		return c.body(null, 200)
	})
	.get("/status", async (c) => {
		const org = c.get("org")
		if (!org) return c.json({ error: "unauthorized" }, 401)
		return c.json(await getWorkspaceStatusByOrgId(c.env, org.id))
	})
	.delete("/workspace", async (c) => {
		const org = c.get("org")
		if (!org) return c.json({ error: "unauthorized" }, 401)
		const role = c.get("memberRole")
		if (role !== ROLE_ADMIN && role !== ROLE_OWNER) {
			return c.json({ error: "forbidden" }, 403)
		}
		const result = await disconnectSlackWorkspace(c.env, org.id)
		if (!result.disconnected) {
			if (result.reason === "cleanup_failed") {
				return c.json(
					{ error: "cleanup_failed" as const, retryable: true },
					503,
				)
			}
			return c.json({ error: "not_connected" }, 404)
		}
		return c.json({ ok: true as const, revoked: result.revoked })
	})
	.get("/account-link/:token", async (c) => {
		const currentUser = c.get("user")
		if (!currentUser) return c.json({ error: "unauthorized" }, 401)
		const result = await getSlackAccountLinkPreview(
			c.env,
			c.req.param("token"),
			currentUser.id,
		)
		if (result.status === "invalid")
			return c.json({ status: result.status }, 404)
		if (result.status === "expired" || result.status === "used")
			return c.json({ status: result.status }, 410)
		return c.json(result)
	})
	.post("/account-link/:token", async (c) => {
		const currentUser = c.get("user")
		if (!currentUser) return c.json({ error: "unauthorized" }, 401)
		const result = await completeSlackAccountLink(
			c.env,
			c.req.param("token"),
			currentUser.id,
		)
		if (!result.ok) {
			const status =
				result.reason === "not_in_org"
					? 403
					: result.reason === "invalid"
						? 404
						: 410
			return c.json({ status: result.reason }, status)
		}

		console.info(
			`[company-brain] slack identity linked org=${result.orgId} team=${result.teamId} slackUser=${result.slackUserId} user=${currentUser.id} source=web_confirmed`,
		)
		const workspace = await getWorkspaceByTeamId(c.env, result.teamId)
		if (workspace) {
			c.executionCtx.waitUntil(
				(async () => {
					const botToken = await decryptToken(
						workspace.botTokenEnc,
						c.env.ENCRYPTION_SECRET,
					)
					await notifySlackAccountLinked(botToken, {
						slackUserId: result.slackUserId,
						orgName: result.orgName,
					})
				})().catch((error) => {
					console.warn(
						`[company-brain] slack identity confirmation failed org=${result.orgId} team=${result.teamId} slackUser=${result.slackUserId}:`,
						error,
					)
				}),
			)
		}
		return c.json({ status: "linked", orgName: result.orgName })
	})
	.get("/oauth/install", async (c) => {
		const org = c.get("org")
		const user = c.get("user")
		if (!org || !user) return c.json({ error: "unauthorized" }, 401)

		const role = c.get("memberRole")
		if (role !== ROLE_ADMIN && role !== ROLE_OWNER)
			return c.json({ error: "admin only" }, 403)

		const entitlement = await getCompanyBrainEntitlement(
			c.env,
			org.id,
			(promise) => c.executionCtx.waitUntil(promise),
		)
		if (!entitlement.allowed) {
			const target = new URL("/onboarding", consumerAppOrigin(c))
			target.searchParams.set("trial", entitlement.reason ?? "required")
			return c.redirect(target.toString(), 302)
		}

		// Remember where to send the user back (the app that opened the flow),
		// so dev/prod both land on the right home page.
		let returnTo = "https://app.supermemory.ai"
		const referer = c.req.header("referer")
		try {
			if (referer) returnTo = new URL(referer).origin
		} catch {}

		const state = crypto.randomUUID()
		await c.env.BRAIN_KV.put(
			`slack:oauth:${state}`,
			JSON.stringify({ orgId: org.id, userId: user.id, returnTo }),
			{ expirationTtl: OAUTH_STATE_TTL_SECONDS },
		)

		const url = new URL("https://slack.com/oauth/v2/authorize")
		const credentials = await slackCredentials(c.env)
		if (!credentials) return c.text("Slack is not configured — finish setup at /setup", 409)
		url.searchParams.set("client_id", credentials.clientId)
		url.searchParams.set("scope", SLACK_SCOPES)
		url.searchParams.set("redirect_uri", callbackUrl(c.env))
		url.searchParams.set("state", state)
		return c.redirect(url.toString())
	})
	.get("/oauth/callback", async (c) => {
		const code = c.req.query("code")
		const state = c.req.query("state")
		if (!code || !state) return c.json({ error: "missing code/state" }, 400)

		const stateRaw = await c.env.BRAIN_KV.get(`slack:oauth:${state}`).catch(
			() => null,
		)
		if (!stateRaw) return c.json({ error: "invalid or expired state" }, 400)
		await c.env.BRAIN_KV.delete(`slack:oauth:${state}`).catch(() => {})
		const { orgId, userId, returnTo } = JSON.parse(stateRaw) as {
			orgId: string
			userId: string
			returnTo?: string
		}

		const oauth = await exchangeSlackOAuth(c.env, code, callbackUrl(c.env))
		const botTokenEnc = await encryptToken(
			oauth.botToken,
			c.env.ENCRYPTION_SECRET,
		)

		try {
			await upsertWorkspace(c.env, {
				teamId: oauth.teamId,
				orgId,
				botTokenEnc,
				botUserId: oauth.botUserId,
				teamName: oauth.teamName,
				installedByUserId: userId,
				scopes: oauth.scopes,
				appId: oauth.appId,
			})
		} catch (error) {
			if (error instanceof SlackWorkspaceOrgConflictError) {
				return c.json(
					{
						error:
							"This Slack workspace is already connected to another Supermemory organization.",
					},
					409,
				)
			}
			throw error
		}

		c.executionCtx.waitUntil(
			(async () => {
				const { db, eq } = await import("@repo/db")
				const { organization } = await import("@repo/db/schema/auth")
				const [orgRow] = await db(c.env)
					.select({ metadata: organization.metadata })
					.from(organization)
					.where(eq(organization.id, orgId))
					.limit(1)

				const { syncBillingStateNow } = await import(
					"@/lib/payments/billing-state"
				)
				await syncBillingStateNow(c.env, orgId).catch((error) => {
					console.warn(
						`[slack] billing state sync failed org=${orgId}:`,
						error instanceof Error ? error.message : error,
					)
				})

				const { posthog } = await import("@/lib/posthog")
				await posthog.brainSlackInstalled({
					userId,
					orgId,
					teamId: oauth.teamId,
				})

				const trialStartedAtMs = readBrainTrialStartedAt(orgRow?.metadata)
				if (oauth.authedUserId && trialStartedAtMs) {
					const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, orgId)
					await agent.armCompanyBrainTrialReminders({
						teamId: oauth.teamId,
						installerSlackUserId: oauth.authedUserId,
						trialStartedAtMs,
					})
				}

				await bootstrapSlackWorkspace(c.env, {
					orgId,
					installerUserId: userId,
					teamId: oauth.teamId,
					teamName: oauth.teamName,
					botToken: oauth.botToken,
					slackUserId: oauth.authedUserId,
				})
				await greetSlackInstaller(c.env, {
					orgId,
					installerUserId: userId,
					teamId: oauth.teamId,
					botToken: oauth.botToken,
					slackUserId: oauth.authedUserId,
					teamName: oauth.teamName,
				})
			})().catch((err) => {
				console.warn("[slack] post-oauth bootstrap/trial failed:", err)
			}),
		)

		const base = returnTo ?? "https://app.supermemory.ai"
		const dest = new URL(base)
		dest.pathname = "/"
		dest.searchParams.set("slack", "connected")
		if (oauth.teamName) dest.searchParams.set("team", oauth.teamName)
		return c.redirect(dest.toString())
	})
