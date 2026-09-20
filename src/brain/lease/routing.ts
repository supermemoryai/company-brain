import {
	deleteSlackMessage,
	type LeaseCardStatus,
	postSlackLeaseCardToThread,
	resolvedLeaseBlocks,
	type SlackLeaseCard,
	updateSlackMessage,
} from "../slack/client"
import { getCachedSlackUserInfo } from "../slack/profile-cache"
import { mcpIconUrlForServer } from "../tools/mcp/catalog"
import { getConnectionById, type McpConnectionRow } from "../tools/mcp/store"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { serverDisplayName } from "./capabilities"
import { isEligibleLeaseOwner } from "./policy"
import { addLeaseRequestCardDeliveries, loadLeaseRequest } from "./store"
import type {
	LeaseCardDelivery,
	LeaseOwnerCandidate,
	LeaseRequest,
} from "./types"

export type LeaseRoutingResult =
	| { status: "routed"; deliveries: LeaseCardDelivery[] }
	| { status: "exhausted" }
	| { status: "stale" }

export function leaseApprovedMessage(
	serverName: string,
	winnerSlackUser: string,
): string {
	return `<@${winnerSlackUser}> approved — using their ${serverName} connection for this thread.`
}

function ownerSlackUsersForRequest(request: LeaseRequest): string[] {
	return [
		...new Set(
			request.cardDeliveries.flatMap((delivery) => {
				const slackUserId =
					request.candidateOwners[delivery.ownerIndex]?.slackUserId
				return slackUserId ? [slackUserId] : []
			}),
		),
	]
}

function cardFromRequest(
	request: LeaseRequest,
	overrides: {
		ownerSlackUsers?: string[]
		askerName?: string
		iconUrl?: string
	} = {},
): SlackLeaseCard {
	return {
		requestId: request.requestId,
		serverSlug: request.serverSlug,
		serverName: serverDisplayName(request.serverSlug),
		askerUser: request.lesseeSlackUser,
		ownerSlackUsers:
			overrides.ownerSlackUsers ?? ownerSlackUsersForRequest(request),
		...(overrides.askerName ? { askerName: overrides.askerName } : {}),
		...(overrides.iconUrl ? { iconUrl: overrides.iconUrl } : {}),
		channel: request.channel,
		reason: request.reason,
		capabilities: request.capabilitySummary,
		expiresAt: request.expiresAt,
	}
}

async function eligibleConnectionForOwner(
	env: Env,
	request: LeaseRequest,
	owner: LeaseOwnerCandidate,
): Promise<McpConnectionRow | undefined> {
	const connection = await getConnectionById(env, owner.connectionId)
	if (
		!connection ||
		connection.id !== owner.connectionId ||
		connection.orgId !== request.orgId ||
		connection.serverSlug !== request.serverSlug ||
		connection.status !== "active" ||
		connection.userId !== owner.userId
	) {
		return undefined
	}
	const eligible = await isEligibleLeaseOwner(
		env,
		request.orgId,
		request.serverSlug,
		owner.userId,
		owner.connectionId,
	)
	return eligible ? connection : undefined
}

export async function armLeaseRequestExpiry(
	agent: CompanyBrainAgent,
	request: Pick<LeaseRequest, "requestId" | "expiresAt">,
): Promise<void> {
	const delaySeconds = Math.max(
		1,
		Math.ceil((request.expiresAt - Date.now()) / 1000),
	)
	await agent.schedule(delaySeconds, "runLeaseEscalation", {
		requestId: request.requestId,
	})
}

async function deleteLateCard(
	botToken: string,
	posted: { channel: string; ts: string },
): Promise<void> {
	await deleteSlackMessage(botToken, posted.channel, posted.ts)
}

export async function routeLeaseRequestToOwners(
	agent: CompanyBrainAgent,
	botToken: string,
	request: LeaseRequest,
): Promise<LeaseRoutingResult> {
	const env = brainAgent(agent).env
	const eligibleOwners = (
		await Promise.all(
			request.candidateOwners.map(async (owner, ownerIndex) => {
				if (!owner.slackUserId) return undefined
				const connection = await eligibleConnectionForOwner(env, request, owner)
				if (!connection) return undefined
				return { owner, ownerIndex, connection }
			}),
		)
	).filter(
		(
			entry,
		): entry is {
			owner: LeaseOwnerCandidate
			ownerIndex: number
			connection: McpConnectionRow
		} => entry !== undefined,
	)
	if (eligibleOwners.length === 0) {
		const latest = loadLeaseRequest(agent, request.requestId)
		return latest?.status === "pending"
			? { status: "exhausted" }
			: { status: "stale" }
	}

	const ownerSlackUsers = eligibleOwners.map(
		({ owner }) => owner.slackUserId as string,
	)
	const askerLookup = await getCachedSlackUserInfo(agent, {
		teamId: request.teamId,
		botToken,
		userId: request.lesseeSlackUser,
	})
	const askerName = askerLookup.ok
		? (askerLookup.user.name ?? askerLookup.user.displayName)
		: undefined
	const iconUrl = mcpIconUrlForServer(
		request.serverSlug,
		eligibleOwners[0]?.connection.serverUrl ?? undefined,
	)
	const posted = await postSlackLeaseCardToThread(
		botToken,
		request.channel,
		request.threadTs,
		cardFromRequest(request, {
			ownerSlackUsers,
			...(askerName ? { askerName } : {}),
			...(iconUrl ? { iconUrl } : {}),
		}),
	)
	if (!posted) return { status: "exhausted" }

	const deliveries: LeaseCardDelivery[] = eligibleOwners.map(
		({ ownerIndex }) => ({
			ownerIndex,
			channel: posted.channel,
			ts: posted.ts,
			status: "pending",
		}),
	)
	if (!addLeaseRequestCardDeliveries(agent, request.requestId, deliveries)) {
		await deleteLateCard(botToken, posted)
		return { status: "stale" }
	}
	// All owner deliveries share one thread card. Delivery entries remain
	// per-owner so button authorization and per-owner declines stay explicit.
	return { status: "routed", deliveries }
}

function deliveryTarget(delivery: LeaseCardDelivery): string {
	return `${delivery.channel}:${delivery.ts}`
}

export async function deleteLeaseCards(
	botToken: string,
	request: LeaseRequest,
	onlyPending = false,
): Promise<boolean> {
	const seenTargets = new Set<string>()
	const deliveries: LeaseCardDelivery[] = []
	for (const delivery of request.cardDeliveries) {
		if (onlyPending && delivery.status !== "pending") continue
		if (!delivery.channel || !delivery.ts) continue
		const target = deliveryTarget(delivery)
		if (seenTargets.has(target)) continue
		seenTargets.add(target)
		deliveries.push(delivery)
	}
	if (deliveries.length === 0) return false
	const deleted = await Promise.all(
		deliveries.map((delivery) =>
			deleteSlackMessage(botToken, delivery.channel, delivery.ts),
		),
	)
	return deleted.every(Boolean)
}

export async function updateLeaseCardsStatus(
	botToken: string,
	request: LeaseRequest,
	status: LeaseCardStatus,
	text: string,
	excludeOwnerIndex?: number,
	onlyPending = false,
): Promise<void> {
	const seenTargets = new Set<string>()
	await Promise.all(
		request.cardDeliveries.map(async (delivery) => {
			if (delivery.ownerIndex === excludeOwnerIndex) return
			if (onlyPending && delivery.status !== "pending") return
			if (!delivery.channel || !delivery.ts) return
			const target = deliveryTarget(delivery)
			if (seenTargets.has(target)) return
			seenTargets.add(target)
			await updateSlackMessage(
				botToken,
				delivery.channel,
				delivery.ts,
				text,
				resolvedLeaseBlocks(cardFromRequest(request), status, undefined, text),
			)
		}),
	)
}
