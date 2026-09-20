import { generateId } from "@repo/lib/generate-id"
import type { ToolSet } from "ai"
import { captureLeaseRequest } from "@/lib/posthog"
import { retireSlackMcpConnectPrompt } from "../slack/mcp-connect"
import type { TurnControlSnapshot } from "../slack/turn-control"
import { requesterLacksPersonalAppAccess } from "../tools/mcp/access-intent"
import { getCatalogEntry, isMcpServerLeaseable } from "../tools/mcp/catalog"
import { getDirectoryEntryBySlug } from "../tools/mcp/directory"
import { getConnection } from "../tools/mcp/store"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import type { TurnDeps } from "../turn/deps"
import { describeRequestCapabilities, serverDisplayName } from "./capabilities"
import { resolveLeaseOwners, resolveReachableLeaseOwners } from "./policy"
import { armLeaseRequestExpiry, routeLeaseRequestToOwners } from "./routing"
import {
	hasOpenLeaseForServer,
	insertLeaseRequest,
	markLeaseRequestTerminalIfPending,
} from "./store"
import {
	LEASE_REQUEST_EXPIRY_MS,
	type LeaseMode,
	type LeaseRequest,
	MAX_LEASE_OWNER_FANOUT,
} from "./types"

export type LeaseToolContext = {
	orgId: string
	teamId: string
	channel: string
	threadTs: string
	botToken: string
	lesseeUserId?: string
	lesseeSlackUserId?: string
	memberLookup?: "found" | "no_slack_email" | "not_in_org"
	turnControl?: TurnControlSnapshot
	requestText?: string
	offerPersonalConnection?: (serverSlug: string) => boolean
	withdrawPersonalConnection?: (serverSlug: string) => void
	ownConnectionRuntimeStatus?: (
		serverSlug: string,
	) => "ready" | "temporarily_unavailable" | "reconnect_required" | undefined
}

export type RequestAccessLeaseArgs = {
	server: string
	reason: string
	needsWrite?: boolean
}

export type RequestAccessLeaseResult = {
	status:
		| "requested"
		| "unavailable"
		| "unknown_server"
		| "already_connected"
		| "connection_unavailable"
		| "connect_required"
		| "connection_pending"
		| "reconnect_required"
		| "already_requested"
		| "non_leaseable"
		| "no_lender"
		| "dm_failed"
	server?: string
	ownerMentions?: string[]
	ownersFound?: number
	fanoutCount?: number
	capped?: boolean
	message: string
}

function mentionList(mentions: string[]): string {
	if (mentions.length <= 1) return mentions[0] ?? ""
	if (mentions.length === 2) return `${mentions[0]} and ${mentions[1]}`
	return `${mentions.slice(0, -1).join(", ")}, and ${mentions.at(-1)}`
}

function leaseOwnerRequestMessage(ownerMentions: string[]): string {
	return `I've sent an access request to ${mentionList(ownerMentions)}.`
}

async function captureTerminalLeaseRequest(args: {
	ctx: LeaseToolContext
	serverSlug: string
	ownersFound: number
	fanoutCount: number
	capped: boolean
	outcome: "none" | "non_leaseable"
	startedAt: number
}): Promise<void> {
	await captureLeaseRequest({
		distinctId:
			args.ctx.lesseeUserId ?? args.ctx.lesseeSlackUserId ?? "unknown",
		orgId: args.ctx.orgId,
		serverSlug: args.serverSlug,
		ownersFound: args.ownersFound,
		fanoutCount: args.fanoutCount,
		capped: args.capped,
		outcome: args.outcome,
		timeToDecisionMs: Date.now() - args.startedAt,
	})
}

export async function requestAccessLease(
	agent: CompanyBrainAgent,
	ctx: LeaseToolContext,
	args: RequestAccessLeaseArgs,
	traceId: string,
): Promise<RequestAccessLeaseResult> {
	const startedAt = Date.now()
	const env = brainAgent(agent).env
	const serverSlug = args.server.trim().toLowerCase()
	const serverName = serverDisplayName(serverSlug)
	const mode: LeaseMode = args.needsWrite ? "read_write" : "read_only"
	const lacksPersonalAccess = requesterLacksPersonalAppAccess(ctx.requestText)

	if (ctx.channel.startsWith("D")) {
		return {
			status: "unavailable",
			message:
				"Temporary app access can only be requested from a Slack channel, not a DM.",
		}
	}
	if (ctx.memberLookup !== "found" || !ctx.lesseeUserId) {
		return {
			status: "unavailable",
			message:
				"Temporary access is only available to verified workspace members. Ask an admin to add you to the org, then try again.",
		}
	}
	if (!ctx.lesseeSlackUserId) {
		return {
			status: "unavailable",
			message:
				"I couldn't identify the asker's Slack account to arrange access.",
		}
	}
	const own = await getConnection(env, ctx.orgId, serverSlug, ctx.lesseeUserId)
	if (own?.status === "active") {
		const runtimeStatus = ctx.ownConnectionRuntimeStatus?.(serverSlug)
		if (runtimeStatus === "reconnect_required") {
			if (!lacksPersonalAccess) {
				const offered = ctx.offerPersonalConnection?.(serverSlug) ?? false
				return {
					status: "reconnect_required",
					server: serverName,
					message: offered
						? `Your ${serverName} connection needs to be reauthorized before I can use it. Ask the requester to use the private reconnect button first; request temporary access only if they say they cannot use their own ${serverName} account.`
						: `Your ${serverName} connection needs to be reauthorized before I can use it. Ask the requester to reconnect their own account first; request temporary access only if they say they cannot use that account.`,
				}
			}
		}
		if (runtimeStatus === "temporarily_unavailable") {
			return {
				status: "connection_unavailable",
				message: `Your ${serverName} connection is configured, but it was temporarily unavailable during this request. No reconnect or additional access request is needed; try the live lookup again later.`,
			}
		}
		if (runtimeStatus !== "reconnect_required") {
			return {
				status: "already_connected",
				message: `You already have ${serverName} connected — no temporary access needed.`,
			}
		}
	}
	if (own?.status === "error") {
		if (!lacksPersonalAccess) {
			const offered = ctx.offerPersonalConnection?.(serverSlug) ?? false
			return {
				status: "reconnect_required",
				server: serverName,
				message: offered
					? `Your ${serverName} connection needs to be reauthorized before I can use it. Ask the requester to use the private reconnect button first; request temporary access only if they say they cannot use their own ${serverName} account.`
					: `Your ${serverName} connection needs to be reauthorized before I can use it. Ask the requester to reconnect their own account first; request temporary access only if they say they cannot use that account.`,
			}
		}
	}
	if (own?.status === "pending") {
		if (!lacksPersonalAccess) {
			return {
				status: "connection_pending",
				message: `Your ${serverName} connection is still pending authorization. Finish that connection before trying again; request temporary access only if you cannot use your own ${serverName} account.`,
			}
		}
	}
	// Directory apps are self-connectable too, so they take the connect-first
	// path rather than falling through to borrowing a teammate's access.
	const selfConnectable =
		!!getCatalogEntry(serverSlug) || !!getDirectoryEntryBySlug(serverSlug)
	if (selfConnectable && !lacksPersonalAccess) {
		const offered = ctx.offerPersonalConnection?.(serverSlug) ?? false
		return {
			status: "connect_required",
			server: serverName,
			message: offered
				? `A missing ${serverName} MCP connection does not mean the requester lacks ${serverName} access. Ask them to try the private Connect ${serverName} button first. Request temporary access only if they explicitly say they cannot use their own ${serverName} account.`
				: `A missing ${serverName} MCP connection does not mean the requester lacks ${serverName} access. ${serverName} needs their own API key, so call connect_app for it and share the setup link it returns. Request temporary access only if they explicitly say they cannot use their own account.`,
		}
	}

	ctx.withdrawPersonalConnection?.(serverSlug)
	try {
		const retired = await retireSlackMcpConnectPrompt({
			env,
			orgId: ctx.orgId,
			userId: ctx.lesseeUserId,
			teamId: ctx.teamId,
			channel: ctx.channel,
			threadTs: ctx.threadTs,
			slackUserId: ctx.lesseeSlackUserId,
			slug: serverSlug,
		})
		if (retired.invalidated > 0) {
			console.log(
				`[company-brain][${traceId}] retired personal connect offer server=${serverSlug} states=${retired.invalidated} cards=${retired.updatedCards}`,
			)
		}
	} catch (error) {
		console.warn(
			`[company-brain][${traceId}] could not retire personal connect offer server=${serverSlug}:`,
			error,
		)
	}
	if (!isMcpServerLeaseable(serverSlug)) {
		await captureTerminalLeaseRequest({
			ctx,
			serverSlug,
			ownersFound: 0,
			fanoutCount: 0,
			capped: false,
			outcome: "non_leaseable",
			startedAt,
		})
		return {
			status: "non_leaseable",
			server: serverName,
			ownersFound: 0,
			fanoutCount: 0,
			capped: false,
			message: `${serverName} connections are personal and can't be borrowed.`,
		}
	}
	if (
		hasOpenLeaseForServer(
			agent,
			ctx.orgId,
			ctx.teamId,
			ctx.channel,
			ctx.lesseeUserId,
			serverSlug,
			ctx.threadTs,
			mode,
		)
	) {
		return {
			status: "already_requested",
			message: `There's already a pending or active access request for ${serverName} in this thread.`,
		}
	}

	const candidates = await resolveLeaseOwners(
		env,
		ctx.orgId,
		serverSlug,
		ctx.lesseeUserId,
	)
	const ownersFound = candidates.length
	if (ownersFound === 0) {
		await captureTerminalLeaseRequest({
			ctx,
			serverSlug,
			ownersFound,
			fanoutCount: 0,
			capped: false,
			outcome: "none",
			startedAt,
		})
		return {
			status: "no_lender",
			server: serverName,
			ownersFound,
			fanoutCount: 0,
			capped: false,
			message: `Nobody in this Company Brain organization has an active personal ${serverName} MCP connection.`,
		}
	}

	const reachableOwners = await resolveReachableLeaseOwners(
		ctx.botToken,
		candidates,
	)
	const capped = reachableOwners.length > MAX_LEASE_OWNER_FANOUT
	const candidateOwners = reachableOwners.slice(0, MAX_LEASE_OWNER_FANOUT)
	if (candidateOwners.length === 0) {
		await captureTerminalLeaseRequest({
			ctx,
			serverSlug,
			ownersFound,
			fanoutCount: 0,
			capped,
			outcome: "none",
			startedAt,
		})
		return {
			status: "no_lender",
			server: serverName,
			ownersFound,
			fanoutCount: 0,
			capped,
			message: `I found active personal ${serverName} connections, but couldn't reach any of their owners in Slack.`,
		}
	}

	const now = Date.now()
	const request: LeaseRequest = {
		requestId: generateId(),
		orgId: ctx.orgId,
		teamId: ctx.teamId,
		channel: ctx.channel,
		threadTs: ctx.threadTs,
		lesseeUserId: ctx.lesseeUserId,
		lesseeSlackUser: ctx.lesseeSlackUserId,
		serverSlug,
		mode,
		reason: args.reason.trim(),
		capabilitySummary: describeRequestCapabilities(serverSlug, mode),
		candidateOwners,
		ownersFound,
		fanoutCapped: capped,
		cardDeliveries: [],
		status: "pending",
		createdAt: now,
		expiresAt: now + LEASE_REQUEST_EXPIRY_MS,
		turnControl: ctx.turnControl
			? {
					threadKey: ctx.turnControl.threadKey,
					turnId: ctx.turnControl.turnId,
					revision: ctx.turnControl.revision,
				}
			: undefined,
	}
	insertLeaseRequest(agent, request)
	try {
		await armLeaseRequestExpiry(agent, request)
	} catch (error) {
		markLeaseRequestTerminalIfPending(agent, request.requestId, "error")
		console.warn(
			`[company-brain][${traceId}] could not schedule lease request expiry:`,
			error,
		)
		await captureTerminalLeaseRequest({
			ctx,
			serverSlug,
			ownersFound,
			fanoutCount: 0,
			capped,
			outcome: "none",
			startedAt,
		})
		return {
			status: "dm_failed",
			server: serverName,
			ownersFound,
			fanoutCount: 0,
			capped,
			message: `I couldn't safely time-box a ${serverName} access request, so I didn't send one.`,
		}
	}

	const routed = await routeLeaseRequestToOwners(agent, ctx.botToken, request)
	if (routed.status !== "routed") {
		markLeaseRequestTerminalIfPending(agent, request.requestId, "error")
		await captureTerminalLeaseRequest({
			ctx,
			serverSlug,
			ownersFound,
			fanoutCount: 0,
			capped,
			outcome: "none",
			startedAt,
		})
		return {
			status: "dm_failed",
			server: serverName,
			ownersFound,
			fanoutCount: 0,
			capped,
			message: `I found ${serverName} connection owners, but couldn't deliver an access request to any of them.`,
		}
	}

	const ownerMentions = routed.deliveries.flatMap((delivery) => {
		const slackUserId = candidateOwners[delivery.ownerIndex]?.slackUserId
		return slackUserId ? [`<@${slackUserId}>`] : []
	})
	console.log(
		`[company-brain][${traceId}] lease request ${request.requestId} server=${serverSlug} owners=${routed.deliveries.length}/${ownersFound} capped=${capped}`,
	)
	return {
		status: "requested",
		server: serverName,
		ownerMentions,
		ownersFound,
		fanoutCount: routed.deliveries.length,
		capped,
		message: leaseOwnerRequestMessage(ownerMentions),
	}
}

export function createLeaseTools(
	agent: CompanyBrainAgent,
	deps: TurnDeps,
	ctx: LeaseToolContext,
	traceId: string,
): ToolSet {
	const request_access_lease = deps.tool({
		description:
			"Request connection-owner consent for an app/server needed by the asker's task. For a catalog app, this is a fallback ONLY after the requester explicitly says they lack underlying app access, permission, or an account; a missing MCP connection alone must try the requester's private Connect button first. Custom servers without a self-connect button may use this directly. The system tags up to five active personal connection owners on one approval card in the current thread; only those owners can decide it, the first approval grants temporary thread-scoped access, and the task resumes automatically. On success, respond with the returned message verbatim and nothing else; never restate the task, requested scope, approval flow, or ask the user to ping or retry. Set needsWrite=true ONLY when the task actually changes data (create/update/delete/send); otherwise request read-only. Never use this for an app/server the asker can use through their own connection.",
		inputSchema: deps.z.object({
			server: deps.z
				.string()
				.describe(
					"The app/server slug the asker needs but isn't connected to. This may be a built-in catalog slug or a custom MCP slug named by the user or known from app context, e.g. 'posthog', 'linear', 'sentry', 'planetscale'.",
				),
			reason: deps.z
				.string()
				.describe(
					"One sentence on what the asker needs to do with it, e.g. 'pull the last 7 days of signups'. Shown verbatim to each connection owner.",
				),
			needsWrite: deps.z
				.boolean()
				.optional()
				.describe(
					"true ONLY if the task must CHANGE data in the app (create/update/delete/send). Leave false/omitted for read-only queries — each connection owner sees and grants exactly this scope.",
				),
		}),
		execute: async ({ server, reason, needsWrite }) => {
			return requestAccessLease(
				agent,
				ctx,
				{ server, reason, needsWrite },
				traceId,
			)
		},
	})
	return { request_access_lease }
}
