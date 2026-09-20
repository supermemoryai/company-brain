import type { CompanyBrainAgent } from "../turn/agent"
import { type BeatRow, clearJourney, journeyStatus, listBeats } from "./log"
import { JOURNEY_RUNGS, nextRung, type RungState, readRungState } from "./rungs"

export type JourneySnapshot = {
	rungs: RungState
	order: string[]
	next: string | null
	status: ReturnType<typeof journeyStatus>
	beats: BeatRow[]
}

/** Everything the engine would look at, so a tick can be judged from outside. */
export async function journeySnapshot(
	agent: CompanyBrainAgent,
): Promise<JourneySnapshot> {
	const rungs = await readRungState(agent)
	return {
		rungs,
		order: JOURNEY_RUNGS,
		next: nextRung(rungs),
		status: journeyStatus(agent),
		beats: listBeats(agent),
	}
}

export async function resetJourney(agent: CompanyBrainAgent): Promise<void> {
	// A pending tick would refire after the wipe and rebuild state.
	await Promise.all(
		agent
			.getSchedules()
			.filter((schedule) => schedule.callback === "runJourneyTick")
			.map((schedule) => agent.cancelSchedule(schedule.id).catch(() => {})),
	)
	clearJourney(agent)
}
