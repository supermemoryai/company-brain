import type { ModelMessage } from "ai"
import type { MemoryWriteback } from "../memory/writeback"
import type { BrainObservabilityInput } from "../observability"
import type { InteractionContext } from "../prompt/build"
import type { ThreadAttachmentPart } from "../slack/attachments"
import type { SlackLookupContext } from "../slack/channel-lookup"
import type {
	SlackAsker,
	SlackBotIdentity,
	SlackMember,
	SlackThreadHistory,
} from "../slack/client"
import type { TurnControlSnapshot } from "../slack/turn-control"
import type { SlackOrg } from "../slack/workspace"
import type { TurnActor } from "./actor"
import type { CompanyBrainAgent } from "./agent"
import type { ApprovalResumeState, PendingApproval } from "./approval"
import type { Effort } from "./model-profile"
import type { TurnTerminalProposal } from "./terminal"

export type TurnCardSource = { url: string; text: string }

export type TurnCardExtra = {
	detail?: string
	output?: string
	sources?: TurnCardSource[]
}

export type TurnProgress = {
	card: (
		id: string,
		title: string,
		status: "in_progress" | "complete" | "error",
		extra?: TurnCardExtra,
	) => Promise<void>
	/** Returns whether the whole update reached the thread (false on a no-op,
	 * partial, or failed post). */
	narrate?: (text: string) => Promise<boolean>
}

export type TurnApprovalRequest = {
	approvalId: string
	toolCallId: string
	toolName: string
	slug?: string
	input: unknown
	summary: string
}

export type TurnToolTraceEntry = {
	tool: string
	input?: unknown
	output?: string
}

export type ComputeTurnResult =
	| {
			status: "completed"
			reply: string
			memory: MemoryWriteback
			connect: string[] | null
			toolTrace?: TurnToolTraceEntry[]
			salvaged?: boolean
			silentConclusion?: boolean
			narrated?: boolean
			nativeCallCount?: number
	  }
	| {
			status: "suspended"
			approval: TurnApprovalRequest
			state: ApprovalResumeState
	  }

export type ComputeTurnOptions = {
	abortSignal?: AbortSignal
	turnControl?: TurnControlSnapshot
	turnSteering?: string
	/** Durable runtime checkpoint for an explicitly proposed final reply. */
	onTerminalProposal?: (proposal: TurnTerminalProposal | null) => void
	/** Internal passive triage escalation. Read-only and allowed to conclude silently. */
	passiveInvestigation?: { reason: string }
}

export type TurnThreadHistory = SlackThreadHistory & {
	botUserId: string | null
	slackBotId?: string | null
	excludeTs?: string
	botUserIds?: string[]
}

export type ComputeTurnInput = {
	agent: CompanyBrainAgent
	org: SlackOrg
	userId: string
	actor: TurnActor
	question: string
	threadText: string
	/** Native chronological Slack messages. The current request is appended last. */
	conversationMessages?: ModelMessage[]
	/** Server-held current-thread history, exposed lazily only when prompt history was omitted. */
	threadHistory?: TurnThreadHistory
	threadParticipants?: string
	workspaceGroups?: string
	attachmentParts?: ThreadAttachmentPart[]
	loc?: string
	asker?: SlackAsker
	botIdentity?: SlackBotIdentity
	directory?: SlackMember[]
	progress?: TurnProgress
	interaction?: InteractionContext
	slackLookup?: SlackLookupContext
	/** Slack ids explicitly mentioned in the current message. */
	mentionedSlackUserIds?: string[]
	memoryTagSlackUserIds?: string[]
	scheduledRun?: boolean
	/** Internally-triggered turn (admin tooling): measure LLM cost, never bill the org. */
	skipBilling?: boolean
	/** Leave no trace in the workspace's turn state: an internal turn shares the
	 * thread key of the surface it borrows. */
	ephemeral?: boolean
	agentMainEffort?: Effort
	/** Pin effort regardless of org config. Internal turns only. */
	effortOverride?: Effort
	/** Cap the investigation loop below the profile default. For background
	 * batches, where a 24-step wander costs more than it finds. */
	stepLimit?: number
	obs?: BrainObservabilityInput
	env?: Env
	options?: ComputeTurnOptions
}

export type ResumeTurnAfterApprovalInput = {
	agent: CompanyBrainAgent
	org: SlackOrg
	approval: PendingApproval
	approved: boolean
	progress?: TurnProgress
	obs?: BrainObservabilityInput
	abortSignal?: AbortSignal
	/** Runtime checkpoint for an explicitly proposed final reply. */
	onTerminalProposal?: (proposal: TurnTerminalProposal | null) => void
	/** Decrypted only for the live resume call; never persisted in approval state. */
	slackBotToken?: string
}
