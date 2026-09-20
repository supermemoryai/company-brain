import { and, asc, db, eq, sql, withTransaction } from "@repo/db"
import {
	member,
	organization,
	organizationSettings,
	user,
} from "@repo/db/schema/auth"
import { slackWorkspace, slackWorkspaceMember } from "@repo/db/schema/slack"
import { ROLE_ADMIN, ROLE_OWNER } from "@repo/lib/permissions"
import { getAgentByName } from "agents"
import type { Context } from "hono"
import { decryptToken } from "@/lib/crypto"
import type { AppContext } from "@/types"
import type { CompanyBrainAgent } from "../turn/agent"
import type { SlackUninstallOutcome, SlackUserInfo } from "./client"
import {
	getBotConversations,
	getSlackBotUserId,
	postSlackMessageIdempotent,
	uninstallSlackApp,
} from "./client"
import { postSlackFarewell } from "./farewell"
import { companyBrainDisconnectMessage } from "./home-welcome"

export type SlackMemberLookup = "found" | "no_slack_email" | "not_in_org"
export type SlackActorLookup =
	| "mapped"
	| "email_matched"
	| "mapped_not_in_org"
	| "no_slack_email"
	| "not_in_org"

export type SlackOrgActor = {
	userId: string
	isAdmin: boolean
}

export type SlackActorResolution = {
	actor: SlackOrgActor | null
	lookup: SlackActorLookup
}

export class SlackWorkspaceOrgConflictError extends Error {
	constructor() {
		super("Slack workspace is already connected to another organization")
		this.name = "SlackWorkspaceOrgConflictError"
	}
}

function displayValue(value: string | null | undefined): string | undefined {
	const trimmed = value?.replace(/\s+/g, " ").trim()
	return trimmed || undefined
}

export function escapeSlackText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
}

function slackDisplayValue(
	value: string | null | undefined,
): string | undefined {
	const displayed = displayValue(value)
	return displayed ? escapeSlackText(displayed) : undefined
}

export function slackUserDisplayName(
	slackUser: Pick<SlackUserInfo, "name" | "displayName" | "handle"> | undefined,
): string | undefined {
	return (
		displayValue(slackUser?.displayName) ??
		displayValue(slackUser?.name) ??
		displayValue(slackUser?.handle)
	)
}

export function shouldPostSlackOrgMemberDenial(args: {
	forceFullTurn?: boolean
	isMention?: boolean
	isNameAddressed?: boolean
	isDM?: boolean
	isAssistantThread?: boolean
}): boolean {
	return Boolean(
		args.forceFullTurn ||
			args.isMention ||
			args.isNameAddressed ||
			args.isDM ||
			args.isAssistantThread,
	)
}

export function formatSlackProfileLookupFailure(): string {
	return "I couldn't verify your Slack profile right now. Please try again in a moment."
}

export function formatSlackOrgMemberDenial(args: {
	personName?: string
	orgName?: string | null
}): string {
	const personName = slackDisplayValue(args.personName)
	const greeting = personName ? `Hey ${personName},` : "Hey there,"
	const orgName = slackDisplayValue(args.orgName)
	const orgLabel = orgName ?? "this organization"
	const adminLabel = orgName ? `a ${orgName} admin` : "an organization admin"
	return `${greeting} I couldn't verify your ${orgLabel} membership using your Slack email. If you already have access through another email, verify your Supermemory account. Otherwise, ask ${adminLabel} to invite you.`
}

// Map a Slack member's email to their Supermemory user + admin role for connection scoping.
export async function getOrgActorByEmail(
	env: Env,
	orgId: string,
	email: string | undefined,
): Promise<SlackOrgActor | null> {
	const normalized = email?.trim().toLowerCase()
	if (!normalized) return null
	const [row] = await db(env)
		.select({ userId: user.id, role: member.role })
		.from(user)
		.innerJoin(
			member,
			and(eq(member.userId, user.id), eq(member.organizationId, orgId)),
		)
		.where(sql`lower(${user.email}) = ${normalized}`)
		.limit(1)
	if (!row) return null
	return {
		userId: row.userId,
		isAdmin: row.role === ROLE_ADMIN || row.role === ROLE_OWNER,
	}
}

export async function upsertSlackWorkspaceMember(
	env: Env,
	args: {
		teamId: string
		slackUserId: string
		orgId: string
		userId: string
		email?: string
		linkSource: "email_match" | "web_confirmed"
	},
): Promise<void> {
	await withTransaction(db(env), async (tx) => {
		const [existing] = await tx
			.select({ orgId: slackWorkspaceMember.orgId })
			.from(slackWorkspaceMember)
			.where(
				and(
					eq(slackWorkspaceMember.teamId, args.teamId),
					eq(slackWorkspaceMember.slackUserId, args.slackUserId),
				),
			)
			.limit(1)
		if (existing && existing.orgId !== args.orgId) {
			throw new SlackWorkspaceOrgConflictError()
		}
		await tx
			.insert(slackWorkspaceMember)
			.values({
				teamId: args.teamId,
				slackUserId: args.slackUserId,
				orgId: args.orgId,
				userId: args.userId,
				email: args.email?.trim().toLowerCase() || null,
				status: "active",
				linkSource: args.linkSource,
				provisionedMemberId: null,
			})
			.onConflictDoUpdate({
				target: [slackWorkspaceMember.teamId, slackWorkspaceMember.slackUserId],
				set: {
					orgId: args.orgId,
					userId: sql`
						CASE
							WHEN ${slackWorkspaceMember.linkSource} = 'web_confirmed'
								THEN ${slackWorkspaceMember.userId}
							ELSE excluded.user_id
						END
					`,
					email: args.email?.trim().toLowerCase() || null,
					status: "active",
					linkSource: sql`
						CASE
							WHEN ${slackWorkspaceMember.linkSource} = 'web_confirmed'
								THEN 'web_confirmed'
							ELSE excluded.link_source
						END
					`,
					updatedAt: new Date(),
				},
			})
	})
}

// Stable Slack identity wins. Email is only a legacy bootstrap path and is
// upgraded to a durable mapping after an exact organization-member match.
export async function getOrgActorBySlackIdentity(
	env: Env,
	args: {
		orgId: string
		teamId: string
		slackUserId: string
		email?: string
	},
): Promise<SlackActorResolution> {
	if (!args.slackUserId.trim()) {
		return { actor: null, lookup: "no_slack_email" }
	}

	const [mapping] = await db(env)
		.select({
			userId: slackWorkspaceMember.userId,
			status: slackWorkspaceMember.status,
		})
		.from(slackWorkspaceMember)
		.where(
			and(
				eq(slackWorkspaceMember.teamId, args.teamId),
				eq(slackWorkspaceMember.slackUserId, args.slackUserId),
				eq(slackWorkspaceMember.orgId, args.orgId),
			),
		)
		.limit(1)

	if (mapping) {
		if (mapping.status !== "active") {
			return { actor: null, lookup: "mapped_not_in_org" }
		}
		const [mappedMember] = await db(env)
			.select({ role: member.role })
			.from(member)
			.where(
				and(
					eq(member.organizationId, args.orgId),
					eq(member.userId, mapping.userId),
				),
			)
			.limit(1)
		if (!mappedMember) {
			return { actor: null, lookup: "mapped_not_in_org" }
		}
		return {
			actor: {
				userId: mapping.userId,
				isAdmin:
					mappedMember.role === ROLE_ADMIN || mappedMember.role === ROLE_OWNER,
			},
			lookup: "mapped",
		}
	}

	const actor = await getOrgActorByEmail(env, args.orgId, args.email)
	if (!actor) {
		return {
			actor: null,
			lookup: args.email?.trim() ? "not_in_org" : "no_slack_email",
		}
	}
	await upsertSlackWorkspaceMember(env, {
		...args,
		userId: actor.userId,
		linkSource: "email_match",
	})
	return { actor, lookup: "email_matched" }
}
export type SlackOrg = {
	id: string
	name: string
	slug: string | null
	metadata: Record<string, unknown> | null
}

export type SlackWorkspaceRow = {
	teamId: string
	orgId: string
	orgName: string
	orgSlug: string | null
	orgMetadata: Record<string, unknown> | null
	brainProactivity: unknown
	botTokenEnc: string
	botUserId: string | null
	installedByUserId: string | null
	teamName: string | null
	scopes: string | null
}

export async function getWorkspaceByTeamId(
	env: Env,
	teamId: string,
): Promise<SlackWorkspaceRow | null> {
	const [row] = await db(env)
		.select({
			teamId: slackWorkspace.teamId,
			orgId: slackWorkspace.orgId,
			botTokenEnc: slackWorkspace.botTokenEnc,
			botUserId: slackWorkspace.botUserId,
			installedByUserId: slackWorkspace.installedByUserId,
			teamName: slackWorkspace.teamName,
			scopes: slackWorkspace.scopes,
			orgName: organization.name,
			orgSlug: organization.slug,
			orgMetadata: organization.metadata,
			brainProactivity: organizationSettings.brainProactivity,
		})
		.from(slackWorkspace)
		.innerJoin(organization, eq(slackWorkspace.orgId, organization.id))
		.leftJoin(
			organizationSettings,
			eq(organizationSettings.orgId, organization.id),
		)
		.where(eq(slackWorkspace.teamId, teamId))
		.limit(1)
	if (!row) return null
	return {
		...row,
		orgMetadata: row.orgMetadata as Record<string, unknown> | null,
	}
}

// Connection status for the in-app "Add Supermemory to your Slack" card.
export async function getWorkspaceStatusByOrgId(
	env: Env,
	orgId: string,
): Promise<{ connected: boolean; teamName: string | null }> {
	const [row] = await db(env)
		.select({
			teamId: slackWorkspace.teamId,
			teamName: slackWorkspace.teamName,
		})
		.from(slackWorkspace)
		.where(eq(slackWorkspace.orgId, orgId))
		.limit(1)
	return { connected: !!row, teamName: row?.teamName ?? null }
}

export type SlackInstallRow = {
	orgId: string
	orgName: string | null
	teamId: string
	teamName: string | null
	botUserId: string | null
	installedAt: Date
}

export async function listConnectedSlackInstalls(
	env: Env,
): Promise<SlackInstallRow[]> {
	return db(env)
		.select({
			orgId: slackWorkspace.orgId,
			orgName: organization.name,
			teamId: slackWorkspace.teamId,
			teamName: slackWorkspace.teamName,
			botUserId: slackWorkspace.botUserId,
			installedAt: slackWorkspace.createdAt,
		})
		.from(slackWorkspace)
		.innerJoin(organization, eq(slackWorkspace.orgId, organization.id))
		.orderBy(asc(organization.name), asc(slackWorkspace.teamId))
}

export type SlackTeardownResult = {
	disconnected: boolean
	revoked: boolean
	reason?: "not_connected" | "cleanup_failed"
}

export type SlackAnnounceResult = {
	outcome: "done" | "hold" | "not_connected"
	posted: number
	alreadyPosted: number
	skipped: number
}

// Runs before teardown so the token and home-channel id are still available.
export async function announceSlackWorkspaceFarewell(
	env: Env,
	orgId: string,
	farewell: { kind: string; text: string },
): Promise<SlackAnnounceResult> {
	const rows = await db(env)
		.select({
			teamId: slackWorkspace.teamId,
			botTokenEnc: slackWorkspace.botTokenEnc,
		})
		.from(slackWorkspace)
		.where(eq(slackWorkspace.orgId, orgId))
	if (rows.length === 0) {
		return { outcome: "not_connected", posted: 0, alreadyPosted: 0, skipped: 0 }
	}

	const homeChannelIdByTeam = new Map<string, string>()
	try {
		const agent = (await getAgentByName(
			env.COMPANY_BRAIN_AGENT,
			orgId,
		)) as unknown as CompanyBrainAgent
		const home = await agent.getHomeChannel()
		if (home) homeChannelIdByTeam.set(home.teamId, home.channelId)
	} catch (error) {
		console.warn(
			`[slack] farewell home snapshot failed org=${orgId}, falling back to channel list:`,
			error instanceof Error ? error.message : error,
		)
	}

	const deps = {
		postMessageIdempotent: postSlackMessageIdempotent,
		listBotConversations: (botToken: string) =>
			getBotConversations(botToken, 1000, true),
	}
	let posted = 0
	let alreadyPosted = 0
	let skipped = 0
	for (const row of rows) {
		let botToken: string
		try {
			botToken = await decryptToken(row.botTokenEnc, env.ENCRYPTION_SECRET)
		} catch (error) {
			console.warn(
				`[slack] farewell decrypt failed org=${orgId} team=${row.teamId}:`,
				error instanceof Error ? error.message : error,
			)
			skipped += 1
			continue
		}
		const outcome = await postSlackFarewell({
			botToken,
			teamId: row.teamId,
			kind: farewell.kind,
			text: farewell.text,
			knownHomeChannelId: homeChannelIdByTeam.get(row.teamId),
			deps,
		})
		if (outcome === "hold") {
			return { outcome: "hold", posted, alreadyPosted, skipped }
		}
		if (outcome === "posted") posted += 1
		else if (outcome === "already_posted") alreadyPosted += 1
		else skipped += 1
	}
	console.log(
		`[slack] farewell org=${orgId} kind=${farewell.kind} posted=${posted} alreadyPosted=${alreadyPosted} skipped=${skipped}`,
	)
	return { outcome: "done", posted, alreadyPosted, skipped }
}

// A held farewell fails before teardown so the retry can still post it.
export async function disconnectSlackWorkspace(
	env: Env,
	orgId: string,
): Promise<SlackTeardownResult> {
	const announced = await announceSlackWorkspaceFarewell(env, orgId, {
		kind: "bye",
		text: companyBrainDisconnectMessage(),
	})
	if (announced.outcome === "not_connected") {
		return { disconnected: false, revoked: false, reason: "not_connected" }
	}
	if (announced.outcome === "hold") {
		return { disconnected: false, revoked: false, reason: "cleanup_failed" }
	}
	return teardownSlackWorkspace(env, orgId)
}

// Agent state clears before any row is deleted so a failure stays retryable.
export async function teardownSlackWorkspace(
	env: Env,
	orgId: string,
): Promise<SlackTeardownResult> {
	const rows = await db(env)
		.select({
			teamId: slackWorkspace.teamId,
			botTokenEnc: slackWorkspace.botTokenEnc,
		})
		.from(slackWorkspace)
		.where(eq(slackWorkspace.orgId, orgId))
	if (rows.length === 0) {
		return { disconnected: false, revoked: false, reason: "not_connected" }
	}

	try {
		const agent = (await getAgentByName(
			env.COMPANY_BRAIN_AGENT,
			orgId,
		)) as unknown as CompanyBrainAgent
		await agent.resetSlackWorkspaceState()
	} catch (error) {
		console.error(
			`[slack] agent state reset failed org=${orgId}, leaving workspace intact:`,
			error instanceof Error ? error.message : error,
		)
		return { disconnected: false, revoked: false, reason: "cleanup_failed" }
	}

	let revoked = true
	let removed = 0
	let pending = 0
	let replaced = false
	for (const row of rows) {
		let outcome: SlackUninstallOutcome
		try {
			outcome = await uninstallSlackApp(
				await decryptToken(row.botTokenEnc, env.ENCRYPTION_SECRET),
				env,
			)
		} catch (error) {
			console.warn(
				`[slack] uninstall failed org=${orgId} team=${row.teamId}:`,
				error instanceof Error ? error.message : error,
			)
			outcome = "terminal"
		}
		if (outcome === "transient") {
			pending += 1
			revoked = false
			continue
		}
		revoked = revoked && outcome === "revoked"

		const deleted = await withTransaction(db(env), async (tx) => {
			const gone = await tx
				.delete(slackWorkspace)
				.where(
					and(
						eq(slackWorkspace.orgId, orgId),
						eq(slackWorkspace.teamId, row.teamId),
						eq(slackWorkspace.botTokenEnc, row.botTokenEnc),
					),
				)
				.returning({ teamId: slackWorkspace.teamId })
			if (gone.length === 0) {
				const [survivor] = await tx
					.select({ teamId: slackWorkspace.teamId })
					.from(slackWorkspace)
					.where(
						and(
							eq(slackWorkspace.orgId, orgId),
							eq(slackWorkspace.teamId, row.teamId),
						),
					)
					.limit(1)
				return { removed: false, replaced: Boolean(survivor) }
			}
			await tx
				.delete(slackWorkspaceMember)
				.where(eq(slackWorkspaceMember.teamId, row.teamId))
			return { removed: true, replaced: false }
		})
		if (deleted.replaced) replaced = true
		if (deleted.removed) removed += 1
	}

	if (pending > 0 || replaced) {
		console.warn(
			`[slack] disconnect incomplete org=${orgId} removed=${removed} pending=${pending} replaced=${replaced}`,
		)
		return { disconnected: false, revoked: false, reason: "cleanup_failed" }
	}

	console.log(`[slack] disconnected org=${orgId} installations=${removed}`)
	return { disconnected: true, revoked }
}

export async function getWorkspaceTokenByOrgId(
	env: Env,
	orgId: string,
): Promise<{ botTokenEnc: string } | null> {
	const [row] = await db(env)
		.select({ botTokenEnc: slackWorkspace.botTokenEnc })
		.from(slackWorkspace)
		.where(eq(slackWorkspace.orgId, orgId))
		.limit(1)
	return row ?? null
}

export async function getWorkspaceTeamIdByOrgId(
	env: Env,
	orgId: string,
): Promise<string | null> {
	const [row] = await db(env)
		.select({ teamId: slackWorkspace.teamId })
		.from(slackWorkspace)
		.where(eq(slackWorkspace.orgId, orgId))
		.limit(1)
	return row?.teamId ?? null
}

export async function upsertWorkspace(
	env: Env,
	values: {
		teamId: string
		orgId: string
		botTokenEnc: string
		botUserId?: string | null
		teamName?: string | null
		installedByUserId?: string | null
		scopes?: string | null
		appId?: string | null
	},
): Promise<void> {
	const row = {
		teamId: values.teamId,
		orgId: values.orgId,
		botTokenEnc: values.botTokenEnc,
		botUserId: values.botUserId ?? null,
		teamName: values.teamName ?? null,
		installedByUserId: values.installedByUserId ?? null,
		scopes: values.scopes ?? null,
		appId: values.appId ?? null,
	}
	await withTransaction(db(env), async (tx) => {
		const [existing] = await tx
			.select({ orgId: slackWorkspace.orgId })
			.from(slackWorkspace)
			.where(eq(slackWorkspace.teamId, values.teamId))
			.limit(1)
		if (existing && existing.orgId !== values.orgId) {
			throw new SlackWorkspaceOrgConflictError()
		}
		await tx
			.insert(slackWorkspace)
			.values(row)
			.onConflictDoUpdate({
				target: slackWorkspace.teamId,
				set: { ...row, updatedAt: new Date() },
			})
	})
}

/** Backfill bot user id for workspaces installed before we persisted it. */
export async function ensureWorkspaceBotUserId(
	env: Env,
	ws: SlackWorkspaceRow,
	botToken: string,
	prefetchedUserId?: string,
): Promise<string | null> {
	if (ws.botUserId) return ws.botUserId
	const botUserId = prefetchedUserId ?? (await getSlackBotUserId(botToken))
	if (!botUserId) return null
	await db(env)
		.update(slackWorkspace)
		.set({ botUserId, updatedAt: new Date() })
		.where(eq(slackWorkspace.teamId, ws.teamId))
	return botUserId
}

export function makeSlackSearchContext(
	env: Env,
	executionCtx: ExecutionContext | undefined,
	org: SlackOrg,
	userId: string,
): Context<AppContext, "*", Record<string, unknown>> {
	const ctx =
		executionCtx ??
		({
			waitUntil: (p: Promise<unknown>) => {
				void Promise.resolve(p).catch(() => undefined)
			},
			passThroughOnException: () => undefined,
		} as unknown as ExecutionContext)
	return {
		get: (key: string) => {
			switch (key) {
				case "org":
					return org
				case "user":
					return { id: userId }
				default:
					return undefined
			}
		},
		env,
		executionCtx: ctx,
		req: { raw: { headers: new Headers() } },
	} as unknown as Context<AppContext, "*", Record<string, unknown>>
}
