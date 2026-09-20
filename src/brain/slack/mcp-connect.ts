import { and, db, eq, gt, inArray } from "@repo/db"
import type { McpOAuthStateContext } from "@repo/db/schema/brain/mcp"
import { mcpOAuthState } from "@repo/db/schema/brain/mcp"
import { decryptToken } from "@/lib/crypto"
import { getCatalogEntry } from "../tools/mcp/catalog"
import { mcpAppDisplayName, mcpAppSubtitle } from "../tools/mcp/directory"
import { listActiveConnectionsForActor } from "../tools/mcp/store"
import { postSlackEphemeral, updateSlackInteractionResponse } from "./client"
import { getWorkspaceByTeamId } from "./workspace"

export type SlackMcpConnectButtonArgs = {
	env: Env
	botToken: string
	channel: string
	threadTs: string
	slackUserId: string
	slug: string
	authUrl: string
	stateToken?: string
}

export type SlackMcpConnectLink = Pick<
	SlackMcpConnectButtonArgs,
	"slug" | "authUrl" | "stateToken"
> & { label?: string }

export type SlackMcpConnectButtonsArgs = Omit<
	SlackMcpConnectButtonArgs,
	"slug" | "authUrl"
> & {
	links: SlackMcpConnectLink[]
}

function connectButton(link: SlackMcpConnectLink, text: string): unknown {
	return {
		type: "button",
		action_id: `brain_mcp_connect_${link.slug}`,
		text: { type: "plain_text", text, emoji: true },
		url: link.authUrl,
		...(link.stateToken ? { value: link.stateToken } : {}),
		style: "primary",
	}
}

export function mcpConnectButtonsBlocks(
	links: SlackMcpConnectLink[],
	connected: Set<string> = new Set(),
): unknown[] {
	const uniqueLinks = [
		...new Map(links.map((link) => [link.slug, link])).values(),
	]
	if (!uniqueLinks.length) return []
	const pending = uniqueLinks.filter((link) => !connected.has(link.slug))
	const done = uniqueLinks.filter((link) => connected.has(link.slug))
	const labelFor = (link: SlackMcpConnectLink): string =>
		link.label ?? mcpAppDisplayName(link.slug)
	const blocks: unknown[] = []

	if (!pending.length) {
		blocks.push({
			type: "section",
			text: { type: "mrkdwn", text: "All requested tools are connected." },
		})
	}
	for (const link of pending) {
		const subtitle = mcpAppSubtitle(link.slug)
		blocks.push({
			type: "card",
			title: { type: "mrkdwn", text: labelFor(link) },
			...(subtitle ? { subtitle: { type: "mrkdwn", text: subtitle } } : {}),
			body: {
				type: "mrkdwn",
				text: "Private to you · disconnect any time",
			},
			actions: [connectButton(link, "Connect")],
		})
	}
	if (done.length) {
		blocks.push({
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: done
						.map((link) => `✅ *${labelFor(link)}* connected`)
						.join("    "),
				},
			],
		})
	}
	if (pending.length) {
		blocks.push({
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text:
						pending.length === 1 && pending[0]
							? `No ${labelFor(pending[0])} access? Reply in the thread and I'll ask a teammate.`
							: "No access to one of these? Reply in the thread with the app name and I'll ask a teammate.",
				},
			],
		})
	}
	return blocks
}

export async function postSlackMcpConnectButtons(
	args: SlackMcpConnectButtonsArgs,
): Promise<boolean> {
	const names = args.links.map((link) => mcpAppDisplayName(link.slug))
	if (!names.length) return false
	return postSlackEphemeral(
		args.botToken,
		args.channel,
		args.slackUserId,
		`Connect ${names.join(", ")}`,
		args.threadTs,
		mcpConnectButtonsBlocks(args.links),
	)
}

type SlackConnectContext = NonNullable<McpOAuthStateContext["slack"]>

export async function stampSlackMcpConnectButtons(args: {
	env: Env
	links: SlackMcpConnectLink[]
	slackContext: Omit<
		SlackConnectContext,
		"buttons" | "messageTs" | "responseUrl"
	>
}): Promise<void> {
	const buttons = args.links.map((link) => ({
		slug: link.slug,
		label: link.label ?? mcpAppDisplayName(link.slug),
		authUrl: link.authUrl,
		...(link.stateToken ? { stateToken: link.stateToken } : {}),
	}))
	await Promise.all(
		args.links.flatMap((link) =>
			link.stateToken
				? [
						db(args.env)
							.update(mcpOAuthState)
							.set({
								context: {
									slack: { ...args.slackContext, buttons },
								},
							})
							.where(eq(mcpOAuthState.stateToken, link.stateToken)),
					]
				: [],
		),
	)
}

export async function recordSlackMcpConnectResponseUrl(args: {
	env: Env
	stateToken: string
	teamId: string
	slackUserId: string
	responseUrl: string
}): Promise<boolean> {
	const [row] = await db(args.env)
		.select({ context: mcpOAuthState.context })
		.from(mcpOAuthState)
		.where(
			and(
				eq(mcpOAuthState.stateToken, args.stateToken),
				gt(mcpOAuthState.expiresAt, new Date()),
			),
		)
		.limit(1)
	const slack = row?.context?.slack
	if (
		!slack ||
		slack.teamId !== args.teamId ||
		slack.slackUserId !== args.slackUserId
	) {
		return false
	}
	await db(args.env)
		.update(mcpOAuthState)
		.set({
			context: {
				...row.context,
				slack: { ...slack, responseUrl: args.responseUrl },
			},
		})
		.where(eq(mcpOAuthState.stateToken, args.stateToken))
	return true
}

export async function updateSlackMcpConnectEphemeral(
	env: Env,
	args: {
		responseUrl: string
		buttons: NonNullable<SlackConnectContext["buttons"]>
		orgId: string
		userId: string | undefined
	},
): Promise<boolean> {
	try {
		const active = await listActiveConnectionsForActor(
			env,
			args.orgId,
			args.userId,
			true,
		)
		const connected = new Set(active.map((connection) => connection.serverSlug))
		const links: SlackMcpConnectLink[] = args.buttons.map((button) => ({
			slug: button.slug,
			label: button.label,
			authUrl: button.authUrl,
			stateToken: button.stateToken,
		}))
		const pending = links.filter((link) => !connected.has(link.slug))
		return await updateSlackInteractionResponse(args.responseUrl, {
			text: pending.length
				? "Connect your remaining tools"
				: "All requested tools are connected",
			blocks: mcpConnectButtonsBlocks(links, connected),
			replaceOriginal: true,
		})
	} catch (error) {
		console.warn("[slack] update ephemeral connect card failed:", error)
		return false
	}
}

export async function retireSlackMcpConnectPrompt(args: {
	env: Env
	orgId: string
	userId: string
	teamId: string
	channel: string
	threadTs: string
	slackUserId: string
	slug: string
}): Promise<{ invalidated: number; updatedCards: number }> {
	const slug = args.slug.trim().toLowerCase()
	const rows = await db(args.env)
		.select({
			stateToken: mcpOAuthState.stateToken,
			serverSlug: mcpOAuthState.serverSlug,
			context: mcpOAuthState.context,
		})
		.from(mcpOAuthState)
		.where(
			and(
				eq(mcpOAuthState.orgId, args.orgId),
				eq(mcpOAuthState.userId, args.userId),
				gt(mcpOAuthState.expiresAt, new Date()),
			),
		)
	const matching = rows.filter(({ context }) => {
		const slack = context?.slack
		return (
			slack?.teamId === args.teamId &&
			slack.channel === args.channel &&
			slack.threadTs === args.threadTs &&
			slack.slackUserId === args.slackUserId
		)
	})
	const retiredTokens = matching
		.filter((row) => row.serverSlug === slug)
		.map((row) => row.stateToken)
	if (!retiredTokens.length) return { invalidated: 0, updatedCards: 0 }

	const responseCards = new Map<
		string,
		NonNullable<SlackConnectContext["buttons"]>
	>()
	for (const row of matching) {
		const slack = row.context?.slack
		if (slack?.responseUrl && slack.buttons) {
			responseCards.set(slack.responseUrl, slack.buttons)
		}
	}

	await db(args.env)
		.delete(mcpOAuthState)
		.where(inArray(mcpOAuthState.stateToken, retiredTokens))
	await Promise.all(
		matching.flatMap((row) => {
			if (row.serverSlug === slug) return []
			const slack = row.context?.slack
			if (!slack?.buttons?.some((button) => button.slug === slug)) return []
			return [
				db(args.env)
					.update(mcpOAuthState)
					.set({
						context: {
							...row.context,
							slack: {
								...slack,
								buttons: slack.buttons.filter((button) => button.slug !== slug),
							},
						},
					})
					.where(eq(mcpOAuthState.stateToken, row.stateToken)),
			]
		}),
	)

	const label = mcpAppDisplayName(slug)
	const updated = await Promise.all(
		[...responseCards].map(async ([responseUrl, buttons]) => {
			const remaining = buttons
				.filter((button) => button.slug !== slug)
				.map((button) => ({
					slug: button.slug,
					label: button.label,
					authUrl: button.authUrl,
					stateToken: button.stateToken,
				}))
			return updateSlackInteractionResponse(responseUrl, {
				text: `${label} connection skipped`,
				blocks: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `*${label} connection skipped.* I'll check whether a connected teammate can approve temporary access instead.`,
						},
					},
					...mcpConnectButtonsBlocks(remaining),
				],
				replaceOriginal: true,
			})
		}),
	)
	return {
		invalidated: retiredTokens.length,
		updatedCards: updated.filter(Boolean).length,
	}
}

export async function postSlackMcpConnectConfirmation(
	env: Env,
	args: {
		orgId: string
		teamId: string
		channel: string
		threadTs: string
		slug: string
	},
): Promise<void> {
	const ws = await getWorkspaceByTeamId(env, args.teamId)
	if (!ws) return
	if (ws.orgId !== args.orgId) {
		console.error(
			`[mcp-connect] Slack confirmation dropped: workspace rebound team=${args.teamId} expectedOrg=${args.orgId} currentOrg=${ws.orgId}`,
		)
		return
	}
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	const entry = getCatalogEntry(args.slug)
	const label = entry?.name ?? args.slug
	const { postSlackMessage } = await import("./client")
	await postSlackMessage(
		botToken,
		args.channel,
		`${label} connected.`,
		args.threadTs,
	)
}
