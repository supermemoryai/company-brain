import type { ToolSet } from "ai"
import { parseCronExpression } from "cron-schedule"
import type { SlackMemoryScope } from "../memory"
import { logPreview } from "../observability/log-utils"
import {
	checkAskerCanSearchChannel,
	resolveChannel,
} from "../slack/channel-directory"
import type { SlackMember } from "../slack/client"
import type { CompanyBrainAgent } from "../turn/agent"
import type { TurnDeps } from "../turn/deps"
import {
	deriveScheduleRelatedPeople,
	type RelatedPersonInput,
} from "./schedule-related-people"
import {
	cancelBrainTask,
	derivedScheduleFields,
	listBrainTasks,
	listBrainTasksCreatedBy,
	type ReplaceBrainTaskChanges,
	replaceBrainTask,
	type ScheduleWhen,
	scheduleBrainTask,
	scheduleNextRunIso,
	scheduleRelationship,
} from "./scheduling"

const MIN_CRON_INTERVAL_SECONDS = 300
const MIN_DELAY_SECONDS = 30
const MAX_SCHEDULES_PER_USER = 25

function cronIntervalSeconds(cron: string): number | null {
	try {
		const sched = parseCronExpression(cron)
		const first = sched.getNextDate(new Date())
		const second = sched.getNextDate(first)
		return Math.round((second.getTime() - first.getTime()) / 1000)
	} catch {
		return null
	}
}

type TimingInput = {
	atIso?: string
	inSeconds?: number
	cron?: string
}

function countTimingFields(input: TimingInput): number {
	return [input.atIso?.trim(), input.inSeconds, input.cron?.trim()].filter(
		Boolean,
	).length
}

function normalizeTiming(input: TimingInput): ScheduleWhen | { error: string } {
	const atIsoNorm = input.atIso?.trim() || undefined
	const cronNorm = input.cron?.trim() || undefined
	if (cronNorm) {
		const interval = cronIntervalSeconds(cronNorm)
		if (interval === null) {
			return { error: `cron is not a valid expression; got "${cronNorm}".` }
		}
		if (interval < MIN_CRON_INTERVAL_SECONDS) {
			return {
				error: `cron fires too often (every ${interval}s); minimum is ${MIN_CRON_INTERVAL_SECONDS}s.`,
			}
		}
		return { kind: "cron", cron: cronNorm }
	}
	if (atIsoNorm) {
		const at = new Date(atIsoNorm)
		if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
			return {
				error: `atIso must be a valid future ISO 8601 datetime; got "${atIsoNorm}".`,
			}
		}
		return { kind: "at", iso: atIsoNorm }
	}
	if (input.inSeconds !== undefined) {
		if (input.inSeconds < MIN_DELAY_SECONDS) {
			return { error: `inSeconds must be at least ${MIN_DELAY_SECONDS}.` }
		}
		return { kind: "in", delaySeconds: input.inSeconds }
	}
	return { error: "Provide exactly one of atIso, inSeconds, or cron." }
}

function hasTiming(input: TimingInput): boolean {
	return countTimingFields(input) > 0
}

function replaceScheduledTaskErrorMessage(error: string): string {
	switch (error) {
		case "creator_only":
			return "Only the reminder creator can update it. You can cancel it instead."
		case "missing_timing":
			return "This legacy reminder is missing its original timing metadata; provide new timing to update it."
		case "missing_requester":
			return "Your Slack identity is unavailable, so I can't update this reminder."
		default:
			return "No reminder with that id that you can manage. Automations are managed separately."
	}
}

export type SchedulerToolContext = {
	env: Env
	botToken: string
	teamId: string
	channel: string
	threadTs?: string
	creatorUserId?: string
	creatorSlackUserId?: string
	isDirectMessage?: boolean
	memoryScope?: SlackMemoryScope
	isOrgMember?: boolean
	askerIsRestricted?: boolean
	requestText?: string
	directMentionSlackUserIds?: string[]
	directory?: SlackMember[]
}

export type SchedulerDestination = {
	deliverTo: "origin" | "dm" | "channel"
	channel: string
	channelName?: string
	threadTs?: string
	memoryScope?: SlackMemoryScope
}

type SchedulerDestinationResult =
	| { ok: true; destination: SchedulerDestination }
	| { ok: false; error: string }

type SchedulerDestinationDeps = {
	resolveChannel: typeof resolveChannel
	checkChannelAccess: typeof checkAskerCanSearchChannel
}

/** Resolve and authorize the persisted delivery target before scheduling. */
export async function resolveSchedulerDestination(
	ctx: SchedulerToolContext,
	deliverTo: "origin" | "dm" | "channel" | undefined,
	channelRef: string | undefined,
	overrides: Partial<SchedulerDestinationDeps> = {},
): Promise<SchedulerDestinationResult> {
	if (deliverTo === "dm") {
		const needsNewDm = !ctx.isDirectMessage
		if (needsNewDm && !ctx.creatorSlackUserId) {
			return {
				ok: false,
				error:
					"Can't send a DM reminder: the asker's Slack identity is unavailable. Schedule it here instead.",
			}
		}
		return {
			ok: true,
			destination: {
				deliverTo: needsNewDm ? "dm" : "origin",
				channel: ctx.channel,
				threadTs: needsNewDm ? undefined : ctx.threadTs,
				memoryScope: ctx.memoryScope,
			},
		}
	}

	const requestedChannel = channelRef?.trim()
	if (deliverTo === "origin" || !requestedChannel) {
		return {
			ok: true,
			destination: {
				deliverTo: "origin",
				channel: ctx.channel,
				threadTs: ctx.threadTs,
				memoryScope: ctx.memoryScope,
			},
		}
	}
	const ref = requestedChannel

	const resolve = overrides.resolveChannel ?? resolveChannel
	const resolution = await resolve(ctx.env, ctx.teamId, ctx.botToken, ref)
	if (resolution.status === "unknown") {
		const displayRef =
			ref.startsWith("#") || ref.startsWith("<#") ? ref : `#${ref}`
		return {
			ok: false,
			error: `I couldn't find ${displayRef}. Check the channel name, or invite me to it with /invite.`,
		}
	}
	if (resolution.status === "not_member") {
		return {
			ok: false,
			error: `I'm not a member of #${resolution.name}. Invite me there with /invite before scheduling this.`,
		}
	}

	const target = resolution.channel
	const checkAccess = overrides.checkChannelAccess ?? checkAskerCanSearchChannel
	const access = await checkAccess(
		ctx.env,
		ctx.teamId,
		ctx.botToken,
		target,
		ctx.creatorSlackUserId,
		{
			currentChannelId: ctx.channel,
			isOrgMember: ctx.isOrgMember,
			responseSurface: target.isPrivate ? "private_channel" : "public_channel",
			responseChannelId: target.id,
			askerIsRestricted: ctx.askerIsRestricted,
		},
	)
	if (!access.ok) {
		if (
			access.reason === "private_channel_requires_membership" ||
			access.reason === "unknown_asker"
		) {
			return {
				ok: false,
				error: `I can't schedule a post in #${target.name} because you're not a member of it.`,
			}
		}
		if (access.reason === "private_channel_non_dm_response") {
			return {
				ok: false,
				error: `I can't deliver this schedule safely in #${target.name}.`,
			}
		}
		return {
			ok: false,
			error:
				"I can only schedule posts to another channel for confirmed organization members.",
		}
	}

	return {
		ok: true,
		destination: {
			deliverTo: "channel",
			channel: target.id,
			channelName: target.name,
			threadTs: undefined,
			memoryScope: target.isPrivate
				? {
						kind: "private_channel",
						channelId: target.id,
						userId: ctx.creatorUserId,
					}
				: { kind: "shared", channelId: target.id },
		},
	}
}

export function createSchedulerTools(
	agent: CompanyBrainAgent,
	deps: TurnDeps,
	ctx: SchedulerToolContext,
	traceId: string,
): ToolSet {
	const relatedPersonSchema = deps.z.object({
		name: deps.z.string().optional(),
		slackUserId: deps.z.string().optional(),
		role: deps.z.enum(["direct_target", "primary_participant"]),
	})
	const deriveRelatedPeopleForTool = (args: {
		instruction: string
		relatedSlackUserIds?: string[]
		relatedPeople?: RelatedPersonInput[]
		includeRequestText?: boolean
		emptyRelatedInputIsExplicit?: boolean
	}) =>
		deriveScheduleRelatedPeople({
			requestText:
				args.includeRequestText === false ? undefined : ctx.requestText,
			instruction: args.instruction,
			creatorSlackUserId: ctx.creatorSlackUserId,
			directMentionSlackUserIds: ctx.directMentionSlackUserIds,
			directory: ctx.directory,
			relatedSlackUserIds: args.relatedSlackUserIds,
			relatedPeople: args.relatedPeople,
			emptyRelatedInputIsExplicit: args.emptyRelatedInputIsExplicit,
		})
	const schedule_task = deps.tool({
		description:
			"Schedule the brain to run an instruction later and deliver the result in Slack. Use for reminders, recurring digests, or follow-ups (e.g. 'every Monday 9am summarize last week', 'in 2 hours remind me to ship'). Provide exactly one timing: `atIso` (one-time), `inSeconds` (relative), or `cron` (recurring). Manual reminders always default to the channel/thread where the asker created them. When the asker explicitly names another destination channel, always pass it in `channel`; supplying `channel` selects channel delivery even if `deliverTo` is omitted. Set `deliverTo` to 'dm' only when the asker explicitly requests a personal DM reminder. Add related people only when they are direct ping/notify/update targets or primary shared participants, not incidental mentions or private subjects. Related people may cancel the reminder, but only its creator may update it.",
		inputSchema: deps.z
			.object({
				instruction: deps.z
					.string()
					.describe(
						"What the brain should do when this fires, phrased as a task, e.g. 'Summarize this week's shipped work and open questions.'",
					),
				label: deps.z
					.string()
					.describe(
						"Short human label for the schedule, e.g. 'Weekly digest'.",
					),
				atIso: deps.z
					.string()
					.optional()
					.describe("One-time run at this ISO 8601 datetime (UTC)."),
				inSeconds: deps.z
					.number()
					.int()
					.positive()
					.optional()
					.describe("One-time run this many seconds from now."),
				cron: deps.z
					.string()
					.optional()
					.describe("Recurring run on this cron expression (UTC)."),
				deliverTo: deps.z
					.enum(["origin", "dm", "channel"])
					.optional()
					.describe(
						"Where to deliver. 'origin' (default) = the channel/thread where the reminder is created; 'dm' = a personal reminder to the asker; 'channel' = an explicitly named destination channel. 'channel' without a named channel safely falls back to origin.",
					),
				channel: deps.z
					.string()
					.optional()
					.describe(
						"Destination channel name, #name, id, or native <#id> token. Pass it only when the asker explicitly names another delivery channel. When omitted, delivery stays in the originating thread.",
					),
				relatedSlackUserIds: deps.z
					.array(deps.z.string())
					.max(10)
					.optional()
					.describe(
						"Slack IDs for direct reminder targets or primary shared participants who may cancel this reminder. Only the creator may update it. The server filters this to eligible people only.",
					),
				relatedPeople: deps.z.array(relatedPersonSchema).max(10).optional(),
				kind: deps.z
					.enum(["reminder", "digest"])
					.optional()
					.describe(
						"What this is. 'reminder' (default) delivers the asker's own message back when it fires. 'digest' produces a fresh read-only roundup from channels and org-shared tools, so pick it only for a recurring team summary, never for a personal nudge.",
					),
			})
			.refine((v) => countTimingFields(v) === 1, {
				message: "Provide exactly one of atIso, inSeconds, or cron.",
			}),
		execute: async ({
			instruction,
			label,
			atIso,
			inSeconds,
			cron,
			deliverTo,
			channel: destinationChannel,
			relatedSlackUserIds,
			relatedPeople,
			kind,
		}) => {
			if (
				ctx.creatorSlackUserId &&
				listBrainTasksCreatedBy(agent, ctx.creatorSlackUserId).length >=
					MAX_SCHEDULES_PER_USER
			) {
				return {
					error: `You already have the maximum of ${MAX_SCHEDULES_PER_USER} scheduled tasks. Cancel one before adding another.`,
				}
			}

			const when = normalizeTiming({ atIso, inSeconds, cron })
			if ("error" in when) return when

			const destination = await resolveSchedulerDestination(
				ctx,
				deliverTo,
				destinationChannel,
			)
			if (!destination.ok) return { error: destination.error }
			const target = destination.destination

			const relatedPeopleIds = deriveRelatedPeopleForTool({
				instruction,
				relatedSlackUserIds,
				relatedPeople: relatedPeople as RelatedPersonInput[] | undefined,
			})

			// Timing says how often, not what it is.
			const taskKind = when.kind === "cron" ? (kind ?? "reminder") : "reminder"

			let created: Awaited<ReturnType<typeof scheduleBrainTask>>
			try {
				created = await scheduleBrainTask(agent, when, {
					teamId: ctx.teamId,
					channel: target.channel,
					channelName: target.channelName,
					threadTs: target.threadTs,
					instruction,
					label,
					creatorUserId: ctx.creatorUserId,
					creatorSlackUserId: ctx.creatorSlackUserId,
					deliverTo: target.deliverTo,
					memoryScope: target.memoryScope,
					relatedSlackUserIds: relatedPeopleIds,
					scheduledWhen: when,
					kind: taskKind,
					...derivedScheduleFields({
						when,
						kind: taskKind,
						deliverTo: target.deliverTo,
					}),
				})
			} catch (err) {
				console.warn(`[company-brain][${traceId}] schedule_task failed:`, err)
				return {
					error:
						"Could not create the schedule. Check the timing and try again.",
				}
			}
			console.log(
				`[company-brain][${traceId}] schedule_task id=${created.id} when=${when.kind} deliverTo=${target.deliverTo} related=${relatedPeopleIds.length} label="${logPreview(label)}"`,
			)
			return {
				id: created.id,
				type: created.type,
				nextRun: scheduleNextRunIso(created.time),
				deliverTo: target.deliverTo,
				...(target.channelName ? { channel: `#${target.channelName}` } : {}),
				label,
				relatedSlackUserIds: relatedPeopleIds,
				scheduledWhen: when,
			}
		},
	})

	const list_scheduled_tasks = deps.tool({
		description:
			"List reminder schedules the asker created or is directly related to. Related people receive only the id, label, creator, and next run needed to identify and cancel a reminder; only creators receive its full details. Automation-backed digests are not shown. Call before changing or cancelling a reminder.",
		inputSchema: deps.z.object({}),
		execute: async () => {
			const tasks = listBrainTasks(agent, ctx.creatorSlackUserId)
			console.log(
				`[company-brain][${traceId}] list_scheduled_tasks count=${tasks.length}`,
			)
			return tasks.map((task) => {
				const relationship = scheduleRelationship(
					task.payload,
					ctx.creatorSlackUserId,
				)
				const common = {
					id: task.id,
					type: task.type,
					nextRun: scheduleNextRunIso(task.time),
					label: task.payload.label,
					creatorSlackUserId: task.payload.creatorSlackUserId,
					relationship,
					canCancel: true,
					canReplace: relationship === "creator",
				}
				if (relationship === "related") return common

				return {
					...common,
					instruction: task.payload.instruction,
					deliverTo: task.payload.deliverTo ?? "origin",
					channel:
						task.payload.deliverTo === "dm"
							? "(DM)"
							: task.payload.channelName
								? `#${task.payload.channelName}`
								: task.payload.deliverTo === "channel"
									? "(channel)"
									: "(origin)",
					relatedSlackUserIds: task.payload.relatedSlackUserIds ?? [],
					scheduledWhen: task.payload.scheduledWhen,
					hasStoredTiming: Boolean(task.payload.scheduledWhen),
				}
			})
		},
	})

	const cancel_scheduled_task = deps.tool({
		description:
			"Cancel a reminder schedule by id. The asker must be its creator or a directly related person. Automation-backed digests cannot be cancelled through this tool. Get the id from list_scheduled_tasks first.",
		inputSchema: deps.z.object({
			id: deps.z.string().describe("Schedule id to cancel."),
		}),
		execute: async ({ id }) => {
			const cancelled = await cancelBrainTask(agent, id, ctx.creatorSlackUserId)
			console.log(
				`[company-brain][${traceId}] cancel_scheduled_task id=${id} cancelled=${cancelled}`,
			)
			if (!cancelled) {
				return {
					id,
					cancelled: false,
					error:
						"No reminder with that id that you can cancel. Automations are managed separately.",
				}
			}
			return { id, cancelled }
		},
	})

	const replace_scheduled_task = deps.tool({
		description:
			"Update a reminder schedule created by the asker. Related people may cancel a reminder but cannot update it. This creates a replacement server-side while preserving unchanged fields and the original owner. Omit `deliverTo` to preserve the existing destination; explicitly selecting `origin` or `dm` moves the reminder to the current channel/thread or the asker's personal DM. Automation-backed digests are not supported. Legacy reminders without stored timing require new timing.",
		inputSchema: deps.z
			.object({
				id: deps.z.string().describe("Schedule id to replace."),
				instruction: deps.z.string().optional(),
				label: deps.z.string().optional(),
				atIso: deps.z.string().optional(),
				inSeconds: deps.z.number().int().positive().optional(),
				cron: deps.z.string().optional(),
				deliverTo: deps.z
					.enum(["origin", "dm"])
					.optional()
					.describe(
						"Where to move the reminder: 'origin' = this channel/thread; 'dm' = the asker's personal DM. Omit to preserve its current destination.",
					),
				relatedSlackUserIds: deps.z.array(deps.z.string()).max(10).optional(),
				relatedPeople: deps.z.array(relatedPersonSchema).max(10).optional(),
			})
			.refine((v) => countTimingFields(v) <= 1, {
				message: "Provide at most one of atIso, inSeconds, or cron.",
			}),
		execute: async ({
			id,
			instruction,
			label,
			atIso,
			inSeconds,
			cron,
			deliverTo,
			relatedSlackUserIds,
			relatedPeople,
		}) => {
			const timingInput = { atIso, inSeconds, cron }
			const timing = hasTiming(timingInput)
				? normalizeTiming(timingInput)
				: undefined
			if (timing && "error" in timing) return timing
			let destinationChanges: SchedulerDestination | undefined
			if (deliverTo !== undefined) {
				const destination = await resolveSchedulerDestination(
					ctx,
					deliverTo,
					undefined,
				)
				if (!destination.ok) return { error: destination.error }
				const target = destination.destination
				destinationChanges = {
					deliverTo: target.deliverTo,
					channel: target.channel,
					channelName: target.channelName,
					threadTs: target.threadTs,
					memoryScope: target.memoryScope,
				}
			}
			const shouldRecomputeRelatedPeople =
				instruction !== undefined ||
				relatedSlackUserIds !== undefined ||
				relatedPeople !== undefined
			let relatedPeopleIds: string[] | undefined
			const base = shouldRecomputeRelatedPeople
				? listBrainTasksCreatedBy(agent, ctx.creatorSlackUserId).find(
						(task) => task.id === id,
					)
				: undefined
			if (base) {
				const newInstruction = instruction ?? base.payload.instruction
				relatedPeopleIds = deriveRelatedPeopleForTool({
					instruction: newInstruction,
					relatedSlackUserIds,
					relatedPeople: relatedPeople as RelatedPersonInput[] | undefined,
					includeRequestText: false,
					emptyRelatedInputIsExplicit: true,
				})
			}
			const payloadChanges: NonNullable<ReplaceBrainTaskChanges["payload"]> = {
				...(instruction !== undefined ? { instruction } : {}),
				...(label !== undefined ? { label } : {}),
				...destinationChanges,
				...(relatedPeopleIds !== undefined
					? { relatedSlackUserIds: relatedPeopleIds }
					: {}),
			}
			const result = await replaceBrainTask(
				agent,
				id,
				{
					slackUserId: ctx.creatorSlackUserId,
				},
				{
					when: timing,
					payload: payloadChanges,
				},
			)
			if (!result.replaced) {
				return {
					id,
					replaced: false,
					error: replaceScheduledTaskErrorMessage(result.error),
				}
			}
			const schedule = result.schedule
			console.log(
				`[company-brain][${traceId}] replace_scheduled_task old=${id} new=${schedule.id} owner=${schedule.payload.creatorSlackUserId ?? "-"}`,
			)
			return {
				oldId: id,
				id: schedule.id,
				replaced: true,
				nextRun: scheduleNextRunIso(schedule.time),
				ownerSlackUserId: schedule.payload.creatorSlackUserId,
				relatedSlackUserIds: schedule.payload.relatedSlackUserIds ?? [],
				label: schedule.payload.label,
				deliverTo: schedule.payload.deliverTo ?? "origin",
				hasStoredTiming: Boolean(schedule.payload.scheduledWhen),
			}
		},
	})

	return {
		schedule_task,
		list_scheduled_tasks,
		cancel_scheduled_task,
		replace_scheduled_task,
	}
}
