import {
	captureBeatSent,
	captureBeatSuppressed,
	captureJourneyExited,
} from "@/lib/posthog"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { JOURNEY_BEATS, type JourneyBeat } from "./beats"
import { decideNextBeat, journeyEnabled, MIN_BEAT_GAP_MS } from "./guardrails"
import {
	exitJourney,
	journeyStatus,
	lastSentAt,
	recordBeat,
	type SuppressionReason,
} from "./log"
import {
	JOURNEY_RUNGS,
	type JourneyRung,
	journeyExitReason,
	nextRung,
	readRungState,
} from "./rungs"
import { delaySecondsUntil, nextBeatAt, scaleDuration } from "./schedule"

// How long a tick waits when something other than timing stopped it.
const RETRY_BACKOFF_MS = 24 * 60 * 60 * 1000
const SETTINGS_RETRY_MS = 15 * 60 * 1000

export type JourneyTickPayload = {
	installedAt: number
	force?: boolean
	fast?: boolean
	/** Harness only: count the beat as delivered without touching Slack. */
	stub?: boolean
	/** Harness only: record against this rung instead of the next ungranted one. */
	rung?: JourneyRung
}

const STUB_BEAT: JourneyBeat = { rung: "domain", send: async () => true }

const TICK_CALLBACK = "runJourneyTick"

// Every tick arms the next one, so without this an extra arm (a reinstall, an
// operator trigger) leaves two self-perpetuating chains running forever.
async function cancelPendingTicks(agent: CompanyBrainAgent): Promise<void> {
	await Promise.all(
		agent
			.getSchedules<JourneyTickPayload>()
			.filter((schedule) => schedule.callback === TICK_CALLBACK)
			.map((schedule) => agent.cancelSchedule(schedule.id).catch(() => {})),
	)
}

// One-off harness overrides must not replay into later automatic ticks.
function durablePayload(payload: JourneyTickPayload): JourneyTickPayload {
	return {
		installedAt: payload.installedAt,
		...(payload.fast ? { fast: true } : {}),
	}
}

export async function armJourney(
	agent: CompanyBrainAgent,
	payload: JourneyTickPayload,
): Promise<void> {
	await cancelPendingTicks(agent)
	if (
		(await journeyEnabled(brainAgent(agent).env, agent.name)) === "disabled"
	) {
		return
	}
	const at = nextBeatAt(agent, {
		rung: "domain",
		installedAt: payload.installedAt,
		fast: payload.fast,
	})
	await agent.schedule(
		delaySecondsUntil(at),
		TICK_CALLBACK,
		durablePayload(payload),
	)
}

export async function runJourneyTick(
	agent: CompanyBrainAgent,
	payload: JourneyTickPayload,
): Promise<void> {
	const orgId = agent.name
	// Alarms armed before the exit still fire; they must not log or emit.
	if (journeyStatus(agent).exitedAt !== null) return
	const decision = await decideNextBeat(
		agent,
		Date.now(),
		payload.force,
		payload.fast,
	)

	if (decision.action === "exit") {
		const status = journeyStatus(agent)
		const state = await readRungState(agent)
		exitJourney(agent, decision.reason)
		await captureJourneyExited({
			orgId,
			reason: decision.reason,
			rungsGranted: JOURNEY_RUNGS.filter((rung) => state[rung]).length,
			beatsSent: status.beatsSent,
		})
		return
	}

	if (decision.action === "suppress") {
		const rung = decision.rung ?? null
		recordBeat(agent, { rung, outcome: "suppressed", reason: decision.reason })
		await captureBeatSuppressed({
			orgId,
			rung: rung ?? "unknown",
			reason: decision.reason,
		})
		await rearm(agent, payload, decision.reason)
		return
	}

	const rung = payload.rung ?? decision.rung
	const beat = payload.stub ? STUB_BEAT : JOURNEY_BEATS[rung]
	if (!beat) {
		recordBeat(agent, { rung, outcome: "suppressed", reason: "no_beat" })
		await captureBeatSuppressed({ orgId, rung, reason: "no_beat" })
		await rearm(agent, payload, "no_beat")
		return
	}

	let sent = false
	try {
		sent = await beat.send(agent, { state: decision.state })
	} catch (err) {
		console.warn(`[company-brain] journey beat "${rung}" failed:`, err)
	}
	if (sent) {
		recordBeat(agent, { rung, outcome: "sent" })
		await captureBeatSent({ orgId, rung })
	} else {
		recordBeat(agent, { rung, outcome: "suppressed", reason: "no_surface" })
		await captureBeatSuppressed({ orgId, rung, reason: "no_surface" })
	}
	await rearm(agent, payload, sent ? undefined : "no_surface")
}

// A suppressed tick must not wake before the thing that suppressed it clears,
// otherwise the same reason fires again minutes later and burns ticks forever.
function retryFloor(
	agent: CompanyBrainAgent,
	reason: SuppressionReason | undefined,
	now: number,
	fast?: boolean,
): number {
	if (reason === "rate_limited") {
		return (
			(lastSentAt(agent) ?? now) + scaleDuration(agent, MIN_BEAT_GAP_MS, fast)
		)
	}
	if (reason === "paused") {
		return (
			journeyStatus(agent).pausedUntil ??
			now + scaleDuration(agent, RETRY_BACKOFF_MS)
		)
	}
	return reason ? now + scaleDuration(agent, RETRY_BACKOFF_MS, fast) : now
}

async function rearm(
	agent: CompanyBrainAgent,
	payload: JourneyTickPayload,
	suppressed?: SuppressionReason,
): Promise<void> {
	if (journeyStatus(agent).exitedAt !== null) return
	// Dormant rather than daily-forever; enabling the journey re-arms it.
	if (suppressed === "disabled") return
	const state = await readRungState(agent)
	const rung = nextRung(state)
	if (!rung) {
		const granted = JOURNEY_RUNGS.filter((candidate) => state[candidate])
		const status = journeyStatus(agent)
		const reason = journeyExitReason(state)
		exitJourney(agent, reason)
		await captureJourneyExited({
			orgId: agent.name,
			reason,
			rungsGranted: granted.length,
			beatsSent: status.beatsSent,
		})
		return
	}
	const now = Date.now()
	// Retries on its own clock; beat placement would defer it to Monday.
	const at =
		suppressed === "settings_unavailable"
			? now + scaleDuration(agent, SETTINGS_RETRY_MS, payload.fast)
			: Math.max(
					nextBeatAt(agent, {
						rung,
						installedAt: payload.installedAt,
						fast: payload.fast,
					}),
					retryFloor(agent, suppressed, now, payload.fast),
				)
	await cancelPendingTicks(agent)
	await agent.schedule(
		delaySecondsUntil(at, now),
		TICK_CALLBACK,
		durablePayload(payload),
	)
}
