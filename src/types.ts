import type { MemberRole } from "@repo/lib/permissions"

export type ContainerTagAccess = {
	containerTag: string
	permission: "read" | "write" | "admin"
}

export type AuthUser = {
	id: string
	email: string
	name: string
	image?: string | null
	createdAt: Date
	updatedAt: Date
}

export type AuthOrganization = {
	id: string
	name: string
	slug: string
	logo?: string | null
	metadata?: Record<string, unknown> | null
	createdAt: Date
}

/**
 * Hono context for the brain's HTTP surface. The hosted product carried a full
 * session here; a self-hosted brain authenticates Slack requests by signature
 * and its own console by setup token, so most of this stays null.
 */
export type AppContext = {
	Bindings: Env
	Variables: {
		user: AuthUser | null
		org: AuthOrganization | null
		memberRole: MemberRole | null
		trackedEvents: Set<string>
	}
}
