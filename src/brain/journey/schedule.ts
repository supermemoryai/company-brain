import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import type { JourneyRung } from "./rungs"

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const MINUTE_MS = 60 * 1000

// Days after install each rung is first offered, from the journey plan.
const RUNG_DAY: Record<JourneyRung, number> = {
	domain: 0,
	channels: 0,
	second_asker: 2,
	tool_workspace: 4,
	digest: 7,
}

// Beats land inside the workspace's working day, never at night or a weekend.
const WORK_START_HOUR = 9
const WORK_END_HOUR = 17

// Every workspace firing at the same instant reads as a mailshot, and one bad
// beat would hit everyone at once. Spread each org across its own working day.
const JITTER_MS = 6 * HOUR_MS

// The bot's own tick, not the beat: cheap, and re-checked against live state.
const MIN_DELAY_MS = 5 * 60 * 1000

/** Most common cached member offset, so beats follow the team rather than UTC. */
export function workspaceTzOffsetSeconds(agent: CompanyBrainAgent): number {
	try {
		const rows = agent.sql<{ tz_offset: number; n: number }>`
			SELECT tz_offset, COUNT(*) AS n FROM brain_slack_user_cache
			WHERE tz_offset IS NOT NULL AND is_bot = 0
			GROUP BY tz_offset ORDER BY n DESC LIMIT 1
		`
		return Number(rows[0]?.tz_offset ?? 0)
	} catch {
		return 0
	}
}

function shiftIntoWorkingHours(atMs: number, tzOffsetSeconds: number): number {
	const offsetMs = tzOffsetSeconds * 1000
	const local = new Date(atMs + offsetMs)
	const hour = local.getUTCHours()
	let shifted = atMs
	if (hour < WORK_START_HOUR) {
		shifted = atMs + (WORK_START_HOUR - hour) * HOUR_MS
	} else if (hour >= WORK_END_HOUR) {
		shifted = atMs + (24 - hour + WORK_START_HOUR) * HOUR_MS
	}
	// Saturday and Sunday roll forward to Monday morning.
	for (let guard = 0; guard < 3; guard++) {
		const day = new Date(shifted + offsetMs).getUTCDay()
		if (day !== 0 && day !== 6) break
		shifted += DAY_MS
	}
	return shifted
}

/**
 * Harness-only pacing, passed per call rather than held in module state so two
 * orgs sharing an isolate can never leak minute-scale pacing into each other.
 * Never honored in production. Fast mode also skips jitter and working-hours
 * placement, since either would push a beat minutes out into 9am tomorrow.
 */
export function journeyFastForward(
	agent: CompanyBrainAgent,
	fast?: boolean,
): boolean {
	return brainAgent(agent).env.NODE_ENV !== "production" && fast === true
}

/** Day-scale gaps become minute-scale under fast forward, or nothing ever runs. */
export function scaleDuration(
	agent: CompanyBrainAgent,
	ms: number,
	fast?: boolean,
): number {
	return journeyFastForward(agent, fast) ? (ms * MINUTE_MS) / DAY_MS : ms
}

/**
 * When the next tick for `rung` should fire. Jitter is per-call, so two orgs
 * installing in the same minute drift apart instead of marching in step.
 */
export function nextBeatAt(
	agent: CompanyBrainAgent,
	args: {
		rung: JourneyRung
		installedAt: number
		now?: number
		fast?: boolean
	},
): number {
	const now = args.now ?? Date.now()
	if (journeyFastForward(agent, args.fast)) {
		return args.installedAt + RUNG_DAY[args.rung] * MINUTE_MS
	}
	const target = args.installedAt + RUNG_DAY[args.rung] * DAY_MS
	const jittered = Math.max(now, target) + Math.random() * JITTER_MS
	const placed = shiftIntoWorkingHours(
		jittered,
		workspaceTzOffsetSeconds(agent),
	)
	return Math.max(placed, now + MIN_DELAY_MS)
}

export function delaySecondsUntil(at: number, now?: number): number {
	return Math.max(60, Math.round((at - (now ?? Date.now())) / 1000))
}
