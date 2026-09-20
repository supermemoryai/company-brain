import { sql } from "@repo/db"

export function slackIdentityAdvisoryLockQuery(
	teamId: string,
	slackUserId: string,
) {
	const key = `company-brain:slack-identity:${teamId}:${slackUserId}`
	return sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}

export function slackWorkspaceAdvisoryLockQuery(teamId: string) {
	const key = `company-brain:slack-workspace:${teamId}`
	return sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}
