import {
	claimThreadTurnFinalizationIfInboxEmpty,
	type TurnControlSnapshot,
} from "../../slack/turn-control"
import { waitForTurnUpdateClassification } from "../../slack/turn-inbox"
import type { CompanyBrainAgent } from "../agent"
import { TurnCoordinationError, throwIfAborted } from "../util"

const DEFAULT_MAX_EMPTY_INBOX_RETRIES = 3

type TurnFinalizationResolution<T> =
	| { status: "claimed" }
	| { status: "updates"; updates: T[] }

export async function claimFinalReply<T>(args: {
	agent: CompanyBrainAgent
	control: TurnControlSnapshot
	consumeUpdates: () => T[]
	abortSignal?: AbortSignal
	ignoredUpdateLog?: string
	maxEmptyInboxRetries?: number
}): Promise<TurnFinalizationResolution<T>> {
	const configuredRetries =
		args.maxEmptyInboxRetries ?? DEFAULT_MAX_EMPTY_INBOX_RETRIES
	const maxEmptyInboxRetries = Number.isFinite(configuredRetries)
		? Math.max(0, Math.floor(configuredRetries))
		: DEFAULT_MAX_EMPTY_INBOX_RETRIES

	// Each attempt depends on classification and inbox consumption from the
	// prior attempt. Bounded recursion preserves that ordering without suggesting
	// that independent loop iterations could run concurrently.
	async function resolveAttempt(
		emptyInboxRetries: number,
	): Promise<TurnFinalizationResolution<T>> {
		const claim = claimThreadTurnFinalizationIfInboxEmpty(
			args.agent,
			args.control,
		)
		if (claim === "claimed") return { status: "claimed" }
		if (claim === "inactive") {
			throwIfAborted(args.abortSignal)
			throw new TurnCoordinationError("turn_finalization_inactive")
		}

		await waitForTurnUpdateClassification(
			args.agent,
			args.control,
			args.abortSignal,
		)
		throwIfAborted(args.abortSignal)
		const updates = args.consumeUpdates()
		if (updates.length) return { status: "updates", updates }

		// A classifying row may resolve to ignored between the failed claim and
		// the inbox read. Retry instead of treating the empty inbox as an error.
		const nextEmptyInboxRetry = emptyInboxRetries + 1
		if (nextEmptyInboxRetry > maxEmptyInboxRetries) {
			throw new TurnCoordinationError("turn_finalization_inbox_inconsistent")
		}
		if (args.ignoredUpdateLog) console.log(args.ignoredUpdateLog)
		return resolveAttempt(nextEmptyInboxRetry)
	}

	return resolveAttempt(0)
}
