import { Hono } from "hono"
import { asc, db, eq, sql } from "@repo/db"
import { member, organization, user } from "@repo/db/schema/auth"
import { slackWorkspace } from "@repo/db/schema/slack"
import { ROLE_MEMBER, ROLE_OWNER } from "@repo/lib/permissions"
import { slackCredentials } from "../setup/config-store"
import type { AppContext } from "@/types"
import { endSession, startSession } from "./session"

const STATE_TTL_SECONDS = 600

type SlackIdentity = {
	ok: boolean
	error?: string
	email?: string
	name?: string
	picture?: string
	"https://slack.com/user_id"?: string
	"https://slack.com/team_id"?: string
	"https://slack.com/team_name"?: string
}

function origin(env: Env, requestUrl: string): string {
	return (env.PUBLIC_URL || new URL(requestUrl).origin).replace(/\/$/, "")
}

export function signInCallbackUrl(origin: string): string {
	return `${origin}/auth/slack/callback`
}

function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 48) || "workspace"
	)
}

function refuse(message: string, status: 400 | 403 | 409 = 403): Response {
	return new Response(
		`<!doctype html><meta charset="utf-8"><title>Sign in</title><body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.3rem">Can't sign you in</h1><p>${message}</p><p><a href="/">Back</a></p></body>`,
		{ status, headers: { "content-type": "text/html; charset=utf-8" } },
	)
}

/** The Slack team this deployment belongs to, once anyone has claimed it. */
async function deploymentOrg(env: Env) {
	const [org] = await db(env)
		.select()
		.from(organization)
		.orderBy(asc(organization.createdAt))
		.limit(1)
	if (!org) return null
	const [installed] = await db(env)
		.select({ teamId: slackWorkspace.teamId })
		.from(slackWorkspace)
		.where(eq(slackWorkspace.orgId, org.id))
		.limit(1)
	const claimedTeam =
		installed?.teamId ??
		(typeof org.metadata?.slackTeamId === "string"
			? org.metadata.slackTeamId
			: null)
	return { org, teamId: claimedTeam }
}

/**
 * Sign in with Slack, using the same app credentials the setup wizard stored.
 * A deployment serves one workspace: the first person to sign in creates the
 * organization and owns it, and everyone after must come from that workspace.
 */
export const authRoutes = new Hono<AppContext>()
	.get("/session", async (c) => {
		const currentUser = c.get("user")
		const org = c.get("org")
		if (!currentUser || !org) {
			// Signed out on a deployment that isn't set up yet: the app sends
			// people to /setup instead of a sign-in button that can't work.
			const [credentials, installed] = await Promise.all([
				slackCredentials(c.env).catch(() => null),
				db(c.env)
					.select({ teamId: slackWorkspace.teamId })
					.from(slackWorkspace)
					.limit(1)
					.catch(() => []),
			])
			return c.json({
				user: null,
				org: null,
				role: null,
				setupComplete: Boolean(credentials) && installed.length > 0,
			})
		}
		return c.json({
			user: {
				id: currentUser.id,
				email: currentUser.email,
				name: currentUser.name,
				image: currentUser.image ?? null,
			},
			org: { id: org.id, name: org.name, slug: org.slug, logo: org.logo ?? null },
			role: c.get("memberRole"),
		})
	})
	.get("/slack/login", async (c) => {
		const credentials = await slackCredentials(c.env)
		if (!credentials) return c.redirect("/setup")

		const state = crypto.randomUUID()
		await c.env.BRAIN_KV.put(`auth:slack:${state}`, "1", {
			expirationTtl: STATE_TTL_SECONDS,
		})
		const url = new URL("https://slack.com/openid/connect/authorize")
		url.searchParams.set("response_type", "code")
		url.searchParams.set("scope", "openid email profile")
		url.searchParams.set("client_id", credentials.clientId)
		url.searchParams.set("state", state)
		url.searchParams.set("nonce", crypto.randomUUID())
		url.searchParams.set(
			"redirect_uri",
			signInCallbackUrl(origin(c.env, c.req.url)),
		)
		return c.redirect(url.toString())
	})
	.get("/slack/callback", async (c) => {
		const code = c.req.query("code")
		const state = c.req.query("state")
		if (c.req.query("error")) return c.redirect("/")
		if (!code || !state) return refuse("Slack didn't send a sign-in code.", 400)
		if (!(await c.env.BRAIN_KV.get(`auth:slack:${state}`))) {
			return refuse("That sign-in link expired. Try again.", 400)
		}
		await c.env.BRAIN_KV.delete(`auth:slack:${state}`)

		const credentials = await slackCredentials(c.env)
		if (!credentials) return c.redirect("/setup")

		const tokenResponse = (await fetch(
			"https://slack.com/api/openid.connect.token",
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: credentials.clientId,
					client_secret: credentials.clientSecret,
					code,
					redirect_uri: signInCallbackUrl(origin(c.env, c.req.url)),
				}),
			},
		).then((res) => res.json())) as {
			ok: boolean
			error?: string
			access_token?: string
		}
		if (!tokenResponse.ok || !tokenResponse.access_token) {
			return refuse(`Slack refused the sign-in (${tokenResponse.error ?? "unknown error"}).`)
		}

		const identity = (await fetch(
			"https://slack.com/api/openid.connect.userInfo",
			{ headers: { authorization: `Bearer ${tokenResponse.access_token}` } },
		).then((res) => res.json())) as SlackIdentity
		const teamId = identity["https://slack.com/team_id"]
		const email = identity.email?.trim().toLowerCase()
		if (!identity.ok || !teamId || !email) {
			return refuse("Slack didn't share your email address.")
		}
		const teamName = identity["https://slack.com/team_name"] ?? "Company"

		let claimed = await deploymentOrg(c.env)
		let firstSignIn = false
		if (!claimed) {
			const [created] = await db(c.env)
				.insert(organization)
				.values({
					name: teamName,
					slug: slugify(teamName),
					metadata: { slackTeamId: teamId, slackTeamName: teamName },
				})
				.returning()
			if (!created) return refuse("Couldn't create the organization.", 409)
			// Two first sign-ins racing both insert; the oldest org wins.
			claimed = await deploymentOrg(c.env)
			firstSignIn = claimed?.org.id === created.id
		}
		if (!claimed) return refuse("Couldn't create the organization.", 409)
		if (claimed.teamId && claimed.teamId !== teamId) {
			return refuse(
				`This Company Brain belongs to another Slack workspace. Sign in with your account on that workspace.`,
			)
		}

		const [existing] = await db(c.env)
			.select({ id: user.id })
			.from(user)
			.where(sql`lower(${user.email}) = ${email}`)
			.limit(1)
		let userId = existing?.id
		if (userId) {
			await db(c.env)
				.update(user)
				.set({
					name: identity.name || undefined,
					image: identity.picture ?? null,
					updatedAt: new Date(),
				})
				.where(eq(user.id, userId))
		} else {
			const [created] = await db(c.env)
				.insert(user)
				.values({ email, name: identity.name ?? email, image: identity.picture })
				.returning({ id: user.id })
			userId = created?.id
		}
		if (!userId) return refuse("Couldn't create your account.", 409)

		await db(c.env)
			.insert(member)
			.values({
				organizationId: claimed.org.id,
				userId,
				role: firstSignIn ? ROLE_OWNER : ROLE_MEMBER,
			})
			.onConflictDoNothing({ target: [member.organizationId, member.userId] })

		await startSession(c, userId, claimed.org.id)
		// A fresh deployment still needs the bot installed, which /setup walks
		// through; after that, sign-in lands in the app.
		const [installed] = await db(c.env)
			.select({ teamId: slackWorkspace.teamId })
			.from(slackWorkspace)
			.where(eq(slackWorkspace.orgId, claimed.org.id))
			.limit(1)
		return c.redirect(installed ? "/" : "/setup")
	})
	.post("/logout", (c) => {
		endSession(c)
		return c.json({ ok: true })
	})
