import type { TurnControlSnapshot } from "../slack/turn-control"
import { isLeaseableMcpSlug } from "../tools/mcp/catalog"
import { getConnectionById } from "../tools/mcp/store"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { isEligibleLeaseOwner, isOrgMember } from "./policy"
import type {
	AccessLease,
	AccessLeaseStatus,
	ActiveLease,
	LeaseCardDelivery,
	LeaseCardDeliveryStatus,
	LeaseMode,
	LeaseOwnerCandidate,
	LeaseRequest,
	LeaseRequestStatus,
	LeaseRuntimeContext,
	LeaseStatus,
} from "./types"

function updateLeaseDeliveryState(
	deliveries: LeaseCardDelivery[],
	ownerIndex: number,
	status: Extract<LeaseCardDeliveryStatus, "declined" | "invalidated">,
):
	| {
			deliveries: LeaseCardDelivery[]
			outcome: "pending" | "all_declined" | "unavailable"
	  }
	| undefined {
	const target = deliveries.find(
		(delivery) => delivery.ownerIndex === ownerIndex,
	)
	if (!target || target.status !== "pending") return undefined
	const next = deliveries.map((delivery) =>
		delivery.ownerIndex === ownerIndex ? { ...delivery, status } : delivery,
	)
	if (next.some((delivery) => delivery.status === "pending")) {
		return { deliveries: next, outcome: "pending" }
	}
	return {
		deliveries: next,
		outcome: next.every((delivery) => delivery.status === "declined")
			? "all_declined"
			: "unavailable",
	}
}

function approveLeaseDeliveryState(
	deliveries: LeaseCardDelivery[],
	ownerIndex: number,
): LeaseCardDelivery[] | undefined {
	const target = deliveries.find(
		(delivery) => delivery.ownerIndex === ownerIndex,
	)
	if (!target || target.status !== "pending") return undefined
	return deliveries.map((delivery) => ({
		...delivery,
		status:
			delivery.ownerIndex === ownerIndex
				? "approved"
				: delivery.status === "pending"
					? "invalidated"
					: delivery.status,
	}))
}

export function ensureLeaseTables(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_lease (
			request_id TEXT PRIMARY KEY,
			lease_id TEXT UNIQUE,
			org_id TEXT NOT NULL,
			team_id TEXT NOT NULL,
			channel TEXT NOT NULL,
			thread_ts TEXT NOT NULL,
			lessee_user_id TEXT NOT NULL,
			lessee_slack_user TEXT NOT NULL,
			server_slug TEXT NOT NULL,
			mode TEXT NOT NULL DEFAULT 'read_only',
			reason TEXT NOT NULL,
			capability_summary TEXT NOT NULL,
			candidate_approvers_json TEXT NOT NULL,
			owners_found INTEGER NOT NULL DEFAULT 0,
			fanout_capped INTEGER NOT NULL DEFAULT 0,
			current_approver_index INTEGER NOT NULL DEFAULT 0,
			card_deliveries_json TEXT NOT NULL DEFAULT '[]',
			card_channel TEXT,
			card_ts TEXT,
			status TEXT NOT NULL,
			lessor_user_id TEXT,
			lessor_connection_id TEXT,
			approved_by_slack TEXT,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			decided_at INTEGER,
			decided_by TEXT,
			revoked_at INTEGER,
			turn_control_json TEXT
		)
	`
	migrateLeaseTables(agent)
}
function migrateLeaseTables(agent: CompanyBrainAgent): void {
	const migrations = [
		() => agent.sql`
			ALTER TABLE brain_lease
			ADD COLUMN owners_found INTEGER NOT NULL DEFAULT 0
		`,
		() => agent.sql`
			ALTER TABLE brain_lease
			ADD COLUMN fanout_capped INTEGER NOT NULL DEFAULT 0
		`,
		() => agent.sql`
			INSERT OR IGNORE INTO brain_lease (
				request_id, lease_id, org_id, team_id, channel, thread_ts,
				lessee_user_id, lessee_slack_user, server_slug, mode, reason,
				capability_summary, candidate_approvers_json, current_approver_index,
				card_deliveries_json, card_channel, card_ts, status,
				created_at, expires_at, decided_at, decided_by, turn_control_json
			)
			SELECT
				request_id, NULL, org_id, team_id, channel, thread_ts,
				lessee_user_id, lessee_slack_user, server_slug, mode, reason,
				capability_summary, candidate_approvers_json, current_approver_index,
				card_deliveries_json, card_channel, card_ts, status,
				created_at, expires_at, decided_at, decided_by, turn_control_json
			FROM brain_lease_request
		`,
		() => agent.sql`
			UPDATE brain_lease
			SET
				lease_id = (
					SELECT lease_id FROM brain_access_lease
					WHERE brain_access_lease.request_id = brain_lease.request_id
				),
				lessor_user_id = (
					SELECT lessor_user_id FROM brain_access_lease
					WHERE brain_access_lease.request_id = brain_lease.request_id
				),
				lessor_connection_id = (
					SELECT lessor_connection_id FROM brain_access_lease
					WHERE brain_access_lease.request_id = brain_lease.request_id
				),
				approved_by_slack = (
					SELECT approved_by_slack FROM brain_access_lease
					WHERE brain_access_lease.request_id = brain_lease.request_id
				),
				status = (
					SELECT status FROM brain_access_lease
					WHERE brain_access_lease.request_id = brain_lease.request_id
				),
				created_at = (
					SELECT created_at FROM brain_access_lease
					WHERE brain_access_lease.request_id = brain_lease.request_id
				),
				expires_at = (
					SELECT expires_at FROM brain_access_lease
					WHERE brain_access_lease.request_id = brain_lease.request_id
				),
				revoked_at = (
					SELECT revoked_at FROM brain_access_lease
					WHERE brain_access_lease.request_id = brain_lease.request_id
				)
			WHERE EXISTS (
				SELECT 1 FROM brain_access_lease
				WHERE brain_access_lease.request_id = brain_lease.request_id
			)
		`,
		() => agent.sql`
			INSERT OR IGNORE INTO brain_lease (
				request_id, lease_id, org_id, team_id, channel, thread_ts,
				lessee_user_id, lessee_slack_user, server_slug, mode, reason,
				capability_summary, candidate_approvers_json, current_approver_index,
				card_deliveries_json, status, lessor_user_id, lessor_connection_id,
				approved_by_slack, created_at, expires_at, revoked_at
			)
			SELECT
				request_id, lease_id, org_id, team_id, channel, thread_ts,
				lessee_user_id, '', server_slug, mode, reason,
				'', '[]', 0, '[]', status, lessor_user_id, lessor_connection_id,
				approved_by_slack, created_at, expires_at, revoked_at
			FROM brain_access_lease
		`,
	]
	for (const run of migrations) {
		try {
			run()
		} catch {}
	}
}

type BrainLeaseRow = {
	request_id: string
	lease_id: string | null
	org_id: string
	team_id: string
	channel: string
	thread_ts: string
	lessee_user_id: string
	lessee_slack_user: string
	server_slug: string
	mode: LeaseMode
	reason: string
	capability_summary: string
	candidate_approvers_json: string
	owners_found: number
	fanout_capped: number
	current_approver_index: number
	card_deliveries_json: string | null
	card_channel: string | null
	card_ts: string | null
	status: LeaseStatus
	lessor_user_id: string | null
	lessor_connection_id: string | null
	approved_by_slack: string | null
	created_at: number
	expires_at: number
	decided_at: number | null
	decided_by: string | null
	revoked_at: number | null
	turn_control_json: string | null
}

function rowToRequest(row: BrainLeaseRow): LeaseRequest | null {
	try {
		const candidateOwners = JSON.parse(
			row.candidate_approvers_json,
		) as LeaseOwnerCandidate[]
		const parsedDeliveries = row.card_deliveries_json
			? (JSON.parse(row.card_deliveries_json) as Array<
					Partial<LeaseCardDelivery> & { approverIndex?: number }
				>)
			: []
		const validStatuses = new Set<LeaseCardDeliveryStatus>([
			"pending",
			"approved",
			"declined",
			"invalidated",
		])
		const cardDeliveries = parsedDeliveries.flatMap((delivery) => {
			const ownerIndex =
				typeof delivery.ownerIndex === "number"
					? delivery.ownerIndex
					: delivery.approverIndex
			if (
				typeof ownerIndex !== "number" ||
				typeof delivery.channel !== "string" ||
				typeof delivery.ts !== "string"
			) {
				return []
			}
			return [
				{
					ownerIndex,
					channel: delivery.channel,
					ts: delivery.ts,
					status:
						delivery.status && validStatuses.has(delivery.status)
							? delivery.status
							: "pending",
				} satisfies LeaseCardDelivery,
			]
		})
		return {
			requestId: row.request_id,
			orgId: row.org_id,
			teamId: row.team_id,
			channel: row.channel,
			threadTs: row.thread_ts,
			lesseeUserId: row.lessee_user_id,
			lesseeSlackUser: row.lessee_slack_user,
			serverSlug: row.server_slug,
			mode: row.mode,
			reason: row.reason,
			capabilitySummary: row.capability_summary,
			candidateOwners,
			ownersFound: row.owners_found || candidateOwners.length,
			fanoutCapped: Boolean(row.fanout_capped),
			cardDeliveries,
			status: row.status as LeaseRequestStatus,
			createdAt: row.created_at,
			expiresAt: row.expires_at,
			decidedAt: row.decided_at ?? undefined,
			decidedBy: row.decided_by ?? undefined,
			turnControl: row.turn_control_json
				? JSON.parse(row.turn_control_json)
				: undefined,
		}
	} catch (err) {
		console.error(
			`[company-brain] lease request ${row.request_id} has unparseable state; dropping:`,
			err,
		)
		return null
	}
}

function rowToLease(row: BrainLeaseRow): AccessLease | null {
	if (
		!row.lease_id ||
		!row.lessor_user_id ||
		!row.lessor_connection_id ||
		!row.approved_by_slack
	) {
		return null
	}
	return {
		leaseId: row.lease_id,
		requestId: row.request_id,
		orgId: row.org_id,
		teamId: row.team_id,
		channel: row.channel,
		threadTs: row.thread_ts,
		lesseeUserId: row.lessee_user_id,
		lessorUserId: row.lessor_user_id,
		lessorConnectionId: row.lessor_connection_id,
		serverSlug: row.server_slug,
		mode: row.mode,
		reason: row.reason,
		status: row.status as AccessLeaseStatus,
		approvedBySlack: row.approved_by_slack,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		revokedAt: row.revoked_at ?? undefined,
	}
}

export function insertLeaseRequest(
	agent: CompanyBrainAgent,
	request: LeaseRequest,
): void {
	agent.sql`
		INSERT INTO brain_lease (
			request_id, org_id, team_id, channel, thread_ts, lessee_user_id,
			lessee_slack_user, server_slug, mode, reason, capability_summary,
			candidate_approvers_json, owners_found, fanout_capped,
			card_deliveries_json, status,
			created_at, expires_at, decided_at, decided_by, turn_control_json
		) VALUES (
			${request.requestId},
			${request.orgId},
			${request.teamId},
			${request.channel},
			${request.threadTs},
			${request.lesseeUserId},
			${request.lesseeSlackUser},
			${request.serverSlug},
			${request.mode},
			${request.reason},
			${request.capabilitySummary},
			${JSON.stringify(request.candidateOwners)},
			${request.ownersFound},
			${request.fanoutCapped ? 1 : 0},
			${JSON.stringify(request.cardDeliveries)},
			${request.status},
			${request.createdAt},
			${request.expiresAt},
			${request.decidedAt ?? null},
			${request.decidedBy ?? null},
			${request.turnControl ? JSON.stringify(request.turnControl) : null}
		)
	`
}

export function loadLeaseRequest(
	agent: CompanyBrainAgent,
	requestId: string,
): LeaseRequest | null {
	const rows = agent.sql<BrainLeaseRow>`
		SELECT * FROM brain_lease WHERE request_id = ${requestId}
	`
	return rows[0] ? rowToRequest(rows[0]) : null
}

export function addLeaseRequestCardDeliveries(
	agent: CompanyBrainAgent,
	requestId: string,
	newDeliveries: LeaseCardDelivery[],
): boolean {
	const current = loadLeaseRequest(agent, requestId)
	if (!current || current.status !== "pending" || newDeliveries.length === 0) {
		return false
	}
	const ownerIndexes = new Set(
		current.cardDeliveries.map((delivery) => delivery.ownerIndex),
	)
	if (
		newDeliveries.some((delivery) => {
			if (ownerIndexes.has(delivery.ownerIndex)) return true
			ownerIndexes.add(delivery.ownerIndex)
			return false
		})
	) {
		return false
	}
	const deliveries = [...current.cardDeliveries, ...newDeliveries]
	const rows = agent.sql<{ request_id: string }>`
		UPDATE brain_lease
		SET card_deliveries_json = ${JSON.stringify(deliveries)}
		WHERE request_id = ${requestId}
			AND status = 'pending'
		RETURNING request_id
	`
	return rows.length > 0
}

export function updateLeaseOwnerDelivery(
	agent: CompanyBrainAgent,
	requestId: string,
	ownerIndex: number,
	deliveryStatus: Extract<LeaseCardDeliveryStatus, "declined" | "invalidated">,
	decidedBy: string | undefined,
	now = Date.now(),
): {
	outcome: "pending" | "all_declined" | "unavailable" | "stale"
	request?: LeaseRequest
} {
	const current = loadLeaseRequest(agent, requestId)
	if (!current || current.status !== "pending") return { outcome: "stale" }
	const transition = updateLeaseDeliveryState(
		current.cardDeliveries,
		ownerIndex,
		deliveryStatus,
	)
	if (!transition) return { outcome: "stale" }
	const { deliveries, outcome } = transition
	const status: LeaseRequestStatus =
		outcome === "all_declined"
			? "denied"
			: outcome === "unavailable"
				? "error"
				: "pending"
	const rows = agent.sql<{ request_id: string }>`
		UPDATE brain_lease
		SET card_deliveries_json = ${JSON.stringify(deliveries)},
			status = ${status},
			decided_at = ${status === "pending" ? null : now},
			decided_by = ${status === "pending" ? null : (decidedBy ?? null)}
		WHERE request_id = ${requestId}
			AND status = 'pending'
		RETURNING request_id
	`
	if (rows.length === 0) return { outcome: "stale" }
	return {
		outcome,
		request: {
			...current,
			cardDeliveries: deliveries,
			status,
			decidedAt: status === "pending" ? undefined : now,
			decidedBy: status === "pending" ? undefined : decidedBy,
		},
	}
}

export function markLeaseRequestTerminalIfPending(
	agent: CompanyBrainAgent,
	requestId: string,
	status: "expired" | "error" | "cancelled",
): boolean {
	const rows = agent.sql<{ request_id: string }>`
		UPDATE brain_lease
		SET status = ${status}
		WHERE request_id = ${requestId}
			AND status = 'pending'
		RETURNING request_id
	`
	return rows.length > 0
}

export function leaseRequestIsExpired(
	request: Pick<LeaseRequest, "expiresAt" | "status">,
	now = Date.now(),
): boolean {
	return request.status === "pending" && request.expiresAt <= now
}

function leaseModeSatisfies(
	existing: LeaseMode,
	requested: LeaseMode,
): boolean {
	return (
		existing === requested ||
		existing === "read_write" ||
		requested === "read_write"
	)
}

export function hasOpenLeaseForServer(
	agent: CompanyBrainAgent,
	orgId: string,
	teamId: string,
	channel: string,
	lesseeUserId: string,
	serverSlug: string,
	threadTs: string,
	requestedMode: LeaseMode,
	now = Date.now(),
): boolean {
	const rows = agent.sql<{ mode: LeaseMode }>`
		SELECT mode FROM brain_lease
		WHERE org_id = ${orgId}
			AND team_id = ${teamId}
			AND channel = ${channel}
			AND lessee_user_id = ${lesseeUserId}
			AND server_slug = ${serverSlug}
			AND thread_ts = ${threadTs}
			AND status IN ('pending', 'approved', 'active')
			AND expires_at > ${now}
	`
	return rows.some((row) => leaseModeSatisfies(row.mode, requestedMode))
}

export function hasPendingLeaseRequestForTurn(
	agent: CompanyBrainAgent,
	control: TurnControlSnapshot | undefined,
	now = Date.now(),
): boolean {
	if (!control) return false
	const rows = agent.sql<{ turn_control_json: string | null }>`
		SELECT turn_control_json FROM brain_lease
		WHERE status = 'pending'
			AND expires_at > ${now}
			AND turn_control_json IS NOT NULL
	`
	return rows.some((row) => {
		if (!row.turn_control_json) return false
		try {
			const parsed = JSON.parse(row.turn_control_json) as TurnControlSnapshot
			return (
				parsed.threadKey === control.threadKey &&
				parsed.turnId === control.turnId &&
				parsed.revision === control.revision
			)
		} catch {
			return false
		}
	})
}

export function activateAccessLease(
	agent: CompanyBrainAgent,
	ownerIndex: number,
	lease: AccessLease,
): LeaseRequest | null {
	const current = loadLeaseRequest(agent, lease.requestId)
	if (!current || current.status !== "pending") return null
	const deliveries = approveLeaseDeliveryState(
		current.cardDeliveries,
		ownerIndex,
	)
	if (!deliveries) return null
	const rows = agent.sql<{ request_id: string }>`
		UPDATE brain_lease
		SET lease_id = ${lease.leaseId},
			lessor_user_id = ${lease.lessorUserId},
			lessor_connection_id = ${lease.lessorConnectionId},
			status = ${lease.status},
			approved_by_slack = ${lease.approvedBySlack},
			card_deliveries_json = ${JSON.stringify(deliveries)},
			created_at = ${lease.createdAt},
			expires_at = ${lease.expiresAt},
			decided_at = ${lease.createdAt},
			decided_by = ${lease.approvedBySlack},
			revoked_at = ${lease.revokedAt ?? null}
		WHERE request_id = ${lease.requestId}
			AND status = 'pending'
		RETURNING request_id
	`
	if (rows.length === 0) return null
	return {
		...current,
		cardDeliveries: deliveries,
		status: "active",
		createdAt: lease.createdAt,
		expiresAt: lease.expiresAt,
		decidedAt: lease.createdAt,
		decidedBy: lease.approvedBySlack,
	}
}

export function loadAccessLease(
	agent: CompanyBrainAgent,
	leaseId: string,
): AccessLease | null {
	const rows = agent.sql<BrainLeaseRow>`
		SELECT * FROM brain_lease WHERE lease_id = ${leaseId}
	`
	return rows[0] ? rowToLease(rows[0]) : null
}
export function listActiveLeasesForActor(
	agent: CompanyBrainAgent,
	orgId: string,
	teamId: string,
	channel: string,
	lesseeUserId: string,
	threadTs: string,
	now = Date.now(),
): AccessLease[] {
	const rows = agent.sql<BrainLeaseRow>`
		SELECT * FROM brain_lease
		WHERE org_id = ${orgId}
			AND team_id = ${teamId}
			AND channel = ${channel}
			AND lessee_user_id = ${lesseeUserId}
			AND thread_ts = ${threadTs}
			AND status = 'active'
			AND expires_at > ${now}
	`
	return rows.flatMap((row) => {
		const lease = rowToLease(row)
		return lease ? [lease] : []
	})
}

export function revokeAccessLease(
	agent: CompanyBrainAgent,
	leaseId: string,
	now = Date.now(),
): boolean {
	const rows = agent.sql<{ lease_id: string }>`
		UPDATE brain_lease
		SET status = 'revoked', revoked_at = ${now}
		WHERE lease_id = ${leaseId} AND status = 'active'
		RETURNING lease_id
	`
	return rows.length > 0
}

export function markAccessLeaseTerminal(
	agent: CompanyBrainAgent,
	leaseId: string,
	status: "expired" | "consumed",
): void {
	agent.sql`
		UPDATE brain_lease
		SET status = ${status}
		WHERE lease_id = ${leaseId} AND status = 'active'
	`
}
export function revokeLeasesForConnection(
	agent: CompanyBrainAgent,
	connectionId: string,
	now = Date.now(),
): number {
	const rows = agent.sql<{ lease_id: string }>`
		UPDATE brain_lease
		SET status = 'revoked', revoked_at = ${now}
		WHERE lessor_connection_id = ${connectionId} AND status = 'active'
		RETURNING lease_id
	`
	return rows.length
}
export async function revalidateLease(
	agent: CompanyBrainAgent,
	leaseId: string,
	now = Date.now(),
): Promise<boolean> {
	const lease = loadAccessLease(agent, leaseId)
	if (!lease) return false
	if (lease.status !== "active") return false
	if (lease.expiresAt <= now) {
		markAccessLeaseTerminal(agent, leaseId, "expired")
		return false
	}
	const env = brainAgent(agent).env
	if (!(await isOrgMember(env, lease.orgId, lease.lesseeUserId))) {
		revokeAccessLease(agent, leaseId, now)
		return false
	}
	const conn = await getConnectionById(env, lease.lessorConnectionId)
	if (!conn) return false
	if (conn.runtime !== "remote_mcp" || !isLeaseableMcpSlug(conn.serverSlug)) {
		return false
	}
	if (conn.id !== lease.lessorConnectionId) return false
	if (conn.orgId !== lease.orgId) return false
	if (conn.serverSlug !== lease.serverSlug) return false
	if (conn.userId !== lease.lessorUserId) return false
	if (conn.status !== "active") return false
	const eligible = await isEligibleLeaseOwner(
		env,
		lease.orgId,
		lease.serverSlug,
		lease.lessorUserId,
		lease.lessorConnectionId,
	)
	if (!eligible) return false
	const latest = loadAccessLease(agent, leaseId)
	if (!latest) return false
	if (latest.status !== "active") return false
	if (latest.expiresAt <= Date.now()) {
		markAccessLeaseTerminal(agent, leaseId, "expired")
		return false
	}
	return true
}
export function buildLeaseRuntimeContext(
	agent: CompanyBrainAgent,
	args: {
		orgId: string
		teamId: string
		channel: string
		threadTs: string
		lesseeUserId: string
	},
): LeaseRuntimeContext | undefined {
	const { orgId, teamId, channel, threadTs, lesseeUserId } = args
	const leasesByServer = new Map<string, ActiveLease>()
	for (const l of listActiveLeasesForActor(
		agent,
		orgId,
		teamId,
		channel,
		lesseeUserId,
		threadTs,
	)) {
		const lease: ActiveLease = {
			leaseId: l.leaseId,
			orgId: l.orgId,
			lesseeUserId: l.lesseeUserId,
			lessorUserId: l.lessorUserId,
			serverSlug: l.serverSlug,
			lessorConnectionId: l.lessorConnectionId,
			mode: l.mode,
		}
		const existing = leasesByServer.get(l.serverSlug)
		if (!existing || lease.mode === "read_write") {
			leasesByServer.set(l.serverSlug, lease)
		}
	}
	const leases = [...leasesByServer.values()]
	if (leases.length === 0) return undefined
	return {
		leases,
		revalidate: (leaseId) => revalidateLease(agent, leaseId),
	}
}
