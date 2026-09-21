import { and, db, eq, sql, withTransaction } from "@repo/db"
import { member, user } from "@repo/db/schema/auth"
import { slackWorkspaceMember } from "@repo/db/schema/slack"
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_OWNER } from "@repo/lib/permissions"
import { identifyMemberProfile } from "@/lib/posthog"
import { provisionedMembershipToRevoke } from "./membership-provenance"

export type ProvisionedSlackMember = {
	userId: string
	createdUser: boolean
	createdMembership: boolean
}

function normalizedEmail(value: string): string {
	return value.trim().toLowerCase()
}

function normalizedName(value: string | undefined, email: string): string {
	return value?.replace(/\s+/g, " ").trim() || email
}

async function findUserByEmail(
	env: Env,
	email: string,
): Promise<{ id: string } | undefined> {
	const [row] = await db(env)
		.select({ id: user.id })
		.from(user)
		.where(sql`lower(${user.email}) = ${email}`)
		.limit(1)
	return row
}

export async function provisionSlackWorkspaceMember(
	env: Env,
	args: {
		teamId: string
		slackUserId: string
		orgId: string
		email: string
		name?: string
	},
): Promise<ProvisionedSlackMember> {
	const email = normalizedEmail(args.email)
	if (!email || !email.includes("@")) {
		throw new Error("Slack member has no usable email")
	}

	const [mapped] = await db(env)
		.select({
			userId: slackWorkspaceMember.userId,
			linkSource: slackWorkspaceMember.linkSource,
			provisionedMemberId: slackWorkspaceMember.provisionedMemberId,
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

	let userId = mapped?.userId
	let createdUser = false
	if (!userId) {
		const existing = await findUserByEmail(env, email)
		userId = existing?.id
		if (!userId) {
			try {
				// People arrive through Slack, so this is where a person first
				// becomes a user; there is no signup flow to go through.
				const [created] = await db(env)
					.insert(user)
					.values({ email, name: normalizedName(args.name, email) })
					.returning({ id: user.id })
				userId = created?.id
				createdUser = Boolean(created?.id)
			} catch (error) {
				// A concurrent Slack page/join event may have created the same email.
				const raced = await findUserByEmail(env, email)
				if (!raced) throw error
				userId = raced.id
			}
		}
	}

	const persisted = await withTransaction(db(env), async (tx) => {
		// Account linking takes the same lock, so the identity and its
		// membership provenance move as one serialized unit.
		const [currentMapping] = await tx
			.select({
				orgId: slackWorkspaceMember.orgId,
				userId: slackWorkspaceMember.userId,
				linkSource: slackWorkspaceMember.linkSource,
				provisionedMemberId: slackWorkspaceMember.provisionedMemberId,
			})
			.from(slackWorkspaceMember)
			.where(
				and(
					eq(slackWorkspaceMember.teamId, args.teamId),
					eq(slackWorkspaceMember.slackUserId, args.slackUserId),
				),
			)
			.limit(1)
		if (currentMapping && currentMapping.orgId !== args.orgId) {
			throw new Error(
				"Slack workspace identity belongs to another organization",
			)
		}
		const persistedUserId = currentMapping?.userId ?? userId
		if (!persistedUserId) {
			throw new Error("Slack member could not be resolved to a user")
		}
		const insertedMembers = await tx
			.insert(member)
			.values({
				organizationId: args.orgId,
				userId: persistedUserId,
				role: ROLE_MEMBER,
				createdAt: new Date(),
			})
			.onConflictDoNothing({
				target: [member.organizationId, member.userId],
			})
			.returning({ id: member.id })

		await tx
			.insert(slackWorkspaceMember)
			.values({
				teamId: args.teamId,
				slackUserId: args.slackUserId,
				orgId: args.orgId,
				userId: persistedUserId,
				email,
				status: "active",
				linkSource:
					currentMapping?.linkSource === "web_confirmed"
						? "web_confirmed"
						: "email_match",
				provisionedMemberId:
					currentMapping?.provisionedMemberId ?? insertedMembers[0]?.id ?? null,
			})
			.onConflictDoUpdate({
				target: [slackWorkspaceMember.teamId, slackWorkspaceMember.slackUserId],
				set: {
					orgId: args.orgId,
					userId: persistedUserId,
					email,
					status: "active",
					// Both identity confirmation and provisioning provenance are
					// monotonic across retries and concurrent account-linking.
					linkSource: sql`
						CASE
							WHEN ${slackWorkspaceMember.linkSource} = 'web_confirmed'
								THEN 'web_confirmed'
							ELSE excluded.link_source
						END
					`,
					provisionedMemberId: sql`
						COALESCE(
							${slackWorkspaceMember.provisionedMemberId},
							excluded.provisioned_member_id
						)
					`,
					updatedAt: new Date(),
				},
			})

		return {
			userId: persistedUserId,
			createdMembership: insertedMembers.length > 0,
		}
	})

	// Slack-provisioned people otherwise show up in reports as a bare id.
	identifyMemberProfile({
		userId: persisted.userId,
		name: args.name,
		email,
		orgId: args.orgId,
	})

	return {
		userId: persisted.userId,
		createdUser,
		createdMembership: persisted.createdMembership,
	}
}

export async function revokeSlackWorkspaceMember(
	env: Env,
	args: { teamId: string; slackUserId: string; orgId: string },
): Promise<boolean> {
	return withTransaction(db(env), async (tx) => {
		// Include revoked rows so a retry can finish cleanup from data written by
		// an older, non-transactional deployment.
		const [mapped] = await tx
			.select({
				userId: slackWorkspaceMember.userId,
				provisionedMemberId: slackWorkspaceMember.provisionedMemberId,
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
		if (!mapped) return false

		await tx
			.update(slackWorkspaceMember)
			.set({ status: "revoked", updatedAt: new Date() })
			.where(
				and(
					eq(slackWorkspaceMember.teamId, args.teamId),
					eq(slackWorkspaceMember.slackUserId, args.slackUserId),
					eq(slackWorkspaceMember.orgId, args.orgId),
				),
			)

		const mappings = await tx
			.select({
				status: slackWorkspaceMember.status,
				provisionedMemberId: slackWorkspaceMember.provisionedMemberId,
			})
			.from(slackWorkspaceMember)
			.where(
				and(
					eq(slackWorkspaceMember.orgId, args.orgId),
					eq(slackWorkspaceMember.userId, mapped.userId),
				),
			)
		const provisionedMemberId = provisionedMembershipToRevoke(mappings)
		if (!provisionedMemberId) return true

		const [membership] = await tx
			.select({ role: member.role })
			.from(member)
			.where(
				and(
					eq(member.id, provisionedMemberId),
					eq(member.organizationId, args.orgId),
					eq(member.userId, mapped.userId),
				),
			)
			.limit(1)
		if (membership?.role === ROLE_OWNER || membership?.role === ROLE_ADMIN) {
			return true
		}

		await tx
			.delete(member)
			.where(
				and(
					eq(member.id, provisionedMemberId),
					eq(member.organizationId, args.orgId),
					eq(member.userId, mapped.userId),
				),
			)
		return true
	})
}
