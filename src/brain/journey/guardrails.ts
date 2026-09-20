import { db, eq } from "@repo/db"
import { organizationSettings } from "@repo/db/schema/auth"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { getHomeChannel } from "../turn/home-channel"
import { JOURNEY_BEATS } from "./beats"
import {
	creditGrant,
	hasCreditedBeat,
	hasRefusalMark,
	ignoredStreak,
	type JourneyExitReason,
	journeyStatus,
	lastSentAt,
	pauseJourney,
	type SuppressionReason,
} from "./log"
import {
	JOURNEY_RUNGS,
	type JourneyRung,
	journeyExitReason,
	nextRung,
	type RungState,
	readRungStateChecked,
} from "./rungs"
import { scaleDuration } from "./schedule"

// Beats stay off until a deploy turns them on; a single org can still opt in or
// out ahead of that through brainProactivity.journey.
const JOURNEY_DEFAULT_ENABLED = false

export const MIN_BEAT_GAP_MS = 24 * 60 * 60 * 1000
const MAX_IGNORED_BEATS = 2

export type JourneyDecision =
	| { action: "send"; rung: JourneyRung; state: RungState }
	| { action: "suppress"; reason: SuppressionReason; rung?: JourneyRung }
	| { action: "exit"; reason: JourneyExitReason }

const REFUSAL_PAUSE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Settle the log against live state: a rung granted since we asked credits the
 * beat that preceded it, and one taken back is a refusal. Returns the rungs that
 * were taken back, which are never asked for again.
 */
function reconcileGrants(
	agent: CompanyBrainAgent,
	state: RungState,
	now: number,
	reliable: boolean,
): { revoked: Set<JourneyRung>; newRefusal: boolean } {
	const revoked = new Set<JourneyRung>()
	let newRefusal = false
	for (const rung of JOURNEY_RUNGS) {
		if (state[rung]) {
			creditGrant(agent, rung, now)
			continue
		}
		// A false from a failed read is an outage, not a user taking access away.
		if (!reliable) continue
		if (!hasCreditedBeat(agent, rung)) continue
		revoked.add(rung)
		// Pause once per refusal, not on every reconcile for the rest of time.
		if (!hasRefusalMark(agent, rung)) {
			pauseJourney(agent, now + REFUSAL_PAUSE_MS, now, rung)
			newRefusal = true
		}
	}
	return { revoked, newRefusal }
}

export type JourneySwitch = "enabled" | "disabled" | "unknown"

// Unknown is neither: it must not be read as consent to send, nor as a
// permanent opt-out that drops the schedule chain.
export async function journeyEnabled(
	env: Env,
	orgId: string,
): Promise<JourneySwitch> {
	try {
		const [row] = await db(env)
			.select({ proactivity: organizationSettings.brainProactivity })
			.from(organizationSettings)
			.where(eq(organizationSettings.orgId, orgId))
			.limit(1)
		const enabled =
			row?.proactivity?.journey?.enabled ?? JOURNEY_DEFAULT_ENABLED
		return enabled ? "enabled" : "disabled"
	} catch {
		return "unknown"
	}
}

/**
 * Decide what to do right now. State is read live here rather than at schedule
 * time, so a grant made between the alarm being set and it firing still counts.
 */
export async function decideNextBeat(
	agent: CompanyBrainAgent,
	now = Date.now(),
	// Operator/dev trigger: skips the enable switch only. Pacing, pause and exit
	// still apply, so an override cannot turn into a burst.
	force = false,
	fast = false,
): Promise<JourneyDecision> {
	const status = journeyStatus(agent)
	if (status.exitedAt !== null)
		return { action: "suppress", reason: "disabled" }
	if (status.pausedUntil !== null && status.pausedUntil > now) {
		return { action: "suppress", reason: "paused" }
	}

	const env = brainAgent(agent).env
	if (!force) {
		const shipSwitch = await journeyEnabled(env, agent.name)
		if (shipSwitch === "unknown") {
			return { action: "suppress", reason: "settings_unavailable" }
		}
		if (shipSwitch === "disabled") {
			return { action: "suppress", reason: "disabled" }
		}
	}

	const { state, reliable } = await readRungStateChecked(agent)
	// Credit before judging silence, or acting on a nudge still reads as ignored.
	const { revoked, newRefusal } = reconcileGrants(agent, state, now, reliable)
	if (newRefusal) return { action: "suppress", reason: "paused" }

	// Silence is an answer, and two unanswered beats is enough of it.
	if (ignoredStreak(agent) >= MAX_IGNORED_BEATS) {
		return { action: "exit", reason: "ignored" }
	}

	// An unaskable rung would otherwise be selected forever.
	const unaskable = new Set(
		JOURNEY_RUNGS.filter((candidate) => !JOURNEY_BEATS[candidate]),
	)
	const rung = nextRung(state, new Set([...revoked, ...unaskable]))
	if (!rung) return { action: "exit", reason: journeyExitReason(state) }

	// Nothing to post into yet; the install path arms this again once it exists.
	if (!getHomeChannel(agent)) {
		return { action: "suppress", reason: "no_surface", rung }
	}

	const last = lastSentAt(agent)
	if (
		last !== null &&
		now - last < scaleDuration(agent, MIN_BEAT_GAP_MS, fast)
	) {
		return { action: "suppress", reason: "rate_limited", rung }
	}

	return { action: "send", rung, state }
}
