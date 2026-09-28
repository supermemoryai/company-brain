import type { TurnProgress } from "../turn"

/** What a turn needs from the place it answers in: progress, delivery and cleanup. */
export type TurnSurface = {
	progress: TurnProgress
	finalize: (
		reply: string,
		failed: boolean,
		paused?: boolean,
		settled?: boolean,
	) => Promise<{ streamed: boolean; messageTs?: string }>
	discard: (reply?: string) => Promise<void>
	postFallback: (reply: string) => Promise<string | undefined>
	rewriteLastNarration: (text: string) => Promise<boolean>
}
