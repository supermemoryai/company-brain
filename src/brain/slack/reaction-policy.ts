const HOUR_MS = 60 * 60 * 1_000

export const ACK_BREAKER_MAX_PER_HOUR = 30
export const ACK_BREAKER_OPEN_MS = 60 * 60 * 1_000

export type AckBreakerState = {
	bucket: number
	count: number
	openUntil: number
}

export type AckBreakerDecision = {
	allowed: boolean
	opened: boolean
	next: AckBreakerState
}

export function evaluateAckBreaker(
	state: AckBreakerState | undefined,
	nowMs: number,
): AckBreakerDecision {
	const bucket = Math.floor(nowMs / HOUR_MS)
	if (state && state.openUntil > nowMs) {
		return { allowed: false, opened: false, next: state }
	}
	const count = state?.bucket === bucket ? state.count : 0
	if (count >= ACK_BREAKER_MAX_PER_HOUR) {
		return {
			allowed: false,
			opened: true,
			next: {
				bucket,
				count,
				openUntil: nowMs + ACK_BREAKER_OPEN_MS,
			},
		}
	}
	return {
		allowed: true,
		opened: false,
		next: { bucket, count: count + 1, openUntil: 0 },
	}
}
