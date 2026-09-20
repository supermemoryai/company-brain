import type { ModelMessage } from "ai"
import type { TurnControlSnapshot } from "../../slack/turn-control"
import type { CompanyBrainAgent } from "../agent"
import { claimFinalReply } from "./claim"
import { rebaseFinalReply } from "./rebase"

export { selectTurnReply, type TurnReplySource } from "./output"

type TurnReplyCandidate = {
	reply: string
}

type TurnReplyModelResult = {
	readonly response: PromiseLike<{ messages: ModelMessage[] }>
}

export type TurnFinalizationAdapter<
	Result extends TurnReplyModelResult,
	Candidate extends TurnReplyCandidate,
> = {
	reply: {
		read: (result: Result) => Promise<Candidate>
	}
	liveUpdates: {
		current: () => ModelMessage[]
		consume: () => ModelMessage[]
	}
	observe?: {
		finalClaim?: () => void
	}
}

export type TurnSettlement<Candidate extends TurnReplyCandidate> =
	| { status: "publish"; candidate: Candidate }
	| { status: "continue"; messages: ModelMessage[] }

/**
 * Settles one completed model run into either a publishable reply or the
 * messages for a single live-update continuation. Reply selection, revision
 * claiming, and continuation ordering remain private to this module.
 */
export async function settleTurn<
	Result extends TurnReplyModelResult,
	Candidate extends TurnReplyCandidate,
>(args: {
	run: {
		result: Result
		messages: ModelMessage[]
	}
	adapter: TurnFinalizationAdapter<Result, Candidate>
	activeDiscoveryApps: string[]
	coordination?: {
		agent: CompanyBrainAgent
		control: TurnControlSnapshot
		traceId: string
		origin: "initial" | "approval_resume"
	}
	abortSignal?: AbortSignal
}): Promise<TurnSettlement<Candidate>> {
	const candidate = await args.adapter.reply.read(args.run.result)

	if (!args.coordination) {
		return { status: "publish", candidate }
	}

	args.adapter.observe?.finalClaim?.()
	const claim = await claimFinalReply({
		agent: args.coordination.agent,
		control: args.coordination.control,
		consumeUpdates: args.adapter.liveUpdates.consume,
		abortSignal: args.abortSignal,
		ignoredUpdateLog: `[company-brain][${args.coordination.traceId}] ${args.coordination.origin === "approval_resume" ? "approval " : ""}finalization retry after ignored live update`,
	})
	if (claim.status === "claimed") {
		return { status: "publish", candidate }
	}

	const { messages } = await args.run.result.response
	return {
		status: "continue",
		messages: rebaseFinalReply({
			messages: [
				...args.run.messages,
				...args.adapter.liveUpdates.current(),
				...messages,
				...claim.updates,
			],
			draft: candidate.reply,
			activeDiscoveryApps: args.activeDiscoveryApps,
		}),
	}
}
