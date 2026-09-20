import type { TurnActor } from "./actor"
import type { CompanyBrainAgent } from "./agent"
import type {
	ConnectedAppTrajectoryEntry,
	ReusableInvestigation,
	TurnState,
} from "./state"

export const INVESTIGATION_IDLE_TTL_MS = 6 * 60 * 60 * 1000

const CHECKPOINT_SCHEMA_VERSION = 2
const MAX_CHECKPOINT_CHARS = 160_000
const MAX_GOAL_CHARS = 1_000
const MAX_METHOD_CHARS = 24_000
const MAX_EVIDENCE_CHARS = 4_000
const MAX_LAST_ANSWER_CHARS = 8_000
const MAX_TRAJECTORY_ENTRIES = 6
const MAX_TRAJECTORY_CHARS = 100_000
const MAX_TRAJECTORY_INPUT_CHARS = 4_000
const MAX_TRAJECTORY_OUTPUT_CHARS = 16_000

type PersistedInvestigation = ReusableInvestigation & {
	schemaVersion: 1 | typeof CHECKPOINT_SCHEMA_VERSION
}

type ThreadInvestigationRow = {
	checkpoint_json: string
}

function compactText(value: string, maxChars: number): string {
	const normalized = value.replace(/\s+/g, " ").trim()
	return normalized.length <= maxChars
		? normalized
		: `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function boundedLiteral(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value
	const marker = `…[truncated from ${value.length} characters]`
	return `${value.slice(0, Math.max(0, maxChars - marker.length))}${marker}`
}

function trajectoryEntry(
	value: unknown,
): ConnectedAppTrajectoryEntry | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined
	const entry = value as Partial<ConnectedAppTrajectoryEntry>
	if (
		typeof entry.id !== "string" ||
		typeof entry.tool !== "string" ||
		typeof entry.input !== "string" ||
		typeof entry.output !== "string" ||
		!(["ok", "error", "paused", "unknown"] as const).includes(
			entry.status as ConnectedAppTrajectoryEntry["status"],
		) ||
		typeof entry.outputDigest !== "string" ||
		typeof entry.observedAt !== "number"
	) {
		return undefined
	}
	return {
		id: entry.id.slice(0, 300),
		tool: compactText(entry.tool, 160),
		input: boundedLiteral(entry.input, MAX_TRAJECTORY_INPUT_CHARS),
		output: boundedLiteral(entry.output, MAX_TRAJECTORY_OUTPUT_CHARS),
		status: entry.status as ConnectedAppTrajectoryEntry["status"],
		outputDigest: entry.outputDigest.slice(0, 160),
		observedAt: entry.observedAt,
	}
}

function boundedTrajectory(
	entries: readonly ConnectedAppTrajectoryEntry[],
): ConnectedAppTrajectoryEntry[] {
	const deduped = new Map<string, ConnectedAppTrajectoryEntry>()
	for (const value of entries) {
		const entry = trajectoryEntry(value)
		if (!entry) continue
		const key = JSON.stringify([entry.tool, entry.outputDigest, entry.input])
		deduped.delete(key)
		deduped.set(key, entry)
	}
	const newest = [...deduped.values()]
		.sort((left, right) => right.observedAt - left.observedAt)
		.slice(0, MAX_TRAJECTORY_ENTRIES)
	const kept: ConnectedAppTrajectoryEntry[] = []
	let chars = 0
	for (const entry of newest) {
		const entryChars = JSON.stringify(entry).length
		if (chars + entryChars > MAX_TRAJECTORY_CHARS) continue
		kept.push(entry)
		chars += entryChars
	}
	return kept.sort((left, right) => left.observedAt - right.observedAt)
}

function parseCheckpoint(value: string): ReusableInvestigation | undefined {
	try {
		const parsed = JSON.parse(value) as Partial<PersistedInvestigation>
		if (
			(parsed.schemaVersion !== 1 &&
				parsed.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) ||
			typeof parsed.goal !== "string" ||
			!stringArray(parsed.discoveredMethods) ||
			!stringArray(parsed.verifiedEvidence) ||
			typeof parsed.expiresAt !== "number" ||
			(parsed.lastAnswer !== undefined &&
				typeof parsed.lastAnswer !== "string") ||
			(parsed.trajectory !== undefined && !Array.isArray(parsed.trajectory))
		) {
			return undefined
		}
		return {
			goal: compactText(parsed.goal, MAX_GOAL_CHARS),
			discoveredMethods: parsed.discoveredMethods
				.map((method) => compactText(method, 2_000))
				.filter(Boolean),
			verifiedEvidence: parsed.verifiedEvidence
				.map((evidence) => compactText(evidence, MAX_EVIDENCE_CHARS))
				.filter(Boolean),
			trajectory: boundedTrajectory(
				(parsed.trajectory ?? []).flatMap((entry) => {
					const parsedEntry = trajectoryEntry(entry)
					return parsedEntry ? [parsedEntry] : []
				}),
			),
			lastAnswer: parsed.lastAnswer
				? compactText(parsed.lastAnswer, MAX_LAST_ANSWER_CHARS)
				: undefined,
			expiresAt: parsed.expiresAt,
		}
	} catch {
		return undefined
	}
}

function boundedMethods(methods: readonly string[]): string[] {
	const deduped = new Map<string, string>()
	for (const method of methods) {
		const compact = compactText(method, 2_000)
		if (!compact) continue
		deduped.delete(compact)
		deduped.set(compact, compact)
	}
	const newestFirst = [...deduped.values()].reverse()
	const kept: string[] = []
	let chars = 0
	for (const method of newestFirst) {
		if (chars + method.length > MAX_METHOD_CHARS) continue
		kept.push(method)
		chars += method.length
	}
	return kept.reverse()
}

function serializeCheckpoint(checkpoint: ReusableInvestigation): string {
	const persisted: PersistedInvestigation = {
		schemaVersion: CHECKPOINT_SCHEMA_VERSION,
		goal: compactText(checkpoint.goal, MAX_GOAL_CHARS),
		discoveredMethods: boundedMethods(checkpoint.discoveredMethods),
		verifiedEvidence: checkpoint.verifiedEvidence
			.map((evidence) => compactText(evidence, MAX_EVIDENCE_CHARS))
			.filter(Boolean)
			.slice(-1),
		trajectory: boundedTrajectory(checkpoint.trajectory ?? []),
		lastAnswer: checkpoint.lastAnswer
			? compactText(checkpoint.lastAnswer, MAX_LAST_ANSWER_CHARS)
			: undefined,
		expiresAt: checkpoint.expiresAt,
	}
	const serialized = JSON.stringify(persisted)
	if (serialized.length > MAX_CHECKPOINT_CHARS) {
		throw new Error(
			"Thread investigation checkpoint exceeded its storage bound.",
		)
	}
	return serialized
}

export function ensureThreadInvestigationTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_thread_investigation (
			thread_key TEXT NOT NULL,
			principal_key TEXT NOT NULL,
			checkpoint_json TEXT NOT NULL,
			last_activity_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			PRIMARY KEY (thread_key, principal_key)
		)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_thread_investigation_expires_idx
		ON brain_thread_investigation (expires_at)
	`
}

export function investigationPrincipalKey(args: {
	userId: string
	actor: TurnActor
}): string {
	return JSON.stringify([
		args.userId,
		args.actor.userId ?? null,
		args.actor.personalConnectionsOnly === true,
		args.actor.orgSharedOnly === true,
		args.actor.readOnly === true,
	])
}

export function loadThreadInvestigation(args: {
	agent: CompanyBrainAgent
	threadKey: string
	principalKey: string
	now?: number
}): ReusableInvestigation | undefined {
	const now = args.now ?? Date.now()
	ensureThreadInvestigationTable(args.agent)
	args.agent.sql`
		DELETE FROM brain_thread_investigation
		WHERE expires_at <= ${now}
	`
	const row = args.agent.sql<ThreadInvestigationRow>`
		SELECT checkpoint_json
		FROM brain_thread_investigation
		WHERE thread_key = ${args.threadKey}
			AND principal_key = ${args.principalKey}
		LIMIT 1
	`[0]
	if (!row) return undefined
	const checkpoint = parseCheckpoint(row.checkpoint_json)
	if (checkpoint && checkpoint.expiresAt > now) return checkpoint
	args.agent.sql`
		DELETE FROM brain_thread_investigation
		WHERE thread_key = ${args.threadKey}
			AND principal_key = ${args.principalKey}
	`
	return undefined
}

export function saveThreadInvestigation(args: {
	agent: CompanyBrainAgent
	threadKey: string
	principalKey: string
	checkpoint: ReusableInvestigation
	now?: number
}): ReusableInvestigation {
	const now = args.now ?? Date.now()
	const checkpoint = {
		...args.checkpoint,
		expiresAt: now + INVESTIGATION_IDLE_TTL_MS,
	}
	const serialized = serializeCheckpoint(checkpoint)
	ensureThreadInvestigationTable(args.agent)
	args.agent.sql`
		INSERT INTO brain_thread_investigation (
			thread_key, principal_key, checkpoint_json, last_activity_at, expires_at
		) VALUES (
			${args.threadKey},
			${args.principalKey},
			${serialized},
			${now},
			${checkpoint.expiresAt}
		)
		ON CONFLICT(thread_key, principal_key) DO UPDATE SET
			checkpoint_json = excluded.checkpoint_json,
			last_activity_at = excluded.last_activity_at,
			expires_at = excluded.expires_at
	`
	return checkpoint
}

export function buildThreadInvestigationCheckpoint(args: {
	state: TurnState
	answer: string
	now?: number
}): ReusableInvestigation | undefined {
	const currentMethods = Object.values(args.state.apps.discovered).flatMap(
		(methods) => methods.map((method) => method.canonical),
	)
	const hasConnectedAppWork =
		currentMethods.length > 0 ||
		args.state.nativeCalls.length > 0 ||
		args.state.trajectory.length > 0 ||
		Boolean(args.state.checkpoint)
	if (!hasConnectedAppWork) return undefined

	const answer = compactText(args.answer, MAX_LAST_ANSWER_CHARS)
	const hasSuccessfulEvidence = args.state.nativeCalls.some(
		(call) => call.status === "ok",
	)
	return {
		goal: compactText(args.state.request.text, MAX_GOAL_CHARS),
		discoveredMethods: boundedMethods([
			...(args.state.checkpoint?.discoveredMethods ?? []),
			...currentMethods,
		]),
		verifiedEvidence:
			answer && hasSuccessfulEvidence
				? [compactText(answer, MAX_EVIDENCE_CHARS)]
				: [...(args.state.checkpoint?.verifiedEvidence ?? [])].slice(-1),
		trajectory: boundedTrajectory([
			...(args.state.checkpoint?.trajectory ?? []),
			...args.state.trajectory,
		]),
		lastAnswer: answer || args.state.checkpoint?.lastAnswer,
		expiresAt: (args.now ?? Date.now()) + INVESTIGATION_IDLE_TTL_MS,
	}
}
