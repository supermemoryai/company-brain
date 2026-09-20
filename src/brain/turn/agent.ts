import { hydrateSecrets } from "../../setup/secrets"
import { runInDbScope } from "@repo/db"
import {
	Agent,
	type FiberContext,
	type FiberRecoveryContext,
	type Schedule,
} from "agents"
import type { AdminChatInput, AdminChatResult } from "../admin/chat"
import type { BrainSurface } from "../admin/surfaces"
import {
	AUTO_RESEARCH_CALLBACK,
	type AutoResearchPayload,
} from "../auto-research/run"
import type { SendDraftResult } from "../auto-research/send"
import type { AutoResearchDraft, DraftStatus } from "../auto-research/store"
import type { JourneySnapshot } from "../journey/debug"
import type { JourneyTickPayload } from "../journey/engine"
import type { LeaseEscalationPayload, SlackLeaseDecision } from "../lease/types"
import type { SlackSkillDraftInteraction } from "../skills/slack-interactions"
import type { SkillCreateInput, SkillEditableInput } from "../skills/store"
import type { ChannelObservePayload } from "../slack/channel-observe"
import type { SlackTurnMessage } from "../slack/events"
import type {
	AdminRolloutCardPayload,
	PublicChannelBeachhead,
	PublicChannelRolloutCardPayload,
	PublicChannelRolloutOverview,
	PublicChannelRolloutPayload,
	PublicChannelRolloutStart,
} from "../slack/public-channel-rollout"
import type { ReactionQueuePayload } from "../slack/reaction-queue"
import type {
	SlackApprovalDecision,
	SlackConnectCompletion,
} from "../slack/turn"
import type { SlackOrg } from "../slack/workspace"
import type { AutomationInput } from "../tools/automations"
import type { ScheduledTaskPayload } from "../tools/scheduling"
import type { ApprovalExpiryPayload } from "./approval-expiry"
import type { HomeChannel } from "./home-channel"
import type { InstallNudgeArm } from "./install-nudge"
import type { PostTurnReflectPayload } from "./post-turn-reflect"
import type { ResearchOnSignupInput } from "./research"
import {
	MAX_SLACK_TURN_RECOVERY_ATTEMPTS,
	parseSlackTurnFiberSnapshot,
	recoverableSlackTurnMessage,
	SLACK_TURN_FIBER_NAME,
	type SlackTurnFiberCheckpoint,
	type SlackTurnFiberSnapshot,
	slackTurnFiberIdempotencyKey,
} from "./slack-turn-fiber"
import type {
	AutomaticTeamInviteCard,
	AutomaticTeamInviteStart,
	SlackTeamJoinPayload,
	SlackTeamJoinRetryPayload,
	SlackUserChangePayload,
	SlackUserChangeRetryPayload,
	TeamInvitePayload,
	TeamInviteStart,
} from "./team-invite"

type CompanyBrainState = {
	dreamScheduled?: boolean
}

type FiberRecoveryPromise = ReturnType<
	Agent<Env, CompanyBrainState>["onFiberRecovered"]
>

/** Expose DO internals to the lazy-loaded implementation module. */
export type CompanyBrainAgentHandle = CompanyBrainAgent & { env: Env }

export function brainAgent(agent: CompanyBrainAgent): CompanyBrainAgentHandle {
	return agent as CompanyBrainAgentHandle
}

// Thin Durable Object shell: heavy turn logic lives in agent.impl.ts and loads on
// first use so worker global startup stays under Cloudflare's validation budget.
export class CompanyBrainAgent extends Agent<Env, CompanyBrainState> {
	override initialState: CompanyBrainState = {}

	waitUntil(promise: Promise<unknown>): void {
		this.ctx.waitUntil(promise)
	}

	private implPromise?: Promise<typeof import("./agent.impl")>

	private loadImpl() {
		if (!this.implPromise) this.implPromise = import("./agent.impl")
		return this.implPromise
	}

	private async startSlackTurnFiber(
		message: SlackTurnMessage,
		recoverySnapshot?: SlackTurnFiberSnapshot,
	): Promise<void> {
		const attempt = recoverySnapshot ? recoverySnapshot.attempt + 1 : 0
		const recoverableMessage = recoverableSlackTurnMessage(message)
		const baseIdempotencyKey = slackTurnFiberIdempotencyKey(recoverableMessage)
		const idempotencyKey =
			attempt === 0
				? baseIdempotencyKey
				: `${baseIdempotencyKey}:recovery:${attempt}`

		const result = await this.startFiber(
			SLACK_TURN_FIBER_NAME,
			async (fiber) => {
				await this.runSlackTurnFiber(
					fiber,
					attempt === 0 ? message : recoverableMessage,
					attempt,
					recoverySnapshot,
				)
			},
			{
				idempotencyKey,
				metadata: {
					attempt,
					teamId: message.teamId,
				},
			},
		)
		if (!result.accepted) {
			console.log(
				`[company-brain] duplicate Slack fiber ignored key=${idempotencyKey} status=${result.status}`,
			)
		}
	}

	private async runSlackTurnFiber(
		fiber: FiberContext,
		message: SlackTurnMessage,
		attempt: number,
		recoverySnapshot?: SlackTurnFiberSnapshot,
	): Promise<void> {
		let snapshot: SlackTurnFiberSnapshot = {
			version: 1,
			message: recoverableSlackTurnMessage(message),
			attempt,
			phase: "accepted",
			...(recoverySnapshot?.threadKey
				? { threadKey: recoverySnapshot.threadKey }
				: {}),
			...(recoverySnapshot?.turnId ? { turnId: recoverySnapshot.turnId } : {}),
			...(recoverySnapshot?.turnRevision !== undefined
				? { turnRevision: recoverySnapshot.turnRevision }
				: {}),
			...(recoverySnapshot?.progressMessageTs
				? { progressMessageTs: recoverySnapshot.progressMessageTs }
				: {}),
			...(recoverySnapshot?.terminalProposal
				? { terminalProposal: recoverySnapshot.terminalProposal }
				: {}),
		}
		const checkpoint = (update: SlackTurnFiberCheckpoint): void => {
			const {
				progressMessageTs: nextProgressTs,
				terminalProposal: nextTerminalProposal,
				...rest
			} = update
			snapshot = { ...snapshot, ...rest }
			if (nextProgressTs === null) {
				delete snapshot.progressMessageTs
			} else if (nextProgressTs !== undefined) {
				snapshot.progressMessageTs = nextProgressTs
			}
			if (nextTerminalProposal === null) {
				delete snapshot.terminalProposal
			} else if (nextTerminalProposal !== undefined) {
				snapshot.terminalProposal = nextTerminalProposal
			}
			fiber.stash(snapshot)
		}
		fiber.stash(snapshot)
		checkpoint({ phase: "running" })

		const impl = await this.loadImpl()
		const control = {
			attempt,
			progressMessageTs: recoverySnapshot?.progressMessageTs,
			...(recoverySnapshot?.threadKey &&
			recoverySnapshot.turnId &&
			recoverySnapshot.turnRevision !== undefined
				? {
						recoveredTurn: {
							threadKey: recoverySnapshot.threadKey,
							turnId: recoverySnapshot.turnId,
							revision: recoverySnapshot.turnRevision,
						},
					}
				: {}),
			signal: fiber.signal,
			checkpoint,
		}
		await impl.onSlackEvent(this, message, control)
		checkpoint({ phase: "completed" })
	}

	override async onStart(): Promise<void> {
		await hydrateSecrets(this.env)
		return (await this.loadImpl()).onStart(this)
	}

	async resetMemoryRegistry(): Promise<void> {
		return (await this.loadImpl()).resetMemoryRegistry(this)
	}

	async resetSlackWorkspaceState(): Promise<void> {
		return (await this.loadImpl()).resetSlackWorkspaceState(this)
	}

	async onSlackEvent(msg: SlackTurnMessage): Promise<void> {
		return this.startSlackTurnFiber(msg)
	}

	async onSlackChimeIn(msg: SlackTurnMessage): Promise<void> {
		return (await this.loadImpl()).onSlackChimeIn(this, msg)
	}

	override async onFiberRecovered(
		context: FiberRecoveryContext,
	): FiberRecoveryPromise {
		if (context.name !== SLACK_TURN_FIBER_NAME) {
			return super.onFiberRecovered(context)
		}
		const snapshot = parseSlackTurnFiberSnapshot(context.snapshot)
		if (!snapshot) {
			return {
				status: "error",
				error: "Invalid Slack turn recovery snapshot",
			}
		}
		if (snapshot.replyMessageTs || snapshot.approvalMessageTs) {
			return { status: "completed", snapshot }
		}
		if (snapshot.terminalProposal) {
			await (await this.loadImpl()).finalizeInterruptedSlackTurn(this, snapshot)
			return { status: "completed", snapshot }
		}
		if (snapshot.attempt >= MAX_SLACK_TURN_RECOVERY_ATTEMPTS) {
			await (await this.loadImpl()).finalizeInterruptedSlackTurn(this, snapshot)
			return {
				status: "error",
				error: "Slack turn remained interrupted after one recovery attempt",
				snapshot,
			}
		}

		await this.startSlackTurnFiber(snapshot.message, snapshot)
		return { status: "completed", snapshot }
	}

	async onSlackContextEvent(msg: SlackTurnMessage): Promise<void> {
		return (await this.loadImpl()).onSlackContextEvent(this, msg)
	}

	async runPassiveReactionQueue(
		payload: ReactionQueuePayload,
		schedule: Schedule<ReactionQueuePayload>,
	): Promise<void> {
		return (await this.loadImpl()).runPassiveReactionQueue(
			this,
			payload,
			schedule,
		)
	}

	async onSlackReaction(msg: SlackTurnMessage): Promise<void> {
		return (await this.loadImpl()).onSlackReaction(this, msg)
	}

	async onSlackMembershipEvent(msg: SlackTurnMessage): Promise<void> {
		return (await this.loadImpl()).onSlackMembershipEvent(this, msg)
	}

	async reconcileChannelMembership(teamId: string): Promise<void> {
		return (await this.loadImpl()).reconcileChannelMembership(this, teamId)
	}

	async onApprovalDecision(decision: SlackApprovalDecision): Promise<void> {
		return (await this.loadImpl()).onApprovalDecision(this, decision)
	}

	async onLeaseDecision(decision: SlackLeaseDecision): Promise<void> {
		return (await this.loadImpl()).onLeaseDecision(this, decision)
	}

	async onSkillDraftInteraction(
		interaction: SlackSkillDraftInteraction,
	): Promise<void> {
		return (await this.loadImpl()).onSkillDraftInteraction(this, interaction)
	}

	async runLeaseEscalation(payload: LeaseEscalationPayload): Promise<void> {
		return (await this.loadImpl()).runLeaseEscalation(this, payload)
	}

	// Schedule callback: collapse an undecided approval card at expiry.
	async runApprovalExpiry(payload: ApprovalExpiryPayload): Promise<void> {
		return (await this.loadImpl()).runApprovalExpiry(this, payload)
	}

	async onConnectionRevoked(connectionId: string): Promise<void> {
		return (await this.loadImpl()).onConnectionRevoked(this, connectionId)
	}

	async onConnectionChanged(serverSlug: string): Promise<void> {
		return (await this.loadImpl()).onConnectionChanged(this, serverSlug)
	}

	async onSlackConnectComplete(
		completion: SlackConnectCompletion,
	): Promise<void> {
		return (await this.loadImpl()).onSlackConnectComplete(this, completion)
	}

	async debugTurn(input: { text: string; userId?: string }) {
		return (await this.loadImpl()).debugTurn(this, input)
	}

	// Kick off company research on signup (schedules runResearchTask in the DO).
	async researchCompanyOnSignup(input: ResearchOnSignupInput): Promise<void> {
		return (await this.loadImpl()).researchCompanyOnSignup(this, input)
	}

	// Schedule callback for the research task, invoked by the DO alarm.
	async runResearchTask(payload: ResearchOnSignupInput): Promise<void> {
		return (await this.loadImpl()).runResearchTask(this, payload)
	}

	// Read research status + chain-of-thought events for the onboarding UI.
	async getResearchState() {
		return (await this.loadImpl()).getResearchState(this)
	}

	async getWorkspacePrompt(): Promise<string | null> {
		return (await this.loadImpl()).getWorkspacePrompt(this)
	}

	async setWorkspacePrompt(value: string | null): Promise<string | null> {
		return (await this.loadImpl()).setWorkspacePrompt(this, value)
	}

	// Arm the deferred connect-tools nudge after the installer is greeted.
	async armInstallNudge(payload: InstallNudgeArm): Promise<void> {
		return (await this.loadImpl()).armInstallNudge(this, payload)
	}

	// Atomic per-team trial reservation (instance named trial-claim:${teamId}).
	async claimTrialGrant(ownerOrgId: string): Promise<boolean> {
		return (await this.loadImpl()).claimTrialGrant(this, ownerOrgId)
	}

	async releaseTrialGrant(ownerOrgId: string): Promise<void> {
		return (await this.loadImpl()).releaseTrialGrant(this, ownerOrgId)
	}

	// Admin-triggered member intro wave (picker or workspace-wide).
	async startTeamInviteWave(payload: TeamInviteStart): Promise<void> {
		const impl = await this.loadImpl()
		return runInDbScope(() => impl.startTeamInviteWave(this, payload))
	}

	async startAutomaticTeamInviteRollout(
		payload: AutomaticTeamInviteStart,
	): Promise<void> {
		const impl = await this.loadImpl()
		return runInDbScope(() =>
			impl.startAutomaticTeamInviteRollout(this, payload),
		)
	}

	async attachAutomaticTeamInviteCard(
		payload: AutomaticTeamInviteCard,
	): Promise<void> {
		const impl = await this.loadImpl()
		return runInDbScope(() => impl.attachAutomaticTeamInviteCard(this, payload))
	}

	async runTeamInviteDirectoryPage(
		payload: TeamInvitePayload,
		schedule: Schedule<TeamInvitePayload>,
	): Promise<void> {
		const impl = await this.loadImpl()
		return runInDbScope(async () => {
			try {
				await impl.runTeamInviteDirectoryPage(this, payload, schedule)
			} catch (error) {
				await impl.recoverTeamInviteCallbackFailure(
					this,
					payload,
					schedule,
					error,
				)
			}
		})
	}

	async runTeamInviteProvisionStep(
		payload: TeamInvitePayload,
		schedule: Schedule<TeamInvitePayload>,
	): Promise<void> {
		const impl = await this.loadImpl()
		return runInDbScope(async () => {
			try {
				await impl.runTeamInviteProvisionStep(this, payload, schedule)
			} catch (error) {
				await impl.recoverTeamInviteCallbackFailure(
					this,
					payload,
					schedule,
					error,
				)
			}
		})
	}

	// Schedule callback: one member DM per tick.
	async runTeamInviteStep(
		payload: TeamInvitePayload,
		schedule: Schedule<TeamInvitePayload>,
	): Promise<void> {
		const impl = await this.loadImpl()
		return runInDbScope(async () => {
			try {
				await impl.runTeamInviteStep(this, payload, schedule)
			} catch (error) {
				await impl.recoverTeamInviteCallbackFailure(
					this,
					payload,
					schedule,
					error,
				)
			}
		})
	}

	// Soft-hello for members who join the workspace later.
	// True = terminal outcome; false lets the events route skip dedup so Slack retries.
	async onSlackTeamJoin(payload: SlackTeamJoinPayload): Promise<boolean> {
		const impl = await this.loadImpl()
		return runInDbScope(() => impl.onSlackTeamJoin(this, payload))
	}

	async runSlackTeamJoinRetry(
		payload: SlackTeamJoinRetryPayload,
	): Promise<void> {
		const impl = await this.loadImpl()
		return runInDbScope(() => impl.runSlackTeamJoinRetry(this, payload))
	}

	async onSlackUserChange(payload: SlackUserChangePayload): Promise<void> {
		const impl = await this.loadImpl()
		return runInDbScope(() => impl.onSlackUserChange(this, payload))
	}

	async runSlackUserChangeRetry(
		payload: SlackUserChangeRetryPayload,
	): Promise<void> {
		const impl = await this.loadImpl()
		return runInDbScope(() => impl.runSlackUserChangeRetry(this, payload))
	}

	// Remember the #company-brain home channel created at install bootstrap.
	async setHomeChannel(payload: HomeChannel): Promise<void> {
		return (await this.loadImpl()).setHomeChannel(this, payload)
	}

	async getHomeChannel(): Promise<HomeChannel | null> {
		return (await this.loadImpl()).getHomeChannel(this)
	}

	// Post the research digest at install time when a run already finished.
	async announceResearchIfDone(): Promise<void> {
		return (await this.loadImpl()).announceResearchIfDone(this)
	}

	async syncResearchCardIfDone(): Promise<void> {
		return (await this.loadImpl()).syncResearchCardIfDone(this)
	}

	async armJourney(payload: JourneyTickPayload): Promise<void> {
		return (await this.loadImpl()).armJourney(this, payload)
	}

	async runJourneyTick(payload: JourneyTickPayload): Promise<void> {
		return (await this.loadImpl()).runJourneyTick(this, payload)
	}

	async journeySnapshot(): Promise<JourneySnapshot> {
		return (await this.loadImpl()).journeySnapshot(this)
	}

	async resetJourney(): Promise<void> {
		return (await this.loadImpl()).resetJourney(this)
	}

	async ensureAdminRolloutCard(
		payload: AdminRolloutCardPayload,
	): Promise<void> {
		return (await this.loadImpl()).ensureAdminRolloutCard(this, payload)
	}

	async ensurePublicChannelRolloutCard(
		payload: PublicChannelRolloutCardPayload,
	): Promise<void> {
		return (await this.loadImpl()).ensurePublicChannelRolloutCard(this, payload)
	}

	async startPublicChannelRollout(
		payload: PublicChannelRolloutStart,
	): Promise<void> {
		return (await this.loadImpl()).startPublicChannelRollout(this, payload)
	}

	async runPublicChannelRollout(
		payload: PublicChannelRolloutPayload,
	): Promise<void> {
		return (await this.loadImpl()).runPublicChannelRollout(this, payload)
	}

	async getPublicChannelRolloutOverview(): Promise<PublicChannelRolloutOverview | null> {
		return (await this.loadImpl()).getPublicChannelRolloutOverview(this)
	}

	async armPublicChannelBeachhead(
		payload: PublicChannelBeachhead,
	): Promise<void> {
		return (await this.loadImpl()).armPublicChannelBeachhead(this, payload)
	}

	// Schedule callback: joins the busiest channels with notice at action time.
	async runPublicChannelBeachhead(
		payload: PublicChannelBeachhead,
	): Promise<void> {
		return (await this.loadImpl()).runPublicChannelBeachhead(this, payload)
	}

	// Safety-net alarm: nudge tools if the installer never replied.
	async runInstallNudge(): Promise<void> {
		return (await this.loadImpl()).runInstallNudge(this)
	}

	// After trial attach: schedule day-12 / 15 / 17 activate reminders.

	// Delayed post-turn session reflect
	async runPostTurnReflect(
		payload: PostTurnReflectPayload,
		schedule: Schedule<PostTurnReflectPayload>,
	): Promise<void> {
		return (await this.loadImpl()).runPostTurnReflect(this, payload, schedule)
	}

	async runChannelObserve(
		payload: ChannelObservePayload,
		schedule: Schedule<ChannelObservePayload>,
	): Promise<void> {
		return (await this.loadImpl()).runChannelObserve(this, payload, schedule)
	}

	// A cron-shaped invocation can only be a retired daily schedule, and boot-time
	// cleanup can lose the race to a due alarm, so refuse it here.
	async runAutoResearch(
		payload: AutoResearchPayload,
		schedule: Schedule<AutoResearchPayload>,
	): Promise<void> {
		if (schedule?.type === "cron") {
			console.warn(
				`[company-brain] refused retired auto-research cron org=${this.name} schedule=${schedule.id}`,
			)
			await this.cancelSchedule(schedule.id).catch(() => {})
			return
		}
		return (await this.loadImpl()).runAutoResearch(this, payload)
	}

	// Queue a run to fire in the DO immediately, so the HTTP trigger returns right
	// away instead of blocking on a sequence of full agent turns.
	async enqueueAutoResearchRun(
		payload: AutoResearchPayload = {},
	): Promise<void> {
		await this.schedule(0, AUTO_RESEARCH_CALLBACK, payload)
	}

	async autoResearchRunState(): Promise<{
		running: boolean
		freeAt: number | null
	}> {
		return (await this.loadImpl()).autoResearchRunState(this)
	}

	async listAutoResearchDrafts(opts: {
		status?: DraftStatus
		limit?: number
	}): Promise<AutoResearchDraft[]> {
		return (await this.loadImpl()).listAutoResearchDrafts(this, opts)
	}

	// Deliver one reviewed draft. The only path from a draft to Slack.
	async sendAutoResearchDraft(draftId: string): Promise<SendDraftResult> {
		return (await this.loadImpl()).sendAutoResearchDraft(this, draftId)
	}

	async dismissAutoResearchDraft(draftId: string): Promise<boolean> {
		return (await this.loadImpl()).dismissAutoResearchDraft(this, draftId)
	}

	// Reviewer rewrote a pending draft before sending it.
	async editAutoResearchDraft(draftId: string, body: string): Promise<boolean> {
		return (await this.loadImpl()).editAutoResearchDraftBody(
			this,
			draftId,
			body,
		)
	}

	// Operator asking about this workspace from the admin console. Read-only.
	async runAdminChat(input: AdminChatInput): Promise<AdminChatResult> {
		return (await this.loadImpl()).runAdminChat(this, input)
	}

	// What happened to a sent draft: reactions and thread replies.
	async readAutoResearchOutcome(draftId: string) {
		return (await this.loadImpl()).readDraftOutcome(this, draftId)
	}

	// Memory surfaces an operator can scope a question to.
	async listBrainSurfaces(): Promise<BrainSurface[]> {
		return (await this.loadImpl()).listBrainSurfaces(this)
	}

	// Schedule callback: referenced by name in scheduleBrainTask, invoked by the DO alarm.
	async runScheduledTask(
		payload: ScheduledTaskPayload,
		schedule: Schedule<ScheduledTaskPayload>,
	): Promise<void> {
		return (await this.loadImpl()).runScheduledTask(this, payload, schedule)
	}

	// List automations: admins see all, members see only their own.
	async listAutomations(userId: string, isAdmin: boolean) {
		return (await this.loadImpl()).listAutomations(this, { userId, isAdmin })
	}

	// Create an automation + arm its schedule. Called from the HTTP route.
	async createAutomation(
		input: AutomationInput,
		creatorUserId: string,
		creatorEmail: string,
		isAdmin: boolean,
	) {
		return (await this.loadImpl()).createAutomation(
			this,
			input,
			creatorUserId,
			creatorEmail,
			isAdmin,
		)
	}

	// Update an automation (owner or admin) + (re)arm its schedule.
	async updateAutomation(
		id: string,
		input: AutomationInput,
		userId: string,
		editorEmail: string,
		isAdmin: boolean,
	) {
		return (await this.loadImpl()).updateAutomation(
			this,
			id,
			input,
			userId,
			editorEmail,
			isAdmin,
		)
	}

	// Delete an automation (owner or admin) + cancel its schedule.
	async deleteAutomation(id: string, userId: string, isAdmin: boolean) {
		return (await this.loadImpl()).deleteAutomation(this, id, userId, isAdmin)
	}

	// Fire an automation right now (owner or admin).
	async runAutomationNow(id: string, userId: string, isAdmin: boolean) {
		return (await this.loadImpl()).runAutomationNow(this, id, userId, isAdmin)
	}

	async listSkills(userId: string, isAdmin: boolean) {
		return (await this.loadImpl()).listSkills(this, { userId, isAdmin })
	}

	async createSkill(
		org: SlackOrg,
		input: SkillCreateInput,
		creatorUserId: string,
		isAdmin: boolean,
	) {
		return (await this.loadImpl()).createSkillWithSideEffects(
			this,
			org,
			input,
			creatorUserId,
			isAdmin,
		)
	}

	async updateSkill(
		org: SlackOrg,
		id: string,
		input: SkillEditableInput,
		userId: string,
		isAdmin: boolean,
		expectedVersion: number,
	) {
		return (await this.loadImpl()).updateSkillWithSideEffects(
			this,
			org,
			id,
			input,
			userId,
			isAdmin,
			expectedVersion,
		)
	}

	async deleteSkill(
		id: string,
		userId: string,
		isAdmin: boolean,
		expectedVersion: number,
	) {
		return (await this.loadImpl()).deleteSkillWithSideEffects(
			this,
			id,
			userId,
			isAdmin,
			expectedVersion,
		)
	}
}
