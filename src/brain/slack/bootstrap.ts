import { getAgentByName } from "agents"
import { mergedOrgMetadata } from "@/lib/org-metadata-sql"
import { identifyCompanyGroup } from "@/lib/posthog"
import { companyDomain } from "../company-domain"
import { getSlackUserInfo } from "./client"
import {
	COMPANY_BRAIN_HOME_WELCOME_VERSION,
	companyBrainHomeWelcomeMessages,
} from "./home-welcome"

const SLACK_API = "https://slack.com/api"
const HOME_CHANNEL_NAME = "company-brain"
// 25k channels: enough for any real workspace, still bounded.
const CHANNEL_PAGE_SIZE = 1000
const MAX_CHANNEL_PAGES = 25

async function slackCall(
	botToken: string,
	method: string,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const res = await fetch(`${SLACK_API}/${method}`, {
		method: "POST",
		headers: {
			"content-type": "application/json; charset=utf-8",
			authorization: `Bearer ${botToken}`,
		},
		body: JSON.stringify(body),
	})
	return (await res.json().catch(() => ({ ok: false }))) as Record<
		string,
		unknown
	>
}

// team.info email_domain can be a comma-separated list; take the first real one.
async function getTeamEmailDomain(botToken: string): Promise<string | null> {
	const data = await slackCall(botToken, "team.info", {})
	if (data.ok !== true) return null
	const team = data.team as { email_domain?: string } | undefined
	for (const part of (team?.email_domain ?? "").split(",")) {
		const domain = companyDomain(part)
		if (domain) return domain
	}
	return null
}

function getInstallerEmailDomain(email: string | undefined): string | null {
	const at = email?.lastIndexOf("@") ?? -1
	if (at < 0) return null
	return companyDomain(email?.slice(at + 1))
}

async function findChannelByName(
	botToken: string,
	name: string,
): Promise<string | null> {
	let cursor: string | undefined
	for (let page = 0; page < MAX_CHANNEL_PAGES; page++) {
		const data = await slackCall(botToken, "conversations.list", {
			types: "public_channel",
			exclude_archived: true,
			limit: CHANNEL_PAGE_SIZE,
			...(cursor ? { cursor } : {}),
		})
		if (data.ok !== true) {
			console.warn(`[slack] conversations.list failed: ${data.error}`)
			return null
		}
		const channels = (data.channels ?? []) as { id: string; name: string }[]
		const hit = channels.find((c) => c.name === name)
		if (hit) return hit.id
		cursor = (data.response_metadata as { next_cursor?: string } | undefined)
			?.next_cursor
		if (!cursor) return null
	}
	console.warn(
		`[slack] gave up looking for #${name} after ${MAX_CHANNEL_PAGES} pages`,
	)
	return null
}

// already_in_channel / cant_invite_self are expected on reinstall.
async function inviteToHomeChannel(
	botToken: string,
	channel: string,
	slackUserId: string,
): Promise<void> {
	const res = await slackCall(botToken, "conversations.invite", {
		channel,
		users: slackUserId,
	})
	if (
		res.ok !== true &&
		res.error !== "already_in_channel" &&
		res.error !== "cant_invite_self"
	) {
		console.warn(`[slack] conversations.invite failed: ${res.error}`)
	}
}

async function ensureHomeChannel(
	botToken: string,
): Promise<{ channelId: string; created: boolean } | null> {
	const created = await slackCall(botToken, "conversations.create", {
		name: HOME_CHANNEL_NAME,
	})
	if (created.ok === true) {
		const id = (created.channel as { id?: string } | undefined)?.id
		return id ? { channelId: id, created: true } : null
	}
	if (created.error !== "name_taken") {
		console.warn(`[slack] conversations.create failed: ${created.error}`)
		return null
	}
	const existing = await findChannelByName(botToken, HOME_CHANNEL_NAME)
	if (!existing) return null
	await slackCall(botToken, "conversations.join", { channel: existing })
	return { channelId: existing, created: false }
}

// Best-effort: never throws, so a failure can't break the OAuth callback.
export async function bootstrapSlackWorkspace(
	env: Env,
	args: {
		orgId: string
		installerUserId: string
		teamId: string
		teamName: string | null | undefined
		botToken: string
		slackUserId: string | undefined
	},
): Promise<void> {
	try {
		const [{ db, eq }, { organization }] = await Promise.all([
			import("@repo/db"),
			import("@repo/db/schema/auth"),
		])
		const [org] = await db(env)
			.select({
				id: organization.id,
				name: organization.name,
				metadata: organization.metadata,
			})
			.from(organization)
			.where(eq(organization.id, args.orgId))
			.limit(1)
		if (!org) return

		const metadata: Record<string, unknown> =
			typeof org.metadata === "string"
				? (JSON.parse(org.metadata) as Record<string, unknown>)
				: ((org.metadata as Record<string, unknown> | null) ?? {})
		const installerProfile = args.slackUserId
			? await getSlackUserInfo(args.botToken, args.slackUserId)
			: {}

		let domain = companyDomain(metadata.brainWorkspaceDomain as string)
		if (!domain) {
			domain =
				(await getTeamEmailDomain(args.botToken)) ??
				getInstallerEmailDomain(installerProfile.email)
			const patch: Record<string, unknown> = {
				...(domain ? { brainWorkspaceDomain: domain } : {}),
				...(args.teamName && !metadata.brainWorkspaceName
					? { brainWorkspaceName: args.teamName }
					: {}),
			}
			// A merge in SQL, not read-modify-write: a concurrent billing sync
			// writing activeProducts must not be clobbered by our stale copy.
			if (Object.keys(patch).length > 0) {
				await db(env)
					.update(organization)
					.set({
						metadata: mergedOrgMetadata(patch),
					})
					.where(eq(organization.id, args.orgId))
			}
		}

		identifyCompanyGroup({
			orgId: args.orgId,
			name: org.name,
			domain,
			slackTeamName: args.teamName,
		})

		const agent = await getAgentByName(env.COMPANY_BRAIN_AGENT, args.orgId)

		const home = await ensureHomeChannel(args.botToken)
		console.log(
			`[slack] bootstrap org=${args.orgId} domain=${domain ?? "?"} home=${home?.channelId ?? "none"} created=${home?.created ?? false}`,
		)
		if (home) {
			await agent.setHomeChannel({
				channelId: home.channelId,
				teamId: args.teamId,
			})
			// The installer asked for this; everyone else joins on their own.
			if (args.slackUserId) {
				await inviteToHomeChannel(
					args.botToken,
					home.channelId,
					args.slackUserId,
				)
			}
			await agent
				.ensurePublicChannelRolloutCard({
					teamId: args.teamId,
					homeChannelId: home.channelId,
					installerSlackUserId: args.slackUserId,
					welcome: {
						version: COMPANY_BRAIN_HOME_WELCOME_VERSION,
						messages: companyBrainHomeWelcomeMessages({
							adminName:
								installerProfile.displayName ??
								installerProfile.name ??
								installerProfile.handle,
						}),
					},
				})
				.catch((error) => {
					console.warn("[slack] public-channel rollout card failed:", error)
				})
			await agent
				.armPublicChannelBeachhead({
					teamId: args.teamId,
					installerSlackUserId: args.slackUserId,
				})
				.catch((error) => {
					console.warn("[slack] beachhead arm failed:", error)
				})
		}

		// researchCompanyOnSignup no-ops if a run is already queued/running/done.
		if (domain) {
			await agent.researchCompanyOnSignup({
				domain,
				ownerId: args.installerUserId,
			})
		}
		// A finished run won't fire its hooks again, so post card and digest now.
		if (home) {
			await agent.syncResearchCardIfDone().catch((error) => {
				console.warn("[slack] research card backfill failed:", error)
			})
			await agent.announceResearchIfDone()
			// Beats stay off by default, so arming only starts the timer.
			await agent.armJourney({ installedAt: Date.now() }).catch((error) => {
				console.warn("[slack] journey arm failed:", error)
			})
		}
	} catch (err) {
		console.warn("[slack] workspace bootstrap failed:", err)
	}
}
