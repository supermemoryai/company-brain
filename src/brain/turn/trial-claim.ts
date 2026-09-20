import type { CompanyBrainAgent } from "./agent"

// Per-team trial reservation. The DO instance is named `trial-claim:${teamId}`,
// so its single-threaded execution makes check-then-insert atomic — unlike the
// advisory KV ledger, which is read-then-write and fails open.

function ensureTrialClaimTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_trial_claim (
			id INTEGER PRIMARY KEY,
			owner_org_id TEXT NOT NULL,
			claimed_at INTEGER NOT NULL
		)
	`
}

export function claimTrialGrant(
	agent: CompanyBrainAgent,
	ownerOrgId: string,
): boolean {
	ensureTrialClaimTable(agent)
	const existing = agent.sql<{ owner_org_id: string }>`
		SELECT owner_org_id FROM brain_trial_claim WHERE id = 1
	`[0]
	// Same org retrying (e.g. after a failed attach) may re-claim.
	if (existing) return existing.owner_org_id === ownerOrgId
	agent.sql`
		INSERT INTO brain_trial_claim (id, owner_org_id, claimed_at)
		VALUES (1, ${ownerOrgId}, ${Date.now()})
	`
	return true
}

export function releaseTrialGrant(
	agent: CompanyBrainAgent,
	ownerOrgId: string,
): void {
	ensureTrialClaimTable(agent)
	agent.sql`
		DELETE FROM brain_trial_claim
		WHERE id = 1 AND owner_org_id = ${ownerOrgId}
	`
}
