import { and, db, eq, gt, isNull } from "@repo/db"
import { member, organization, user } from "@repo/db/schema/auth"
import {
	slackAccountLinkState,
	slackWorkspace,
	slackWorkspaceMember,
} from "@repo/db/schema/slack"
import { ROLE_MEMBER } from "@repo/lib/permissions"
import {
	openSlackConversation,
	postSlackEphemeral,
	postSlackMessage,
} from "./client"
import { slackIdentityAdvisoryLockQuery } from "./identity-lock"

const ACCOUNT_LINK_TTL_MS = 15 * 60 * 1_000

async function sha256Hex(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value)
	const digest = await crypto.subtle.digest("SHA-256", bytes)
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")
}

function novaBaseUrl(env: Env): string {
	try {
		const url = new URL(env.PUBLIC_URL)
		if (url.hostname.startsWith("api.")) {
			url.hostname = `app.${url.hostname.slice("api.".length)}`
			return url.origin
		}
		if (url.hostname.includes(".api.")) {
			url.hostname = url.hostname.replace(".api.", ".app.")
			return url.origin
		}
	} catch {}
	return "https://app.supermemory.ai"
}

export async function createSlackAccountLinkUrl(
	env: Env,
	args: {
		teamId: string
		slackUserId: string
		orgId: string
		slackEmail?: string
		slackDisplayName?: string
	},
): Promise<string> {
	const token = crypto.randomUUID()
	const tokenHash = await sha256Hex(token)
	const now = new Date()
	await db(env).transaction(async (tx) => {
		await tx
			.update(slackAccountLinkState)
			.set({ consumedAt: now })
			.where(
				and(
					eq(slackAccountLinkState.teamId, args.teamId),
					eq(slackAccountLinkState.slackUserId, args.slackUserId),
					isNull(slackAccountLinkState.consumedAt),
					gt(slackAccountLinkState.expiresAt, now),
				),
			)
		await tx.insert(slackAccountLinkState).values({
			tokenHash,
			teamId: args.teamId,
			slackUserId: args.slackUserId,
			orgId: args.orgId,
			slackEmail: args.slackEmail?.trim().toLowerCase() || null,
			slackDisplayName: args.slackDisplayName?.trim() || null,
			expiresAt: new Date(now.getTime() + ACCOUNT_LINK_TTL_MS),
		})
	})
	const url = new URL("/slack/link", novaBaseUrl(env))
	url.searchParams.set("token", token)
	return url.toString()
}

function accountLinkBlocks(args: {
	orgName: string
	linkUrl: string
}): unknown[] {
	return [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `I couldn't verify your *${args.orgName}* membership using your Slack email. If you already have access through another email, verify your Supermemory account. Otherwise, ask a *${args.orgName}* admin to invite you.`,
			},
		},
		{
			type: "actions",
			elements: [
				{
					type: "button",
					text: {
						type: "plain_text",
						text: "Verify Supermemory account",
						emoji: true,
					},
					url: args.linkUrl,
					style: "primary",
				},
			],
		},
		{
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: "This link expires in 15 minutes and can only be used once.",
				},
			],
		},
	]
}

export async function postSlackAccountLinkPrompt(
	env: Env,
	args: {
		botToken: string
		teamId: string
		slackUserId: string
		orgId: string
		orgName: string
		channel: string
		threadTs?: string
		isDM: boolean
		slackEmail?: string
		slackDisplayName?: string
	},
): Promise<boolean> {
	const linkUrl = await createSlackAccountLinkUrl(env, args)
	const text = `I couldn't verify your ${args.orgName} membership using your Slack email. If you already have access through another email, verify your Supermemory account. Otherwise, ask a ${args.orgName} admin to invite you.`
	const blocks = accountLinkBlocks({ orgName: args.orgName, linkUrl })
	if (args.isDM) {
		return Boolean(
			await postSlackMessage(
				args.botToken,
				args.channel,
				text,
				args.threadTs,
				blocks,
			),
		)
	}
	return postSlackEphemeral(
		args.botToken,
		args.channel,
		args.slackUserId,
		text,
		args.threadTs,
		blocks,
	)
}

export type SlackAccountLinkPreview =
	| {
			status: "ready"
			orgName: string
			teamId: string
			teamName: string | null
			slackDisplayName: string | null
			slackEmail: string | null
			signedInEmail: string
			isOrgMember: boolean
			requiresRelink: boolean
	  }
	| { status: "expired" | "used" | "invalid" }

export async function getSlackAccountLinkPreview(
	env: Env,
	token: string,
	userId: string,
): Promise<SlackAccountLinkPreview> {
	const tokenHash = await sha256Hex(token)
	const [state] = await db(env)
		.select({
			orgId: slackAccountLinkState.orgId,
			teamId: slackAccountLinkState.teamId,
			slackUserId: slackAccountLinkState.slackUserId,
			slackEmail: slackAccountLinkState.slackEmail,
			slackDisplayName: slackAccountLinkState.slackDisplayName,
			expiresAt: slackAccountLinkState.expiresAt,
			consumedAt: slackAccountLinkState.consumedAt,
			orgName: organization.name,
			teamName: slackWorkspace.teamName,
		})
		.from(slackAccountLinkState)
		.innerJoin(organization, eq(slackAccountLinkState.orgId, organization.id))
		.innerJoin(
			slackWorkspace,
			eq(slackAccountLinkState.teamId, slackWorkspace.teamId),
		)
		.where(eq(slackAccountLinkState.tokenHash, tokenHash))
		.limit(1)
	if (!state) return { status: "invalid" }
	if (state.consumedAt) return { status: "used" }
	if (state.expiresAt.getTime() <= Date.now()) return { status: "expired" }

	const [[signedInUser], [orgMember], [mapping]] = await Promise.all([
		db(env)
			.select({ email: user.email })
			.from(user)
			.where(eq(user.id, userId))
			.limit(1),
		db(env)
			.select({ role: member.role })
			.from(member)
			.where(
				and(eq(member.organizationId, state.orgId), eq(member.userId, userId)),
			)
			.limit(1),
		db(env)
			.select({ userId: slackWorkspaceMember.userId })
			.from(slackWorkspaceMember)
			.where(
				and(
					eq(slackWorkspaceMember.teamId, state.teamId),
					eq(slackWorkspaceMember.slackUserId, state.slackUserId),
					eq(slackWorkspaceMember.orgId, state.orgId),
				),
			)
			.limit(1),
	])
	if (!signedInUser) return { status: "invalid" }

	return {
		status: "ready",
		orgName: state.orgName,
		teamId: state.teamId,
		teamName: state.teamName,
		slackDisplayName: state.slackDisplayName,
		slackEmail: state.slackEmail,
		signedInEmail: signedInUser.email,
		isOrgMember: Boolean(orgMember),
		requiresRelink: Boolean(mapping && mapping.userId !== userId),
	}
}

export type CompletedSlackAccountLink =
	| {
			ok: true
			teamId: string
			slackUserId: string
			orgId: string
			orgName: string
	  }
	| {
			ok: false
			reason: "expired" | "used" | "invalid" | "not_in_org"
	  }

export async function completeSlackAccountLink(
	env: Env,
	token: string,
	userId: string,
): Promise<CompletedSlackAccountLink> {
	const tokenHash = await sha256Hex(token)
	return db(env).transaction(async (tx) => {
		const [state] = await tx
			.select({
				teamId: slackAccountLinkState.teamId,
				slackUserId: slackAccountLinkState.slackUserId,
				orgId: slackAccountLinkState.orgId,
				slackEmail: slackAccountLinkState.slackEmail,
				expiresAt: slackAccountLinkState.expiresAt,
				consumedAt: slackAccountLinkState.consumedAt,
				orgName: organization.name,
			})
			.from(slackAccountLinkState)
			.innerJoin(organization, eq(slackAccountLinkState.orgId, organization.id))
			.where(eq(slackAccountLinkState.tokenHash, tokenHash))
			.limit(1)
		if (!state) return { ok: false, reason: "invalid" } as const
		if (state.consumedAt) return { ok: false, reason: "used" } as const
		const now = new Date()
		if (state.expiresAt <= now) return { ok: false, reason: "expired" } as const

		const [orgMember] = await tx
			.select({ role: member.role })
			.from(member)
			.where(
				and(eq(member.organizationId, state.orgId), eq(member.userId, userId)),
			)
			.limit(1)
		if (!orgMember) return { ok: false, reason: "not_in_org" } as const

		await tx.execute(
			slackIdentityAdvisoryLockQuery(state.teamId, state.slackUserId),
		)
		const [existingMapping] = await tx
			.select({
				orgId: slackWorkspaceMember.orgId,
				userId: slackWorkspaceMember.userId,
				provisionedMemberId: slackWorkspaceMember.provisionedMemberId,
			})
			.from(slackWorkspaceMember)
			.where(
				and(
					eq(slackWorkspaceMember.teamId, state.teamId),
					eq(slackWorkspaceMember.slackUserId, state.slackUserId),
				),
			)
			.limit(1)
		if (existingMapping && existingMapping.orgId !== state.orgId) {
			return { ok: false, reason: "invalid" } as const
		}

		const consumed = await tx
			.update(slackAccountLinkState)
			.set({ consumedAt: now })
			.where(
				and(
					eq(slackAccountLinkState.tokenHash, tokenHash),
					isNull(slackAccountLinkState.consumedAt),
					gt(slackAccountLinkState.expiresAt, now),
				),
			)
			.returning({ tokenHash: slackAccountLinkState.tokenHash })
		if (!consumed.length) return { ok: false, reason: "used" } as const

		if (
			existingMapping?.userId !== userId &&
			existingMapping?.provisionedMemberId
		) {
			const [oldMembership] = await tx
				.select({ role: member.role })
				.from(member)
				.where(
					and(
						eq(member.id, existingMapping.provisionedMemberId),
						eq(member.organizationId, state.orgId),
						eq(member.userId, existingMapping.userId),
					),
				)
				.limit(1)
			const activeMappings = await tx
				.select({
					teamId: slackWorkspaceMember.teamId,
					slackUserId: slackWorkspaceMember.slackUserId,
				})
				.from(slackWorkspaceMember)
				.where(
					and(
						eq(slackWorkspaceMember.orgId, state.orgId),
						eq(slackWorkspaceMember.userId, existingMapping.userId),
						eq(slackWorkspaceMember.status, "active"),
					),
				)
			const hasOtherActiveMapping = activeMappings.some(
				(mapping) =>
					mapping.teamId !== state.teamId ||
					mapping.slackUserId !== state.slackUserId,
			)
			if (oldMembership?.role === ROLE_MEMBER && !hasOtherActiveMapping) {
				await tx
					.delete(member)
					.where(
						and(
							eq(member.id, existingMapping.provisionedMemberId),
							eq(member.organizationId, state.orgId),
							eq(member.userId, existingMapping.userId),
						),
					)
			}
		}

		await tx
			.insert(slackWorkspaceMember)
			.values({
				teamId: state.teamId,
				slackUserId: state.slackUserId,
				orgId: state.orgId,
				userId,
				email: state.slackEmail,
				status: "active",
				linkSource: "web_confirmed",
				provisionedMemberId: null,
			})
			.onConflictDoUpdate({
				target: [slackWorkspaceMember.teamId, slackWorkspaceMember.slackUserId],
				set: {
					orgId: state.orgId,
					userId,
					email: state.slackEmail,
					status: "active",
					linkSource: "web_confirmed",
					// A changed link targets an already-existing org member, so
					// provisioning provenance must not transfer between users.
					provisionedMemberId:
						existingMapping?.userId === userId
							? existingMapping.provisionedMemberId
							: null,
					updatedAt: now,
				},
			})

		return {
			ok: true,
			teamId: state.teamId,
			slackUserId: state.slackUserId,
			orgId: state.orgId,
			orgName: state.orgName,
		} as const
	})
}

export async function notifySlackAccountLinked(
	botToken: string,
	args: { slackUserId: string; orgName: string },
): Promise<void> {
	const channel = await openSlackConversation(botToken, args.slackUserId)
	if (!channel) return
	await postSlackMessage(
		botToken,
		channel,
		`Your Slack account is now linked to ${args.orgName}. You can return to your conversation and try again.`,
	)
}
