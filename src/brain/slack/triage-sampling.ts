import type { CompanyBrainAgent } from "../turn/agent"

const DAY_MS = 24 * 60 * 60 * 1_000
const SAMPLING_COUNTER_RETENTION_DAYS = 8

export const TRIAGE_TRACE_FULL_CAPTURE_PER_ORG_DAY = 2_000
export const TRIAGE_TRACE_DOWNSHIFT_RATE = 0.2

export type TriageTraceSamplingDecision = {
	sampled: boolean
	sampleRate: 1 | typeof TRIAGE_TRACE_DOWNSHIFT_RATE
	dailyOrdinal: number
}

export function ensureTriageTraceSamplingTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_triage_trace_volume (
			org_id TEXT NOT NULL,
			day_bucket INTEGER NOT NULL,
			event_count INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (org_id, day_bucket)
		)
	`
}

/** Stable FNV-1a hash so retrying the same trace cannot change its sample. */
function stableTraceHash(traceId: string): number {
	let hash = 0x811c9dc5
	for (let index = 0; index < traceId.length; index++) {
		hash ^= traceId.charCodeAt(index)
		hash = Math.imul(hash, 0x01000193)
	}
	return hash >>> 0
}

export function evaluateTriageTraceSampling(
	dailyOrdinal: number,
	traceId: string,
): TriageTraceSamplingDecision {
	if (dailyOrdinal <= TRIAGE_TRACE_FULL_CAPTURE_PER_ORG_DAY) {
		return { sampled: true, sampleRate: 1, dailyOrdinal }
	}
	return {
		sampled: stableTraceHash(traceId) % 5 === 0,
		sampleRate: TRIAGE_TRACE_DOWNSHIFT_RATE,
		dailyOrdinal,
	}
}

/**
 * Count an actual triage model call in the org-scoped DO and decide whether its
 * content-bearing PostHog generation should be retained.
 */
export function reserveTriageTraceSample(
	agent: CompanyBrainAgent,
	args: { orgId: string; traceId: string; nowMs?: number },
): TriageTraceSamplingDecision {
	ensureTriageTraceSamplingTable(agent)
	const nowMs = args.nowMs ?? Date.now()
	const dayBucket = Math.floor(nowMs / DAY_MS)
	const dailyOrdinal =
		agent.sql<{ event_count: number }>`
		INSERT INTO brain_triage_trace_volume (org_id, day_bucket, event_count)
		VALUES (${args.orgId}, ${dayBucket}, 1)
		ON CONFLICT(org_id, day_bucket) DO UPDATE SET
			event_count = brain_triage_trace_volume.event_count + 1
		RETURNING event_count
	`[0]?.event_count ?? 1
	if (dailyOrdinal === 1) {
		agent.sql`
			DELETE FROM brain_triage_trace_volume
			WHERE day_bucket < ${dayBucket - SAMPLING_COUNTER_RETENTION_DAYS}
		`
	}
	return evaluateTriageTraceSampling(dailyOrdinal, args.traceId)
}
