import type { ToolSet } from "ai"
import type { BrainCostLedger } from "../billing/cost"
import { createConfigurationTool } from "../configuration"
import { buildLeaseRuntimeContext } from "../lease/store"
import { createLeaseTools } from "../lease/tools"
import type { LeaseRuntimeContext } from "../lease/types"
import { resolveEntity } from "../memory/entities"
import { formatBrainResults, searchBrain } from "../memory/search-brain"
import { logPreview, redactedPreview } from "../observability/log-utils"
import { createSkillTools } from "../skills/tools"
import {
	checkAskerCanSearchChannel,
	resolveChannel,
	type SlackResponseSurface,
} from "../slack/channel-directory"
import {
	runSlackChannelLookup,
	runSlackChannelsSearch,
	type SlackLookupContext,
} from "../slack/channel-lookup"
import type { SlackMember } from "../slack/client"
import { isThreadTurnCurrent } from "../slack/turn-control"
import type { SlackOrg } from "../slack/workspace"
import { formatSlackOrgMemberDenial } from "../slack/workspace"
import { createForgetMemoriesTool } from "../tools/forget-memories"
import { isMcpCatalogSlug } from "../tools/mcp/catalog"
import { connectModeFor, getDirectoryEntryBySlug } from "../tools/mcp/directory"
import { createMcpDirectoryTool } from "../tools/mcp/directory-tool"
import {
	type ConnectedAppRuntimeController,
	connectedAppRuntimeAvailable,
	createConnectedAppRuntimeTools,
} from "../tools/mcp/execute"
import {
	createMcpRuntimeTools,
	type McpRuntimeServerState,
	type McpRuntimeTools,
} from "../tools/mcp/runtime-tools"
import { listConnectionsForActor } from "../tools/mcp/store"
import { sandboxToolsConfigured } from "../tools/sandbox/daytona-client"
import { createSandboxTools } from "../tools/sandbox/tools"
import { createSchedulerTools } from "../tools/scheduler"
import { createSendToTools } from "../tools/send-to"
import type { TurnActor } from "./actor"
import type { CompanyBrainAgent } from "./agent"
import { createCaptureTools, type TurnCapture } from "./capture-tools"
import type { RuntimeConnectedApp } from "./context"
import { buildAppCapabilitySnapshot } from "./context-state"
import { createContextDiscoveryTools } from "./context-tools"
import type { TurnDeps } from "./deps"
import {
	createLazyToolState,
	LAZY_TOOL_FAMILIES,
	type LazyToolFamily,
	type LazyToolState,
} from "./lazy-tools"
import { resolveBrainTriageProfile } from "./model-profile"
import { createProgressTools } from "./progress-tools"
import type { TurnState } from "./state"
import { createFinishTurnTool, FINISH_TURN_TOOL_NAME } from "./terminal"
import type {
	ComputeTurnOptions,
	ComputeTurnResult,
	TurnProgress,
	TurnThreadHistory,
} from "./types"

export type AssembleTurnToolsArgs = {
	deps: TurnDeps
	env: Env
	agent: CompanyBrainAgent
	org: SlackOrg
	userId: string
	actor: TurnActor
	directory?: SlackMember[]
	threadHistory?: TurnThreadHistory
	slackLookup?: SlackLookupContext
	askerSlackUserId?: string
	mentionedSlackUserIds?: string[]
	askerIsRestricted?: boolean
	scheduledRun?: boolean
	options?: ComputeTurnOptions
	/** Live progress sink; enables the deliberate post_update narration tool. */
	progress?: TurnProgress
	traceId: string
	capture: TurnCapture
	turnState?: TurnState
	initialEnabledFamilies?: LazyToolFamily[]
	/** Test seam only; production uses createMcpRuntimeTools. */
	mcpRuntimeFactory?: typeof createMcpRuntimeTools
	/** Test seam only; production reads the actor's persisted connections. */
	connectionLister?: typeof listConnectionsForActor
	onPhaseLatency?: (
		phase: "connect" | "discover" | "sandbox" | "model",
		latencyMs: number,
	) => void
	/** Parent turn ledger; secondary LLM calls (web search, classifiers) append here. */
	costLedger?: BrainCostLedger
}

export type SerializedSlackLookup = Omit<
	SlackLookupContext,
	"botToken" | "userNames"
> & {
	userNames?: Array<[string, string]>
}

export type TurnToolAssemblySnapshot = {
	directory?: SlackMember[]
	threadHistory?: TurnThreadHistory
	slackLookup?: SerializedSlackLookup
	askerSlackUserId?: string
	mentionedSlackUserIds?: string[]
	askerIsRestricted?: boolean
	scheduledRun?: boolean
	enabledFamilies: LazyToolFamily[]
}

export function snapshotTurnToolAssembly(
	args: Pick<
		AssembleTurnToolsArgs,
		| "directory"
		| "threadHistory"
		| "slackLookup"
		| "askerSlackUserId"
		| "mentionedSlackUserIds"
		| "askerIsRestricted"
		| "scheduledRun"
	>,
	enabledFamilies: LazyToolFamily[],
): TurnToolAssemblySnapshot {
	const { slackLookup } = args
	return {
		directory: args.directory?.map((member) => ({ ...member })),
		threadHistory: args.threadHistory
			? {
					...args.threadHistory,
					messages: args.threadHistory.messages.map((message) => ({
						...message,
					})),
					botUserIds: args.threadHistory.botUserIds
						? [...args.threadHistory.botUserIds]
						: undefined,
				}
			: undefined,
		slackLookup: slackLookup
			? {
					channel: slackLookup.channel,
					threadTs: slackLookup.threadTs,
					teamId: slackLookup.teamId,
					memoryScope: slackLookup.memoryScope,
					// Cloned, and undefined stays undefined: an empty array means
					// "read nothing" and must survive an approval resume as such.
					memoryContainerTags: slackLookup.memoryContainerTags
						? [...slackLookup.memoryContainerTags]
						: undefined,
					tzOffsetSeconds: slackLookup.tzOffsetSeconds,
					userNames: slackLookup.userNames
						? [...slackLookup.userNames.entries()]
						: undefined,
				}
			: undefined,
		askerSlackUserId: args.askerSlackUserId,
		mentionedSlackUserIds: args.mentionedSlackUserIds
			? [...args.mentionedSlackUserIds]
			: undefined,
		askerIsRestricted: args.askerIsRestricted,
		scheduledRun: args.scheduledRun,
		enabledFamilies: [...enabledFamilies],
	}
}

export function restoreTurnToolAssembly(
	snapshot: TurnToolAssemblySnapshot,
	botToken?: string,
): Pick<
	AssembleTurnToolsArgs,
	| "directory"
	| "threadHistory"
	| "slackLookup"
	| "askerSlackUserId"
	| "mentionedSlackUserIds"
	| "askerIsRestricted"
	| "scheduledRun"
	| "initialEnabledFamilies"
> {
	return {
		directory: snapshot.directory?.map((member) => ({ ...member })),
		threadHistory: snapshot.threadHistory
			? {
					...snapshot.threadHistory,
					messages: snapshot.threadHistory.messages.map((message) => ({
						...message,
					})),
					botUserIds: snapshot.threadHistory.botUserIds
						? [...snapshot.threadHistory.botUserIds]
						: undefined,
				}
			: undefined,
		slackLookup:
			snapshot.slackLookup && botToken
				? {
						...snapshot.slackLookup,
						botToken,
						userNames: snapshot.slackLookup.userNames
							? new Map(snapshot.slackLookup.userNames)
							: undefined,
					}
				: undefined,
		askerSlackUserId: snapshot.askerSlackUserId,
		mentionedSlackUserIds: snapshot.mentionedSlackUserIds
			? [...snapshot.mentionedSlackUserIds]
			: undefined,
		askerIsRestricted: snapshot.askerIsRestricted,
		scheduledRun: snapshot.scheduledRun,
		initialEnabledFamilies: [...snapshot.enabledFamilies],
	}
}

export type AssembleTurnToolsResult =
	| {
			ready: true
			tools: ToolSet
			hasApps: boolean
			connectedAppRouting: "code" | "direct" | "none"
			toolDiscovery: LazyToolState
			connectedApps: RuntimeConnectedApp[]
			mcpClose?: () => Promise<void>
			connectedAppRuntime?: ConnectedAppRuntimeController
	  }
	| { ready: false; result: ComputeTurnResult }

export async function assembleTurnTools(
	args: AssembleTurnToolsArgs,
): Promise<AssembleTurnToolsResult> {
	const {
		deps,
		env,
		agent,
		org,
		userId,
		actor,
		directory = [],
		threadHistory,
		slackLookup,
		askerSlackUserId,
		mentionedSlackUserIds,
		askerIsRestricted,
		scheduledRun,
		traceId,
		capture,
	} = args
	const passiveInvestigation = Boolean(args.options?.passiveInvestigation)
	const requestText = args.options?.turnSteering ?? args.turnState?.request.text
	const slackResponseSurface: SlackResponseSurface =
		slackLookup?.memoryScope?.kind === "dm"
			? "dm"
			: slackLookup?.memoryScope?.kind === "private_channel"
				? "private_channel"
				: "public_channel"
	const assembleStartedAt = Date.now()
	console.log(
		`[company-brain][${traceId}] assembleTurnTools start actorUser=${actor.userId ?? "-"} personalOnly=${actor.personalConnectionsOnly ? "yes" : "no"} scheduled=${scheduledRun ? "yes" : "no"} slackLookup=${slackLookup ? "yes" : "no"} memoryScope=${slackLookup?.memoryScope?.kind ?? "none"}`,
	)
	if (slackLookup && actor.memberLookup !== "found") {
		console.warn(
			`[company-brain][${traceId}] refusing Slack turn for non-member org=${org.id} actorUser=${actor.userId ?? "-"} lookup=${actor.memberLookup ?? "unknown"}`,
		)
		return {
			ready: false,
			result: {
				status: "completed",
				reply: formatSlackOrgMemberDenial({ orgName: org.name }),
				memory: null,
				connect: null,
			},
		}
	}
	const brainTool = deps.tool({
		description:
			"Search the company brain: this workspace's durable internal memory (decisions, architecture, meetings, projects, customers, people, docs, prior discussion, how things work here). Use for substantive internal/company questions and after resolving vague Slack references. Do not use as a ritual for explicit live-app actions where the app is the source of truth.",
		inputSchema: deps.z.object({
			query: deps.z
				.string()
				.describe(
					"A clear natural-language question or specific search statement for the company brain. Include the resolved subject, time window, and evidence type when known. Avoid keyword fragments like 'Sreeram work recent'; prefer 'What has Sreeram worked on in the past few days?'. Resolve pronouns like it/that/him from thread or Slack context before searching when needed.",
				),
			focus_tags: deps.z
				.array(deps.z.string())
				.optional()
				.describe(
					"Optional canonical tag keys to scope the search to memories carrying ANY of them, e.g. person_u12345 (from inspect_people_directory), topic_billing, project_atlas, customer_acme, team_growth. Use for a specific fact about a known person, project, or topic; omit to search the whole brain.",
				),
		}),
		execute: async ({ query, focus_tags }) => {
			const t = Date.now()
			console.log(
				`[company-brain][${traceId}] search_company_brain start query="${logPreview(query)}"`,
			)
			const brain = await searchBrain(
				agent,
				org,
				userId,
				query,
				slackLookup?.memoryScope,
				traceId,
				focus_tags,
				slackLookup?.memoryContainerTags,
			)
			const formatted = formatBrainResults(brain.results, {
				filterByScore: true,
				limit: 40,
			})
			console.log(
				`[company-brain][${traceId}] search_company_brain finish ms=${Date.now() - t} total=${brain.total}`,
			)
			console.log(
				`[company-brain][${traceId}] search_company_brain result=${redactedPreview(formatted, 5000)}`,
			)
			return formatted
		},
	})
	const resolveEntityTool = deps.tool({
		description:
			"Resolve a named person or company to canonical identifiers such as its official name, website domain, aliases, and contacts before an app lookup or action. Use it whenever a request names an external company or customer, so downstream apps receive a canonical domain or identifier instead of a display name.",
		inputSchema: deps.z.object({
			reference: deps.z
				.string()
				.describe(
					"The name or reference to resolve, e.g. 'Vela' or 'Vela AI'.",
				),
		}),
		execute: async ({ reference }) => {
			const t = Date.now()
			const resolved = await resolveEntity(
				env,
				org,
				userId,
				reference,
				agent,
				args.costLedger,
				// A read-only turn resolves without caching the result as a memory.
				!actor.readOnly,
			)
			console.log(
				`[company-brain][${traceId}] resolve_entity ref="${logPreview(reference)}" ms=${Date.now() - t} ${resolved ? `canonical="${resolved.canonical}" domain=${resolved.domain ?? "-"} source=${resolved.source}` : "unresolved"}`,
			)
			return resolved ?? { unresolved: true, reference }
		},
	})
	const webSearchTool = deps.createBrainWebSearchTool(
		env,
		traceId,
		args.costLedger,
	)
	const webExtractTool = deps.createBrainWebExtractTool(
		env,
		traceId,
		args.costLedger,
	)
	if (!webSearchTool) {
		console.warn(
			`[company-brain][${traceId}] search_web unavailable reason=missing_context_dev_api_key`,
		)
	}
	const tools: ToolSet = {
		search_company_brain: brainTool,
		resolve_entity: resolveEntityTool,
		// Passive investigations use their private no-reply sentinel. Interactive
		// turns propose their terminal answer explicitly; publication stays runtime-owned.
		...(passiveInvestigation
			? {}
			: { [FINISH_TURN_TOOL_NAME]: createFinishTurnTool(deps) }),
		// Passive background investigations never narrate to the thread.
		...(passiveInvestigation
			? {}
			: createProgressTools(deps, args.progress, traceId, args.turnState)),
		...createCaptureTools(deps, capture, traceId, {
			allowWrites: !passiveInvestigation,
			env,
		}),
		// Destructive bulk forget: interactive turns only, apply gated by approval.
		...(passiveInvestigation || scheduledRun
			? {}
			: {
					forget_memories: createForgetMemoriesTool({
						deps,
						env,
						org,
						slackLookup,
						traceId,
					}),
				}),
		// Read-only and connection-independent, so every actor gets it.
		...createMcpDirectoryTool({ deps, traceId }),
		...createConfigurationTool({
			deps,
			env,
			agent,
			orgId: org.id,
			orgMetadata: org.metadata,
			actor,
			askerSlackUserId: args.askerSlackUserId,
			traceId,
			// Config writes need a human asking for them, like every other write.
			allowWrites: !passiveInvestigation && !scheduledRun && !actor.readOnly,
		}),
	}
	Object.assign(
		tools,
		createSkillTools(
			agent,
			deps,
			{
				org,
				userId: actor.userId,
				isAdmin: Boolean(actor.isAdmin),
				channelId: slackLookup?.channel,
				teamId: slackLookup?.teamId,
				threadTs: slackLookup?.threadTs,
				botToken: slackLookup?.botToken,
				creatorSlackUserId: askerSlackUserId,
				allowSave:
					Boolean(actor.userId) && !passiveInvestigation && !actor.readOnly,
				turnState: args.turnState,
			},
			traceId,
		),
	)
	const ownAppRuntimeStatus = new Map<
		string,
		McpRuntimeServerState["runtimeStatus"]
	>()
	let mcpSetupFailed = false
	if (webSearchTool) tools.search_web = webSearchTool
	if (webExtractTool) tools.web_extract = webExtractTool
	const sandboxTools = sandboxToolsConfigured(env)
		? createSandboxTools({
				env,
				agent,
				deps,
				scope: {
					orgId: org.id,
					userId: actor.userId,
					channel: slackLookup?.channel,
					threadTs: slackLookup?.threadTs,
					// Threadless turns would otherwise share one session row.
					turnId: traceId,
				},
				...(slackLookup && !scheduledRun && !passiveInvestigation
					? {
							slackArtifactDestination: {
								botToken: slackLookup.botToken,
								channel: slackLookup.channel,
								threadTs: slackLookup.threadTs,
								signal: args.options?.abortSignal,
								canShare: () =>
									!args.options?.abortSignal?.aborted &&
									isThreadTurnCurrent(agent, args.options?.turnControl),
							},
						}
					: {}),
				traceId,
			})
		: {}
	Object.assign(tools, sandboxTools)
	console.log(
		`[company-brain][${traceId}] core tools ready sandboxAvailable=${Object.keys(sandboxTools).length ? "yes" : "no"} names=${Object.keys(tools).join(",")}`,
	)
	const schedulerTools =
		slackLookup?.teamId && !scheduledRun && !passiveInvestigation
			? createSchedulerTools(
					agent,
					deps,
					{
						env,
						botToken: slackLookup.botToken,
						teamId: slackLookup.teamId,
						channel: slackLookup.channel,
						threadTs: slackLookup.threadTs,
						creatorUserId: actor.userId,
						creatorSlackUserId: askerSlackUserId,
						isDirectMessage: slackLookup.channel.startsWith("D"),
						memoryScope: slackLookup.memoryScope,
						isOrgMember: actor.memberLookup === "found",
						askerIsRestricted,
						requestText,
						directMentionSlackUserIds: mentionedSlackUserIds,
						directory,
					},
					traceId,
				)
			: {}
	Object.assign(tools, schedulerTools)
	if (Object.keys(schedulerTools).length) {
		console.log(
			`[company-brain][${traceId}] scheduler tools available channel=${slackLookup?.channel} thread=${slackLookup?.threadTs}`,
		)
	}
	// Admin/owner-only external reachout; every send suspends for approval.
	if (
		actor.isAdmin &&
		slackLookup?.teamId &&
		askerSlackUserId &&
		!scheduledRun &&
		!passiveInvestigation
	) {
		Object.assign(
			tools,
			createSendToTools(
				agent,
				deps,
				{
					env,
					botToken: slackLookup.botToken,
					teamId: slackLookup.teamId,
					orgId: org.id,
					currentChannel: slackLookup.channel,
					initiatorUserId: actor.userId,
					initiatorSlackUserId: askerSlackUserId,
					isOrgMember: actor.memberLookup === "found",
					askerIsRestricted,
				},
				traceId,
			),
		)
		console.log(`[company-brain][${traceId}] send_to available (admin)`)
	}
	if (
		slackLookup?.teamId &&
		slackLookup.threadTs &&
		!slackLookup.channel.startsWith("D") &&
		askerSlackUserId &&
		!scheduledRun &&
		!passiveInvestigation
	) {
		Object.assign(
			tools,
			createLeaseTools(
				agent,
				deps,
				{
					orgId: org.id,
					teamId: slackLookup.teamId,
					channel: slackLookup.channel,
					threadTs: slackLookup.threadTs,
					botToken: slackLookup.botToken,
					lesseeUserId: actor.userId,
					lesseeSlackUserId: askerSlackUserId,
					memberLookup: actor.memberLookup,
					turnControl: args.options?.turnControl,
					requestText,
					offerPersonalConnection: (serverSlug) => {
						// This path ends in an OAuth Connect button, so api-key directory
						// apps must not enter it; they need the setup link instead.
						if (!isMcpCatalogSlug(serverSlug)) {
							const entry = getDirectoryEntryBySlug(serverSlug)
							if (!entry || connectModeFor(entry) !== "oauth") return false
						}
						capture.blockedConnectSlugs?.delete(serverSlug)
						capture.connect = [
							...new Set([...(capture.connect ?? []), serverSlug]),
						]
						return true
					},
					withdrawPersonalConnection: (serverSlug) => {
						capture.blockedConnectSlugs ??= new Set()
						capture.blockedConnectSlugs.add(serverSlug)
						const remaining = (capture.connect ?? []).filter(
							(slug) => slug !== serverSlug,
						)
						capture.connect = remaining.length ? remaining : null
					},
					ownConnectionRuntimeStatus: (serverSlug) =>
						ownAppRuntimeStatus.get(serverSlug) ??
						(mcpSetupFailed ? "temporarily_unavailable" : undefined),
				},
				traceId,
			),
		)
	}
	if (slackLookup) {
		tools.search_slack_channel = deps.tool({
			description:
				"Search messages in one Slack channel, defaulting to the current channel, up to ~90 days back. Supports time-window summaries, related-message searches, likely open-action extraction, and finding previously shared links or files. The bot must be a member of the channel. Do not return content from another private channel in a channel response; private-channel answers must stay in that same private channel or a DM. Slack has no task system, so action status is inferred from message wording.",
			inputSchema: deps.z.object({
				intent: deps.z
					.enum([
						"summarize_window",
						"find_related",
						"extract_open_actions",
						"find_link",
					])
					.describe(
						"summarize_window: recent channel activity in a time window. find_related: messages related to a topic. extract_open_actions: likely open vs done action items inferred from channel text. find_link: locate a URL or file shared earlier (e.g. 'the figma link from ~2 weeks ago') — pair with a wider window.",
					),
				query: deps.z
					.string()
					.optional()
					.describe(
						"Required for find_related; recommended for find_link — the topic, phrasing, or link description to match.",
					),
				window: deps.z
					.enum([
						"today",
						"yesterday",
						"last_24_hours",
						"last_7_days",
						"last_30_days",
						"last_90_days",
					])
					.optional()
					.describe(
						"Time window. Default last_7_days; widen to last_30_days/last_90_days for older items (e.g. a link shared two weeks ago).",
					),
				limit: deps.z
					.number()
					.int()
					.min(1)
					.max(150)
					.optional()
					.describe(
						"Max results to surface (default 80). Scan depth is set by the window, not this.",
					),
				channel: deps.z
					.string()
					.optional()
					.describe(
						"Optional channel name or ID to search instead of the current one (must be a channel the bot is in). Omit for the current channel.",
					),
			}),
			execute: async (args) => {
				const t = Date.now()
				console.log(
					`[company-brain][${traceId}] search_slack_channel intent=${args.intent} window=${args.window ?? "default"} channel=${args.channel ?? "current"} query="${logPreview(args.query ?? "")}"`,
				)
				let lookupCtx = slackLookup
				if (args.channel) {
					const res = await resolveChannel(
						env,
						slackLookup.teamId,
						slackLookup.botToken,
						args.channel,
					)
					if (res.status === "unknown") {
						return "I couldn't find that channel. Check the channel name, or invite me to it with /invite."
					}
					if (res.status === "not_member") {
						return `I'm not a member of #${res.name}. Invite me there with /invite and I'll read it.`
					}
					const hit = res.channel
					const access = await checkAskerCanSearchChannel(
						env,
						slackLookup.teamId,
						slackLookup.botToken,
						hit,
						askerSlackUserId,
						{
							currentChannelId: slackLookup.channel,
							isOrgMember: actor.memberLookup === "found",
							responseSurface: slackResponseSurface,
							askerIsRestricted,
						},
					)
					if (!access.ok) {
						if (
							access.reason === "private_channel_requires_membership" ||
							access.reason === "unknown_asker"
						) {
							return `I can't go through #${hit.name} because you're not a member of it.`
						}
						if (access.reason === "private_channel_non_dm_response") {
							return `I can't answer from #${hit.name} here. DM me and I can answer there.`
						}
						return "I can only search other Slack channels for confirmed org members."
					}
					lookupCtx = { ...slackLookup, channel: hit.id }
				}
				const result = await runSlackChannelLookup(lookupCtx, args)
				console.log(
					`[company-brain][${traceId}] search_slack_channel finish ms=${Date.now() - t} chars=${result.length}`,
				)
				return result
			},
		})
		tools.search_slack_channels = deps.tool({
			description:
				"Search recent messages across multiple Slack channels the bot belongs to, up to ~90 days back. Optionally limit the search to named channels; otherwise the tool selects relevant channels. A private channel is searched only when the requester is also a member and the answer is delivered in that same private channel or a DM. Returns the top matching messages labeled by channel.",
			inputSchema: deps.z.object({
				query: deps.z.string().describe("What to search for across channels."),
				channels: deps.z
					.array(deps.z.string())
					.optional()
					.describe(
						"Optional specific channel names/IDs to search (e.g. ['engineering', '#sales']). Omit to auto-pick the most relevant channels the bot is in.",
					),
				window: deps.z
					.enum([
						"today",
						"yesterday",
						"last_24_hours",
						"last_7_days",
						"last_30_days",
						"last_90_days",
					])
					.optional()
					.describe(
						"Time window. Default last_7_days; widen to last_30_days/last_90_days for older items.",
					),
			}),
			execute: async (args) => {
				const t = Date.now()
				console.log(
					`[company-brain][${traceId}] search_slack_channels query="${logPreview(args.query)}" channels=${args.channels?.join(",") ?? "auto"} window=${args.window ?? "default"}`,
				)
				const result = await runSlackChannelsSearch(
					env,
					slackLookup,
					{
						askerSlackUserId,
						isOrgMember: actor.memberLookup === "found",
						responseSurface: slackResponseSurface,
						askerIsRestricted,
					},
					args,
				)
				console.log(
					`[company-brain][${traceId}] search_slack_channels finish ms=${Date.now() - t} chars=${result.length}`,
				)
				return result
			},
		})
	}
	let leaseCtx: LeaseRuntimeContext | undefined
	if (actor.userId && slackLookup?.teamId && slackLookup.threadTs) {
		leaseCtx = buildLeaseRuntimeContext(agent, {
			orgId: org.id,
			teamId: slackLookup.teamId,
			channel: slackLookup.channel,
			threadTs: slackLookup.threadTs,
			lesseeUserId: actor.userId,
		})
	}
	// Catalog MCP servers connected for this actor; Slack actors see personal only.
	let hasApps = false
	let runtimeAppStates: McpRuntimeServerState[] = []
	let mcpClose: (() => Promise<void>) | undefined
	let connectedAppRouting: "code" | "direct" | "none" = "none"
	const connectionLister = args.connectionLister ?? listConnectionsForActor
	const persistedConnections = await connectionLister(
		env,
		org.id,
		actor.userId,
		{
			personalOnly: actor.personalConnectionsOnly,
			orgSharedOnly: actor.orgSharedOnly,
		},
	).catch((err) => {
		console.warn(
			`[company-brain][${traceId}] connected-app inventory unavailable: ${err instanceof Error ? err.message : String(err)}`,
		)
		return []
	})
	const callbackUrl = `${env.PUBLIC_URL}/brain/mcp-connections/callback`
	let connectedAppRuntime: ConnectedAppRuntimeController | undefined
	if (
		args.turnState &&
		(persistedConnections.some(
			(connection) => connection.status === "active",
		) ||
			(leaseCtx?.leases.length ?? 0) > 0) &&
		connectedAppRuntimeAvailable(agent, env, traceId)
	) {
		const codeModeStartedAt = Date.now()
		try {
			const runtime = await createConnectedAppRuntimeTools({
				deps,
				agent,
				env,
				orgId: org.id,
				actor,
				connections: persistedConnections,
				callbackUrl,
				traceId,
				state: args.turnState,
				leaseCtx,
				triageProfile: resolveBrainTriageProfile(org.metadata),
				costLedger: args.costLedger,
			})
			if (runtime.servers.length > 0) {
				Object.assign(tools, runtime.tools)
				runtimeAppStates = runtime.serverStates
				connectedAppRuntime = runtime.controller
				hasApps = true
				connectedAppRouting = "code"
				for (const state of runtimeAppStates) {
					if (state.accessScope === "personal") {
						ownAppRuntimeStatus.set(state.serverSlug, state.runtimeStatus)
					}
				}
				console.log(
					`[company-brain][${traceId}] connected-app Code Mode ready servers=${runtime.servers.join(",")} tools=${Object.keys(runtime.tools).length} ms=${Date.now() - codeModeStartedAt}`,
				)
			}
		} catch (error) {
			console.warn(
				`[company-brain][${traceId}] connected-app Code Mode unavailable; using direct MCP fallback: ${error instanceof Error ? error.message : String(error)}`,
			)
		} finally {
			args.onPhaseLatency?.("connect", Date.now() - codeModeStartedAt)
		}
	}

	if (!hasApps) {
		const mcpStartedAt = Date.now()
		try {
			console.log(
				`[company-brain][${traceId}] direct MCP fallback setup start callbackUrl=${callbackUrl}`,
			)
			const mcpRuntimeFactory = args.mcpRuntimeFactory ?? createMcpRuntimeTools
			const mcp: McpRuntimeTools = await mcpRuntimeFactory(
				env,
				actor,
				callbackUrl,
				traceId,
				leaseCtx,
			)
			// Capture close immediately so a throw below never leaks open transports.
			mcpClose = mcp.close
			runtimeAppStates = mcp.serverStates
			for (const state of runtimeAppStates) {
				if (state.accessScope === "personal") {
					ownAppRuntimeStatus.set(state.serverSlug, state.runtimeStatus)
				}
			}
			if (mcp.servers.length > 0) {
				Object.assign(tools, mcp.tools)
				hasApps = true
				connectedAppRouting = "direct"
				console.log(
					`[company-brain][${traceId}] direct MCP fallback ready servers=${mcp.servers.join(",")} tools=${Object.keys(mcp.tools).length} ms=${Date.now() - mcpStartedAt}`,
				)
			} else {
				await mcp.close()
				mcpClose = undefined
				console.log(
					`[company-brain][${traceId}] direct MCP fallback no_active_servers ms=${Date.now() - mcpStartedAt}`,
				)
			}
		} catch (err) {
			mcpSetupFailed = true
			await mcpClose?.().catch(() => {})
			mcpClose = undefined
			console.warn(
				`[company-brain][${traceId}] direct MCP fallback unavailable: ${err instanceof Error ? err.message : String(err)}`,
			)
		} finally {
			args.onPhaseLatency?.("connect", Date.now() - mcpStartedAt)
		}
	}
	const capabilitySnapshot = buildAppCapabilitySnapshot({
		persistedConnections,
		runtimeStates: runtimeAppStates,
	})
	const temporaryModes = new Map(
		(leaseCtx?.leases ?? []).map((lease) => [lease.serverSlug, lease.mode]),
	)
	const connectedApps: RuntimeConnectedApp[] = []
	for (const app of capabilitySnapshot.apps) {
		if (!app.configured && app.runtimeStatus === "not_attempted") continue
		const access: RuntimeConnectedApp["access"] =
			actor.readOnly || app.accessScope === "organization"
				? "read"
				: app.accessScope === "temporary" &&
						temporaryModes.get(app.slug) !== "read_write"
					? "read"
					: "read_write"
		connectedApps.push({
			slug: app.slug,
			label: app.name,
			access,
			health: app.state,
		})
	}
	Object.assign(
		tools,
		createContextDiscoveryTools({
			deps,
			env,
			agent,
			orgId: org.id,
			directory,
			threadHistory,
			slackLookup,
			askerSlackUserId,
			mentionedSlackUserIds,
			memoryScope: slackLookup?.memoryScope,
			memoryContainerTags: slackLookup?.memoryContainerTags,
			traceId,
		}),
	)
	const toolDiscovery = createLazyToolState(
		{
			sandbox: Object.keys(sandboxTools),
			scheduler: Object.keys(schedulerTools),
		},
		args.initialEnabledFamilies,
	)
	tools.enable_tool_family = deps.tool({
		description:
			"Enable optional tool families when the task needs them. `sandbox` adds an isolated workspace for repository, code, command, file, data, PDF, and artifact work. `scheduler` adds reminders, delayed runs, recurring tasks, and schedule management. The requested tools become available on the next step; continue the task then.",
		inputSchema: deps.z.object({
			families: deps.z
				.array(deps.z.enum(LAZY_TOOL_FAMILIES))
				.min(1)
				.max(LAZY_TOOL_FAMILIES.length),
		}),
		execute: async ({ families }) => {
			const result = toolDiscovery.unlock(families)
			console.log(
				`[company-brain][${traceId}] enable_tool_family requested=${families.join(",")} enabled=${toolDiscovery.enabledFamilies().join(",") || "-"}`,
			)
			return {
				families: result,
				instruction:
					"Continue the task now. The enabled typed tools will be visible on the next model step.",
			}
		},
	})
	const activeToolNames = toolDiscovery.activeToolNames(Object.keys(tools))
	console.log(
		`[company-brain][${traceId}] assembleTurnTools finish hasApps=${hasApps ? "yes" : "no"} activeToolCount=${activeToolNames.length} hiddenToolCount=${Object.keys(tools).length - activeToolNames.length} activeTools=${activeToolNames.join(",")} lazyFamilies=${toolDiscovery.availableFamilies().join(",") || "-"} ms=${Date.now() - assembleStartedAt}`,
	)

	return {
		ready: true,
		tools,
		hasApps,
		connectedAppRouting,
		toolDiscovery,
		connectedApps,
		mcpClose,
		connectedAppRuntime,
	}
}
