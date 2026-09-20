import { db, eq } from "@repo/db"
import { mcpOAuthState } from "@repo/db/schema/brain/mcp"
import { getAgentByName } from "agents"
import { decryptToken } from "@/lib/crypto"
import { startMcpConnect } from "../tools/mcp/connect"
import { mcpAppDisplayName } from "../tools/mcp/directory"
import { listActiveConnectionsForActor } from "../tools/mcp/store"
import {
	getSlackUserInfo,
	openSlackConversation,
	postSlackMessage,
	updateSlackMessage,
} from "./client"
import { firstNameOf, installGreeting, orgWithBrain } from "./greet"
import { BUBBLE_DELAY_MS, composeInstallBubbles } from "./install-greeting"
import {
	AUTOMATIC_TEAM_INVITE_FALLBACK,
	automaticTeamInviteProgressBlocks,
} from "./team-invite-card"
import { getWorkspaceByTeamId } from "./workspace"

const ONBOARDING_CONNECT_SLUGS = ["linear", "notion"] as const
const CARD_FALLBACK_TEXT = "Connect your tools whenever you're ready"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type ButtonItem = { slug: string; label: string; authUrl: string }

// Shared renderer: connected apps become check lines, the rest stay connect buttons.
function connectCardBlocks(
	items: ButtonItem[],
	connected: Set<string>,
): unknown[] {
	const pending = items.filter((i) => !connected.has(i.slug))
	const done = items.filter((i) => connected.has(i.slug))
	const blocks: unknown[] = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: pending.length
					? "Whenever you're ready, connect your tools below. 👇"
					: "All set. Put me to work.",
			},
		},
	]
	if (done.length) {
		blocks.push({
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: done.map((d) => `✅ *${d.label}* connected`).join("    "),
				},
			],
		})
	}
	if (pending.length) {
		blocks.push({
			type: "actions",
			elements: pending.map((i) => ({
				type: "button",
				action_id: `brain_mcp_connect_${i.slug}`,
				text: { type: "plain_text", text: `Connect ${i.label}`, emoji: true },
				url: i.authUrl,
				style: "primary",
			})),
		})
	}
	return blocks
}

// Best-effort installer welcome + connect buttons; company-brain orgs only, never throws.
export async function greetSlackInstaller(
	env: Env,
	args: {
		orgId: string
		installerUserId: string
		teamId: string
		botToken: string
		slackUserId: string | undefined
		teamName?: string | null
	},
): Promise<void> {
	try {
		if (!args.slackUserId) {
			console.warn(
				`[slack] greet skipped: no authed slack user org=${args.orgId}`,
			)
			return
		}
		const org = await orgWithBrain(env, args.orgId)
		if (!org) {
			console.warn(
				`[slack] greet skipped: org not company-brain org=${args.orgId}`,
			)
			return
		}
		const agent = await getAgentByName(env.COMPANY_BRAIN_AGENT, args.orgId)
		await agent.startAutomaticTeamInviteRollout({
			teamId: args.teamId,
			installerSlackUserId: args.slackUserId,
		})
		const channel = await openSlackConversation(args.botToken, args.slackUserId)
		if (!channel) {
			console.warn(
				`[slack] installer DM unavailable; workspace rollout continues org=${args.orgId}`,
			)
			return
		}
		console.log(
			`[slack] greeting installer org=${args.orgId} channel=${channel}`,
		)
		const info = await getSlackUserInfo(args.botToken, args.slackUserId)
		const firstName = firstNameOf(info.displayName || info.name)

		const home = await agent.getHomeChannel().catch(() => null)

		// First bubble is the thread parent; the rest reply under it.
		const bubbles = (await composeInstallBubbles(env, args.orgId, firstName, {
			companyName: org.name ?? args.teamName,
			homeChannelId: home?.channelId,
			trialActive: org.trialActive,
		})) ?? [
			installGreeting({
				firstName,
				companyName: org.name ?? args.teamName,
				homeChannelId: home?.channelId,
				trialActive: org.trialActive,
			}),
		]
		let parentTs: string | undefined
		for (let i = 0; i < bubbles.length; i++) {
			const bubble = bubbles[i]
			if (!bubble) continue
			const ts = await postSlackMessage(
				args.botToken,
				channel,
				bubble,
				parentTs,
			)
			parentTs ??= ts
			if (i < bubbles.length - 1) await delay(BUBBLE_DELAY_MS)
		}
		if (!parentTs) return

		await agent.armInstallNudge({
			installerUserId: args.installerUserId,
			slackUserId: args.slackUserId,
			teamId: args.teamId,
			channel,
		})
		await delay(BUBBLE_DELAY_MS)
		const rolloutCardTs = await postSlackMessage(
			args.botToken,
			channel,
			AUTOMATIC_TEAM_INVITE_FALLBACK,
			parentTs,
			automaticTeamInviteProgressBlocks({ phase: "enumerating" }),
		)
		// The rollout button is the installer's only one; never skip it.
		if (rolloutCardTs) {
			await agent
				.attachAutomaticTeamInviteCard({
					teamId: args.teamId,
					adminChannel: channel,
					adminMessageTs: rolloutCardTs,
				})
				.catch((error) => {
					console.warn("[slack] team invite card failed:", error)
				})
		}
		// Last, so the DM reads: greeting, team invite, then the rollout button.
		await agent
			.ensureAdminRolloutCard({
				teamId: args.teamId,
				installerSlackUserId: args.slackUserId,
			})
			.catch((error) => {
				console.warn("[slack] admin rollout card failed:", error)
			})
	} catch (error) {
		console.warn("[slack] greet installer failed:", error)
	}
}

// Mint the connect buttons and post the onboarding card as a top-level DM
export async function postConnectCard(
	env: Env,
	args: {
		orgId: string
		installerUserId: string
		teamId: string
		channel: string
		slackUserId: string
	},
): Promise<boolean> {
	try {
		const ws = await getWorkspaceByTeamId(env, args.teamId)
		if (!ws) return false
		// Nudge lives on the old org's DO; if the workspace was reinstalled into a
		// different org since, bail so we don't DM OAuth links minted for a stale org.
		if (ws.orgId !== args.orgId) {
			console.warn(
				`[slack] connect card skipped: team=${args.teamId} rebound org ${args.orgId}->${ws.orgId}`,
			)
			return false
		}
		const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
		const base = {
			teamId: args.teamId,
			channel: args.channel,
			threadTs: "",
			slackUserId: args.slackUserId,
		}
		const minted = await Promise.all(
			ONBOARDING_CONNECT_SLUGS.map(async (slug) => {
				try {
					const res = await startMcpConnect({
						env,
						orgId: args.orgId,
						userId: args.installerUserId,
						slug,
						callbackOrigin: env.PUBLIC_URL,
						slackContext: base,
					})
					if (res.ok && "authUrl" in res) {
						return {
							slug,
							label: mcpAppDisplayName(slug),
							authUrl: res.authUrl,
							stateToken: res.stateToken,
						}
					}
				} catch (error) {
					console.warn(`[slack] connect start failed slug=${slug}:`, error)
				}
				return null
			}),
		)
		const entries = minted.filter((e): e is NonNullable<typeof e> => e !== null)
		if (!entries.length) return false

		const buttons: ButtonItem[] = entries.map(({ slug, label, authUrl }) => ({
			slug,
			label,
			authUrl,
		}))
		const messageTs = await postSlackMessage(
			botToken,
			args.channel,
			CARD_FALLBACK_TEXT,
			undefined,
			connectCardBlocks(buttons, new Set()),
		)
		if (!messageTs) return false

		// Stamp each state with the card message + button set so the callback can rebuild it.
		await Promise.all(
			entries.map((e) =>
				db(env)
					.update(mcpOAuthState)
					.set({
						context: {
							slack: { ...base, threadTs: messageTs, messageTs, buttons },
						},
					})
					.where(eq(mcpOAuthState.stateToken, e.stateToken)),
			),
		)
		return true
	} catch (error) {
		console.warn("[slack] post connect card failed:", error)
		return false
	}
}

// Rebuild the onboarding card after a tool connects: check the connected ones, keep the rest.
export async function updateSlackConnectMessage(
	env: Env,
	args: {
		teamId: string
		channel: string
		messageTs: string
		buttons: ButtonItem[]
		orgId: string
		userId: string | undefined
	},
): Promise<void> {
	try {
		const ws = await getWorkspaceByTeamId(env, args.teamId)
		if (!ws) return
		if (ws.orgId !== args.orgId) {
			console.error(
				`[slack] connect card update dropped: workspace rebound team=${args.teamId} expectedOrg=${args.orgId} currentOrg=${ws.orgId}`,
			)
			return
		}
		const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
		// Personal-only to match Slack's personalConnectionsOnly usage.
		const active = await listActiveConnectionsForActor(
			env,
			args.orgId,
			args.userId,
			true,
		)
		const connected = new Set(active.map((c) => c.serverSlug))
		await updateSlackMessage(
			botToken,
			args.channel,
			args.messageTs,
			CARD_FALLBACK_TEXT,
			connectCardBlocks(args.buttons, connected),
		)
	} catch (error) {
		console.warn("[slack] update connect card failed:", error)
	}
}
