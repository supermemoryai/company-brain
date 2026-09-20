export type DurableRetryState = {
	attempt: number
	exhausted: boolean
}

export function canScheduleDurableRecovery(
	state: DurableRetryState,
	probeAllowed: boolean,
): boolean {
	return !state.exhausted || probeAllowed
}

export function advanceDurableRetry(
	state: DurableRetryState,
	maxAttempts: number,
): { state: DurableRetryState; shouldSchedule: boolean } {
	if (state.exhausted || state.attempt >= maxAttempts) {
		return {
			state: { attempt: state.attempt, exhausted: true },
			shouldSchedule: false,
		}
	}
	return {
		state: { attempt: state.attempt + 1, exhausted: false },
		shouldSchedule: true,
	}
}
