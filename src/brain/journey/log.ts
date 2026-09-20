import type { CompanyBrainAgent } from "../turn/agent"
import type { JourneyRung } from "./rungs"

// One row per thing that happened to the journey. Lifecycle entries are rows too,
// so pausing twice before exiting stays visible instead of overwriting a field.
export type BeatOutcome = "sent" | "suppressed" | "paused" | "exited"

// Why a beat did not go out. Kept as data so the funnel can separate "we chose
// silence" from "we never reached them".
export type SuppressionReason =
	| "already_granted"
	| "rate_limited"
	| "live_conversation"
	| "paused"
	| "ignored_twice"
	| "disabled"
	| "no_surface"
	| "no_beat"
	| "settings_unavailable"

export type JourneyExitReason =
	| "completed"
	| "ignored"
	| "refused"
	| "uninstalled"

export type BeatRow = {
	id: number
	rung: string | null
	outcome: string
	reason: string | null
	at: number
	granted_at: number | null
	until: number | null
}

export function ensureJourneyTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_journey_beat (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			rung TEXT,
			outcome TEXT NOT NULL,
			reason TEXT,
			at INTEGER NOT NULL,
			granted_at INTEGER,
			until INTEGER
		)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS idx_brain_journey_beat_at
		ON brain_journey_beat (outcome, at DESC)
	`
}

export function recordBeat(
	agent: CompanyBrainAgent,
	args: {
		rung: JourneyRung | null
		outcome: Extract<BeatOutcome, "sent" | "suppressed">
		reason?: SuppressionReason
		at?: number
	},
): void {
	ensureJourneyTable(agent)
	agent.sql`
		INSERT INTO brain_journey_beat (rung, outcome, reason, at)
		VALUES (${args.rung}, ${args.outcome}, ${args.reason ?? null}, ${args.at ?? Date.now()})
	`
}

export function lastSentAt(agent: CompanyBrainAgent): number | null {
	ensureJourneyTable(agent)
	const rows = agent.sql<{ at: number }>`
		SELECT at FROM brain_journey_beat
		WHERE outcome = 'sent' ORDER BY at DESC LIMIT 1
	`
	return rows[0]?.at ?? null
}

// Silence is an answer: sent beats with no grant since. Two ends the journey.
export function ignoredStreak(agent: CompanyBrainAgent): number {
	ensureJourneyTable(agent)
	const rows = agent.sql<{ granted_at: number | null }>`
		SELECT granted_at FROM brain_journey_beat
		WHERE outcome = 'sent' ORDER BY at DESC
	`
	let streak = 0
	for (const row of rows) {
		if (row.granted_at !== null) break
		streak += 1
	}
	return streak
}

// A grant credits the most recent unanswered beat for that rung, so a nudge can
// be judged as working without guessing at attribution later.
export function creditGrant(
	agent: CompanyBrainAgent,
	rung: JourneyRung,
	at?: number,
): BeatRow | null {
	ensureJourneyTable(agent)
	const rows = agent.sql<BeatRow>`
		SELECT id, rung, outcome, reason, at, granted_at, until
		FROM brain_journey_beat
		WHERE rung = ${rung} AND outcome = 'sent' AND granted_at IS NULL
		ORDER BY at DESC LIMIT 1
	`
	const beat = rows[0]
	if (!beat) return null
	const grantedAt = at ?? Date.now()
	agent.sql`
		UPDATE brain_journey_beat SET granted_at = ${grantedAt} WHERE id = ${beat.id}
	`
	return { ...beat, granted_at: grantedAt }
}

// Removal or a disconnect is a refusal: back off, but don't end the journey.
export function pauseJourney(
	agent: CompanyBrainAgent,
	until: number,
	at?: number,
	rung?: JourneyRung,
): void {
	ensureJourneyTable(agent)
	agent.sql`
		INSERT INTO brain_journey_beat (rung, outcome, at, until)
		VALUES (${rung ?? null}, 'paused', ${at ?? Date.now()}, ${until})
	`
}

/** True once a refusal pause was recorded for this rung. */
export function hasRefusalMark(
	agent: CompanyBrainAgent,
	rung: JourneyRung,
): boolean {
	ensureJourneyTable(agent)
	const rows = agent.sql<{ n: number }>`
		SELECT COUNT(*) AS n FROM brain_journey_beat
		WHERE outcome = 'paused' AND rung = ${rung}
	`
	return Number(rows[0]?.n ?? 0) > 0
}

export function exitJourney(
	agent: CompanyBrainAgent,
	reason: JourneyExitReason,
	at?: number,
): void {
	ensureJourneyTable(agent)
	agent.sql`
		INSERT INTO brain_journey_beat (outcome, reason, at)
		VALUES ('exited', ${reason}, ${at ?? Date.now()})
	`
}

/** True once a beat for this rung was sent and the grant landed after it. */
export function hasCreditedBeat(
	agent: CompanyBrainAgent,
	rung: JourneyRung,
): boolean {
	ensureJourneyTable(agent)
	const rows = agent.sql<{ n: number }>`
		SELECT COUNT(*) AS n FROM brain_journey_beat
		WHERE rung = ${rung} AND outcome = 'sent' AND granted_at IS NOT NULL
	`
	return Number(rows[0]?.n ?? 0) > 0
}

export function listBeats(agent: CompanyBrainAgent, limit = 50): BeatRow[] {
	ensureJourneyTable(agent)
	return agent.sql<BeatRow>`
		SELECT id, rung, outcome, reason, at, granted_at, until
		FROM brain_journey_beat ORDER BY at DESC LIMIT ${limit}
	`
}

/** Dev only: wipe the log so a journey can be replayed from the start. */
export function clearJourney(agent: CompanyBrainAgent): void {
	ensureJourneyTable(agent)
	agent.sql`DELETE FROM brain_journey_beat`
}

export type JourneyStatus = {
	exitedAt: number | null
	exitReason: string | null
	pausedUntil: number | null
	beatsSent: number
}

export function journeyStatus(agent: CompanyBrainAgent): JourneyStatus {
	ensureJourneyTable(agent)
	const [exited] = agent.sql<{ at: number; reason: string | null }>`
		SELECT at, reason FROM brain_journey_beat
		WHERE outcome = 'exited' ORDER BY at DESC LIMIT 1
	`
	const [paused] = agent.sql<{ until: number | null }>`
		SELECT until FROM brain_journey_beat
		WHERE outcome = 'paused' ORDER BY at DESC LIMIT 1
	`
	const [sent] = agent.sql<{ n: number }>`
		SELECT COUNT(*) AS n FROM brain_journey_beat WHERE outcome = 'sent'
	`
	return {
		exitedAt: exited?.at ?? null,
		exitReason: exited?.reason ?? null,
		pausedUntil: paused?.until ?? null,
		beatsSent: Number(sent?.n ?? 0),
	}
}
