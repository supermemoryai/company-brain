/**
 * Postgres advisory locks serialised concurrent callbacks for one identity or
 * workspace. D1 has no equivalent, so the writes they guarded are idempotent
 * upserts instead and these are no-ops kept for call-site symmetry.
 */
export function slackIdentityAdvisoryLock(): void {}

export function slackWorkspaceAdvisoryLock(): void {}
