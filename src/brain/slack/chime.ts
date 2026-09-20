import { generateId } from "@repo/lib/generate-id"
import { decryptToken } from "@/lib/crypto"
import { orgCanRunCompanyBrain } from "@/lib/payments/company-brain-entitlement"
import { cleanMention } from "../prompt/build"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { getHomeChannel } from "../turn/home-channel"
import { resolveBrainTriageProfile } from "../turn/model-profile"
import { formatChannelMessages, formatSlackTsHuman } from "./channel-lookup"
import { armChannelObserve } from "./channel-observe"
import {
	canUseAnswerFallback,
	releasePassiveInvestigation,
	reserveChimeAnswer,
	reservePassiveInvestigation,
} from "./chime-budget"
import {
	getSlackBotIdentity,
	getSlackChannelHistory,
	type SlackThreadMessage,
} from "./client"
import {
	claimLocalContextWarmup,
	claimStoredEventForTriage,
	getPreviousHumanChannelActivityAt,
	loadLocalChannelContext,
	markLocalContextWarm,
	markStoredEventFiltered,
	mergeSlackHistoryIntoLocalContext,
	recordSlackEvent,
	recordStoredActionOutcome,
	recordStoredSuppression,
	recordStoredTriageDecision,
} from "./event-store"
import {
	isBotMentioned,
	isEmojiOnlySlackText,
	isSlackContentMessageSubtype,
	mentionedUserIds,
	type SlackTurnMessage,
	triageProfileUserIds,
} from "./events"
import {
	PROACTIVITY_FILTER_REASON,
	resolveChannelProactivity,
} from "./proactivity"
import {
	getCachedSlackChannelInfo,
	getCachedSlackUserInfo,
	getCachedSlackUserProfiles,
} from "./profile-cache"
import { isChannelAwaitingRolloutIntroduction } from "./public-channel-rollout"
import { enqueuePassiveReaction } from "./reaction-queue"
import {
	type TriageAddressedTarget,
	type TriageObservabilityContext,
	triageChimeMessage,
} from "./triage"
import { reserveTriageTraceSample } from "./triage-sampling"
import { runSlackTurn } from "./turn"
import {
	ensureWorkspaceBotUserId,
	getOrgActorBySlackIdentity,
	getWorkspaceByTeamId,
	type SlackOrg,
} from "./workspace"

const CHANNEL_CONTEXT_LIMIT = 20

function formatChannelContext(
	messages: SlackThreadMessage[],
	userNames: Map<string, string>,
	botUserIds: ReadonlySet<string>,
	excludeTs: string | undefined,
	tzOffsetSeconds = 0,
): string {
	const formatted = formatChannelMessages(
		messages.filter((m) => m.ts !== excludeTs),
		userNames,
		tzOffsetSeconds,
	)
	const botMessageTs = new Set(
		messages
			.filter(
				(message) =>
					message.bot_id ||
					message.app_id ||
					message.subtype === "bot_message" ||
					(message.user && botUserIds.has(message.user)),
			)
			.map((message) => message.ts)
			.filter((ts): ts is string => Boolean(ts)),
	)
	return formatted
		.map((m) =>
			botMessageTs.has(m.ts)
				? `${m.speaker} (app): ${m.text}`
				: `${m.speaker}: ${m.text}`,
		)
		.slice(-CHANNEL_CONTEXT_LIMIT)
		.join("\n")
}

function structuralFilterReason(msg: SlackTurnMessage): string | undefined {
	const ev = msg.event
	if (ev.bot_id || ev.app_id || ev.subtype === "bot_message") {
		return "Bot-authored messages are context only and are never triaged."
	}
	if (!isSlackContentMessageSubtype(ev.subtype)) {
		return `Slack message subtype ${ev.subtype} is context-only noise.`
	}
	const text = ev.text?.trim()
	if (!text) return "The Slack message has no triageable text."
	if (isEmojiOnlySlackText(text)) {
		return "Emoji-only Slack messages are filtered before model triage."
	}
	return undefined
}

function scheduleSuppressionTelemetry(
	agent: CompanyBrainAgent,
	obs: TriageObservabilityContext,
	args: {
		reason: string
		priority?: string
		decision?: string
		fallbackUsed?: boolean
	},
): void {
	agent.waitUntil(
		(async () => {
			try {
				const { captureBrainProactivitySuppression } = await import(
					"../observability"
				)
				await captureBrainProactivitySuppression({ ...obs, ...args })
			} catch {
				console.warn(
					`[company-brain] proactivity suppression telemetry failed trace=${obs.traceId}`,
				)
			}
		})(),
	)
}

async function warmLocalChannelContext(
	agent: CompanyBrainAgent,
	args: {
		teamId: string
		botToken: string
		channel: string
		currentMessageTs: string
	},
): Promise<void> {
	if (
		!claimLocalContextWarmup(agent, {
			teamId: args.teamId,
			channel: args.channel,
			currentMessageTs: args.currentMessageTs,
		})
	) {
		return
	}
	try {
		const result = await getSlackChannelHistory(args.botToken, args.channel, {
			limit: 50,
		})
		// Leave context cold on rate-limit or API error so the next event retries.
		if (!result.ok) return
		const history = result.messages
		mergeSlackHistoryIntoLocalContext(agent, {
			teamId: args.teamId,
			channel: args.channel,
			messages: history,
		})
		// A successful history read includes at least the triggering message.
		// Empty results are left cold so a transient Slack failure can retry later.
		if (history.length > 0) {
			markLocalContextWarm(agent, {
				teamId: args.teamId,
				channel: args.channel,
			})
		}
	} catch (error) {
		console.warn(
			`[company-brain] local channel context warmup failed channel=${args.channel} error=${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

async function runSlackChimeInForWorkspace(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
	ws: NonNullable<Awaited<ReturnType<typeof getWorkspaceByTeamId>>>,
): Promise<void> {
	const identity = recordSlackEvent(agent, msg)
	if (!identity) return
	const structuralReason = structuralFilterReason(msg)
	if (structuralReason) {
		markStoredEventFiltered(agent, identity, structuralReason)
		return
	}
	const triageClaim = claimStoredEventForTriage(agent, identity)
	if (!triageClaim) return
	msg.triageClaimId = triageClaim.id

	const ev = msg.event
	if (ev.thread_ts || !ev.channel || !ev.user) {
		markStoredEventFiltered(
			agent,
			identity,
			"The channel chime path only judges top-level human messages.",
			triageClaim.id,
		)
		return
	}
	const question = cleanMention(ev.text)
	if (!question) {
		markStoredEventFiltered(
			agent,
			identity,
			"The cleaned message was empty.",
			triageClaim.id,
		)
		return
	}

	const org: SlackOrg = {
		id: ws.orgId,
		name: ws.orgName,
		slug: ws.orgSlug,
		metadata: ws.orgMetadata,
	}
	const botToken = await decryptToken(
		ws.botTokenEnc,
		brainAgent(agent).env.ENCRYPTION_SECRET,
	)
	let botUserId = ws.botUserId
	if (!botUserId) {
		const { userId } = await getSlackBotIdentity(botToken)
		botUserId = await ensureWorkspaceBotUserId(
			brainAgent(agent).env,
			ws,
			botToken,
			userId,
		)
	}
	if (isBotMentioned(ev.text, botUserId)) {
		markStoredEventFiltered(
			agent,
			identity,
			"Explicit bot mentions bypass unsolicited proactivity budgets.",
			triageClaim.id,
		)
		return
	}

	const channelInfo = await getCachedSlackChannelInfo(agent, {
		teamId: msg.teamId,
		botToken,
		channelId: identity.channel,
	})
	const proactivity = resolveChannelProactivity({
		settings: ws.brainProactivity,
		channelId: identity.channel,
		homeChannelId: getHomeChannel(agent)?.channelId,
		channelName: channelInfo?.name,
	})
	if (proactivity === "quiet") {
		markStoredEventFiltered(
			agent,
			identity,
			PROACTIVITY_FILTER_REASON,
			triageClaim.id,
		)
		return
	}

	const askerLookup = await getCachedSlackUserInfo(agent, {
		teamId: msg.teamId,
		botToken,
		userId: ev.user,
	})
	if (!askerLookup.ok) {
		markStoredEventFiltered(
			agent,
			identity,
			`Slack speaker verification failed: ${askerLookup.reason}.`,
			triageClaim.id,
		)
		return
	}
	const asker = askerLookup.user
	const orgMember = (
		await getOrgActorBySlackIdentity(brainAgent(agent).env, {
			orgId: org.id,
			teamId: msg.teamId,
			slackUserId: ev.user,
			email: asker.email,
		})
	).actor
	if (!orgMember) {
		markStoredEventFiltered(
			agent,
			identity,
			"The Slack speaker is not a current member of this organization.",
			triageClaim.id,
		)
		return
	}

	await warmLocalChannelContext(agent, {
		teamId: msg.teamId,
		botToken,
		channel: identity.channel,
		currentMessageTs: identity.messageTs,
	})
	const history = loadLocalChannelContext(agent, {
		teamId: msg.teamId,
		channel: identity.channel,
		beforeTs: identity.messageTs,
		limit: CHANNEL_CONTEXT_LIMIT,
	})
	const otherMentionIds = mentionedUserIds(ev.text, botUserId)
	const profiles = await getCachedSlackUserProfiles(agent, {
		teamId: msg.teamId,
		botToken,
		userIds: triageProfileUserIds({
			currentUserId: ev.user,
			mentionedIds: otherMentionIds,
			history,
			botUserId,
		}),
	})
	const userNames = new Map<string, string>()
	const botUserIds = new Set<string>()
	for (const [id, profile] of profiles) {
		userNames.set(id, profile.name ?? profile.displayName ?? id)
		if (profile.isBot) botUserIds.add(id)
	}
	if (botUserId) botUserIds.add(botUserId)
	const addressedTargets: TriageAddressedTarget[] = otherMentionIds.map(
		(slackUserId) => ({
			slackUserId,
			name: userNames.get(slackUserId),
			isBot: profiles.get(slackUserId)?.isBot === true,
		}),
	)
	const traceId = generateId()
	const traceSampling = reserveTriageTraceSample(agent, {
		orgId: org.id,
		traceId,
	})
	const obs: TriageObservabilityContext = {
		orgId: org.id,
		distinctId: orgMember.userId,
		traceId,
		sessionId: `${identity.channel}:${identity.messageTs}`,
		channel: identity.channel,
		messageTs: identity.messageTs,
		threadTs: identity.messageTs,
		chimeContext: "channel",
		triageTraceSampled: traceSampling.sampled,
		triageTraceSampleRate: traceSampling.sampleRate,
	}
	const triage = await triageChimeMessage(brainAgent(agent).env, {
		context: "channel",
		profile: resolveBrainTriageProfile(org.metadata),
		question,
		contextText: formatChannelContext(
			history,
			userNames,
			botUserIds,
			identity.messageTs,
			asker.tzOffset,
		),
		waitUntil: (promise) => agent.waitUntil(promise),
		currentSpeaker: {
			name: asker.name ?? asker.displayName,
			slackUserId: ev.user,
		},
		messageStamp: formatSlackTsHuman(identity.messageTs, asker.tzOffset),
		addressedTargets,
		channel: channelInfo,
		obs,
	})
	const finalized = recordStoredTriageDecision(agent, identity, {
		decision: triage.decision,
		claimId: triageClaim.id,
		source: triage.source,
		...("priority" in triage ? { priority: triage.priority } : {}),
		...("reason" in triage ? { reason: triage.reason } : {}),
		...(triage.decision === "ack" ? { emoji: triage.emoji } : {}),
		...(triage.decision === "answer" && triage.fallbackEmoji
			? { fallbackEmoji: triage.fallbackEmoji }
			: {}),
		traceId,
	})
	if (!finalized) {
		console.warn(
			`[company-brain] channel chime discarded stale triage result team=${identity.teamId} channel=${identity.channel} message=${identity.messageTs}`,
		)
		return
	}
	console.log(
		`[company-brain] channel chime triage=${triage.decision} source=${triage.source} priority=${"priority" in triage ? triage.priority : "-"} agentEffort=${"agentMainEffort" in triage ? (triage.agentMainEffort ?? "-") : "-"} trace=${traceId} org=${org.id} channel=${identity.channel} message=${identity.messageTs}`,
	)

	if (triage.decision === "pass") {
		recordStoredActionOutcome(agent, identity, "silent_by_judgment")
		return
	}
	if (triage.decision === "ack") {
		await enqueuePassiveReaction(agent, {
			identity,
			emoji: triage.emoji,
			kind: "ack",
			reason: triage.reason,
			obs,
		})
		return
	}
	if (triage.decision === "answer") {
		const budget = reserveChimeAnswer(agent, {
			channelId: identity.channel,
			priority: triage.priority,
			lastChannelActivityAt: getPreviousHumanChannelActivityAt(agent, identity),
		})
		if (!budget.allowed) {
			const fallbackUsed = canUseAnswerFallback(
				budget.suppression,
				Boolean(triage.fallbackEmoji),
				triage.priority,
			)
			recordStoredSuppression(agent, identity, {
				suppression: budget.suppression,
				fallbackUsed,
			})
			scheduleSuppressionTelemetry(agent, obs, {
				reason: budget.suppression,
				priority: triage.priority,
				decision: triage.decision,
				fallbackUsed,
			})
			if (fallbackUsed && triage.fallbackEmoji) {
				await enqueuePassiveReaction(agent, {
					identity,
					emoji: triage.fallbackEmoji,
					kind: "answer_fallback",
					reason:
						"Triage explicitly supplied a semantically valid reaction fallback.",
					obs,
				})
			}
			return
		}
		recordStoredActionOutcome(agent, identity, "answer_budget_reserved")
		await runSlackTurn(agent, msg, {
			forceFullTurn: true,
			forceThreadTs: identity.messageTs,
			obsSource: "slack_chime_channel",
			traceId,
			skipPostTurnReflect: true,
			triageResult: "answer",
			agentMainEffort: triage.agentMainEffort,
		})
		recordStoredActionOutcome(agent, identity, "answer_turn_completed")
		return
	}

	const investigation = reservePassiveInvestigation(agent, {
		traceId,
		channelId: identity.channel,
		priority: triage.priority,
	})
	if (!investigation.allowed) {
		recordStoredSuppression(agent, identity, {
			suppression: investigation.suppression,
		})
		scheduleSuppressionTelemetry(agent, obs, {
			reason: investigation.suppression,
			priority: triage.priority,
			decision: triage.decision,
		})
		return
	}
	try {
		await runSlackTurn(agent, msg, {
			forceFullTurn: true,
			forceThreadTs: identity.messageTs,
			obsSource: "slack_chime_channel",
			traceId,
			skipPostTurnReflect: true,
			triageResult: "investigate",
			agentMainEffort: triage.agentMainEffort,
			passiveInvestigation: {
				reason: triage.reason,
				priority: triage.priority,
				obs,
				identity,
				claim: investigation.claim,
			},
		})
		// No-op if the turn's finalizer already completed the claim; closes an
		// admitted investigation that returned before creating a turn control.
		releasePassiveInvestigation(agent, investigation.claim, "silent")
	} catch (error) {
		releasePassiveInvestigation(agent, investigation.claim, "failed")
		throw error
	}
}

export async function runSlackChimeIn(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
): Promise<void> {
	const ws =
		msg.workspace?.teamId === msg.teamId && msg.workspace.orgId === agent.name
			? msg.workspace
			: await getWorkspaceByTeamId(brainAgent(agent).env, msg.teamId)
	if (!ws) {
		console.warn(
			`[company-brain] chime: no workspace for team ${msg.teamId}; dropping`,
		)
		return
	}
	if (ws.orgId !== agent.name) {
		console.error(
			`[company-brain] chime dropped: workspace rebound team=${msg.teamId} chimeOrg=${agent.name} currentOrg=${ws.orgId}`,
		)
		return
	}
	if (
		!(await orgCanRunCompanyBrain(brainAgent(agent).env, ws.orgId, (promise) =>
			agent.waitUntil(promise),
		))
	) {
		return
	}
	const channel = msg.event.channel
	if (channel) {
		agent.waitUntil(
			armChannelObserve(agent, { teamId: msg.teamId, channel }).catch((err) => {
				console.warn("[company-brain] channel-observe arm failed:", err)
			}),
		)
	}
	if (channel && isChannelAwaitingRolloutIntroduction(agent, channel)) return
	await runSlackChimeInForWorkspace(agent, msg, ws)
}
