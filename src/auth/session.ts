import type { MiddlewareHandler } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { and, db, eq } from "@repo/db"
import { member, organization, user } from "@repo/db/schema/auth"
import type { MemberRole } from "@repo/lib/permissions"
import type { AppContext } from "@/types"

const COOKIE = "brain_session"
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30

type SessionClaims = { uid: string; oid: string; exp: number }

const encoder = new TextEncoder()

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "")
}

function fromBase64url(value: string): Uint8Array {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/")
	return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}

async function signingKey(env: Env): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(`session:${env.ENCRYPTION_SECRET}`),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	)
}

async function seal(env: Env, claims: SessionClaims): Promise<string> {
	const body = base64url(encoder.encode(JSON.stringify(claims)))
	const signature = await crypto.subtle.sign(
		"HMAC",
		await signingKey(env),
		encoder.encode(body),
	)
	return `${body}.${base64url(new Uint8Array(signature))}`
}

async function unseal(env: Env, token: string): Promise<SessionClaims | null> {
	const [body, signature] = token.split(".")
	if (!body || !signature) return null
	const valid = await crypto.subtle
		.verify(
			"HMAC",
			await signingKey(env),
			fromBase64url(signature),
			encoder.encode(body),
		)
		.catch(() => false)
	if (!valid) return null
	try {
		const claims = JSON.parse(
			new TextDecoder().decode(fromBase64url(body)),
		) as SessionClaims
		return claims.exp > Date.now() / 1000 ? claims : null
	} catch {
		return null
	}
}

export async function startSession(
	c: Parameters<MiddlewareHandler<AppContext>>[0],
	userId: string,
	orgId: string,
): Promise<void> {
	const token = await seal(c.env, {
		uid: userId,
		oid: orgId,
		exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS,
	})
	setCookie(c, COOKIE, token, {
		path: "/",
		httpOnly: true,
		secure: new URL(c.req.url).protocol === "https:",
		sameSite: "Lax",
		maxAge: MAX_AGE_SECONDS,
	})
}

export function endSession(
	c: Parameters<MiddlewareHandler<AppContext>>[0],
): void {
	deleteCookie(c, COOKIE, { path: "/" })
}

/**
 * Put the signed-in person, their organization and their role on the context.
 * The session only names ids; membership is re-read each request, so removing
 * someone from the org takes effect without waiting for the cookie to expire.
 */
export const sessionMiddleware: MiddlewareHandler<AppContext> = async (
	c,
	next,
) => {
	c.set("user", null)
	c.set("org", null)
	c.set("memberRole", null)

	const token = getCookie(c, COOKIE)
	const claims = token ? await unseal(c.env, token) : null
	if (claims) {
		const [row] = await db(c.env)
			.select({ user, organization, role: member.role })
			.from(member)
			.innerJoin(user, eq(user.id, member.userId))
			.innerJoin(organization, eq(organization.id, member.organizationId))
			.where(
				and(eq(member.userId, claims.uid), eq(member.organizationId, claims.oid)),
			)
			.limit(1)
			.catch(() => [])
		if (row && !row.user.deleted) {
			c.set("user", row.user)
			c.set("org", {
				...row.organization,
				metadata: row.organization.metadata ?? null,
			})
			c.set("memberRole", row.role as MemberRole)
		}
	}
	await next()
}
