import { and, db, desc, eq, sql } from "@repo/db"
import { member, user } from "@repo/db/schema/auth"
import { mcpConnection } from "@repo/db/schema/brain/mcp"
import { lookupSlackUserByEmail } from "../slack/client"
import { isMcpServerLeaseable } from "../tools/mcp/catalog"
import type { LeaseOwnerCandidate } from "./types"

function leaseOwnerCandidatesFromRows(
	rows: Array<{
		userId: string
		connectionId: string
		email: string | null
	}>,
	excludeUserId: string | undefined,
): LeaseOwnerCandidate[] {
	const seen = new Set<string>()
	return rows.flatMap((row) => {
		if (row.userId === excludeUserId || seen.has(row.userId)) return []
		seen.add(row.userId)
		return [
			{
				userId: row.userId,
				connectionId: row.connectionId,
				email: row.email ?? undefined,
			},
		]
	})
}

export async function resolveLeaseOwners(
	env: Env,
	orgId: string,
	serverSlug: string,
	excludeUserId: string | undefined,
): Promise<LeaseOwnerCandidate[]> {
	if (!isMcpServerLeaseable(serverSlug)) return []
	const rows = await db(env)
		.select({
			userId: member.userId,
			connectionId: mcpConnection.id,
			email: user.email,
		})
		.from(mcpConnection)
		.innerJoin(
			member,
			and(
				eq(member.userId, mcpConnection.userId),
				eq(member.organizationId, orgId),
			),
		)
		.innerJoin(user, eq(user.id, member.userId))
		.where(
			and(
				eq(mcpConnection.orgId, orgId),
				eq(mcpConnection.serverSlug, serverSlug),
				eq(mcpConnection.status, "active"),
				sql`${mcpConnection.userId} is not null`,
			),
		)
		.orderBy(desc(mcpConnection.updatedAt))

	return leaseOwnerCandidatesFromRows(rows, excludeUserId)
}

export async function isEligibleLeaseOwner(
	env: Env,
	orgId: string,
	serverSlug: string,
	userId: string,
	connectionId: string,
): Promise<boolean> {
	if (!isMcpServerLeaseable(serverSlug)) return false
	const rows = await db(env)
		.select({ userId: member.userId })
		.from(mcpConnection)
		.innerJoin(
			member,
			and(
				eq(member.userId, mcpConnection.userId),
				eq(member.organizationId, orgId),
			),
		)
		.where(
			and(
				eq(mcpConnection.id, connectionId),
				eq(mcpConnection.orgId, orgId),
				eq(mcpConnection.serverSlug, serverSlug),
				eq(mcpConnection.status, "active"),
				eq(mcpConnection.userId, userId),
			),
		)
		.limit(1)
	return rows.length > 0
}

export async function isOrgMember(
	env: Env,
	orgId: string,
	userId: string,
): Promise<boolean> {
	const rows = await db(env)
		.select({ userId: member.userId })
		.from(member)
		.where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
		.limit(1)
	return rows.length > 0
}

export async function resolveReachableLeaseOwners(
	botToken: string,
	candidates: LeaseOwnerCandidate[],
): Promise<LeaseOwnerCandidate[]> {
	const resolved = await Promise.all(
		candidates.map(async (candidate) => {
			if (!candidate.email) return undefined
			try {
				const slackUserId = await lookupSlackUserByEmail(
					botToken,
					candidate.email,
				)
				return slackUserId ? { ...candidate, slackUserId } : undefined
			} catch {
				return undefined
			}
		}),
	)
	return resolved.flatMap((candidate) => (candidate ? [candidate] : []))
}
