import type { TurnControlSnapshot } from "../slack/turn-control"

export const LEASE_TTL_MS = 10 * 60 * 1000
export const LEASE_REQUEST_EXPIRY_MS = 15 * 60 * 1000
export const MAX_LEASE_OWNER_FANOUT = 5

export type LeaseMode = "read_only" | "read_write"

export type LeaseStatus =
	| "pending"
	| "approved"
	| "active"
	| "denied"
	| "expired"
	| "revoked"
	| "consumed"
	| "cancelled"
	| "error"

export type LeaseRequestStatus = LeaseStatus
export type AccessLeaseStatus = Extract<
	LeaseStatus,
	"active" | "expired" | "revoked" | "consumed"
>
export type LeaseOwnerCandidate = {
	userId: string
	connectionId: string
	slackUserId?: string
	email?: string
}
export type LeaseCardDeliveryStatus =
	| "pending"
	| "approved"
	| "declined"
	| "invalidated"
export type LeaseCardDelivery = {
	ownerIndex: number
	channel: string
	ts: string
	status: LeaseCardDeliveryStatus
}
export type LeaseRequest = {
	requestId: string
	orgId: string
	teamId: string
	channel: string
	threadTs: string
	lesseeUserId: string
	lesseeSlackUser: string
	serverSlug: string
	mode: LeaseMode
	reason: string
	capabilitySummary: string
	candidateOwners: LeaseOwnerCandidate[]
	ownersFound: number
	fanoutCapped: boolean
	cardDeliveries: LeaseCardDelivery[]
	status: LeaseRequestStatus
	createdAt: number
	expiresAt: number
	decidedAt?: number
	decidedBy?: string
	turnControl?: TurnControlSnapshot
}
export type AccessLease = {
	leaseId: string
	requestId: string
	orgId: string
	teamId: string
	channel: string
	threadTs: string
	lesseeUserId: string
	lessorUserId: string
	lessorConnectionId: string
	serverSlug: string
	mode: LeaseMode
	reason: string
	status: AccessLeaseStatus
	approvedBySlack: string
	createdAt: number
	expiresAt: number
	revokedAt?: number
}
export type ActiveLease = {
	leaseId: string
	orgId: string
	lesseeUserId: string
	lessorUserId: string
	serverSlug: string
	lessorConnectionId: string
	mode: LeaseMode
}
export type LeaseRuntimeContext = {
	leases: ActiveLease[]
	revalidate: (leaseId: string) => Promise<boolean>
}
export type SlackLeaseDecision = {
	teamId: string
	approverSlackUser: string
	decision: "approve" | "deny" | "revoke"
	requestId?: string
	leaseId?: string
	responseUrl?: string
}
// Keep the callback payload name for in-flight Durable Object alarms; this now
// represents one request-expiry alarm rather than a per-owner escalation.
export type LeaseEscalationPayload = {
	requestId: string
}
