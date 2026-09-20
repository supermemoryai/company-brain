export const ROLE_OWNER = "owner"
export const ROLE_ADMIN = "admin"
export const ROLE_MEMBER = "member"

export type MemberRole =
	| typeof ROLE_OWNER
	| typeof ROLE_ADMIN
	| typeof ROLE_MEMBER

const RANK: Record<MemberRole, number> = { owner: 3, admin: 2, member: 1 }

export function roleAtLeast(
	role: MemberRole | null | undefined,
	minimum: MemberRole,
): boolean {
	if (!role) return false
	return (RANK[role] ?? 0) >= RANK[minimum]
}
