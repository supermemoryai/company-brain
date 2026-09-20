import { createHash } from "node:crypto"
import type { Schedule } from "agents"
import { generateObject } from "ai"
import { z } from "zod"
import { fastModel } from "@/config"
import { captureException } from "@/lib/capture"
import { decryptToken } from "@/lib/crypto"
import { writeMemories } from "../memory"
import { BRAIN_CAPTURE_POLICY } from "../memory/profile-config"
import { MAX_BRAIN_OBSERVE_DOCS, personBrainTagKey } from "../memory/tags"
import {
	getBrainMemoryResetEpoch,
	isBrainMemoryResetEpochCurrent,
} from "../memory/tree"
import { type MemoryDocInput, MemoryDocSchema } from "../memory/writeback"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import {
	advanceDurableRetry,
	canScheduleDurableRecovery,
} from "../turn/retry-state"
import {
	getSlackChannelHistoryResult,
	getSlackConversationInfo,
	type SlackThreadMessage,
	type SlackUserInfo,
} from "./client"
import { mentionedUserIds } from "./events"
import { getCachedSlackUserProfiles } from "./profile-cache"
import { buildSlackPromptBatch } from "./prompt-batch"
import { getWorkspaceByTeamId, type SlackOrg } from "./workspace"

const OBSERVE_DELAY_SECONDS = 3 * 60
const CONTINUE_DELAY_SECONDS = 1
const RETRY_BASE_DELAY_SECONDS = 60
const RETRY_MAX_DELAY_SECONDS = 15 * 60
const MAX_RETRY_ATTEMPTS = 5
const MAX_NEW_MESSAGES = 60
const MAX_CONVO_CHARS = 8000
const REPAIR_DELAYS_MS = [1000, 5000, 15_000] as const
// Spool label for bot/app authors so the distiller keeps them as context only.
const BOT_AUTHOR_LABEL = "AGENT_OR_BOT"
let armSequence = 0

export type ChannelObservePayload = {
	teamId: string
	channel: string
	retryAttempt?: number
	resetEpoch?: number
}

const DistillSchema = z.object({
	memories: z.array(MemoryDocSchema).max(MAX_BRAIN_OBSERVE_DOCS),
})

const DISTILL_SYSTEM = `You watch a batch of new Slack channel messages and CURATE what's worth remembering for the team's shared brain. You do NOT write the final memories — you select and group the durable material; a downstream extractor turns each group into durable memories, dedupes, and supersedes stale facts.

${BRAIN_CAPTURE_POLICY}

Lines labeled ${BOT_AUTHOR_LABEL} (bots, apps, and the brain's own prior replies) are context only: read them to make human messages make sense, but never extract a memory from them and never record the brain's own statements as facts. Capture a fact only when a HUMAN states it.

Group the durable content into the fewest TAG-COHERENT clusters that remain independently retrievable. Each cluster covers ONE coherent subject sharing one tag set (a topic-tree path and/or its primary people). Keep related decisions, rationale, owners, and implications together even when several people are involved. Split only genuinely independent subjects, not supporting facts that merely add another person or possible tag. Keep the original wording and any dates — do NOT pre-atomize into single facts, and do NOT dump raw chatter. Prioritize durable CHANGES (ownership, responsibility, roles, decisions) and keep their dates in the text so the extractor can resolve recency. Retain explicit human commitments, blockers, and meaningful status changes with the capture policy's decay rules; exclude raw activity, live counts, and app-derived status snapshots. Skip pure chatter; if nothing durable, return an empty list.

For each cluster: content = the curated relevant material (faithful, dates preserved); tags = the fewest coherent topic-tree paths ('/'-nested, reuse exact existing paths rather than creating near-duplicates) + person_<slack_user_id> only for primary people. Leave eventDate unset — dates stay in the content for the extractor to assign per fact.`

type PendingMessage = SlackThreadMessage & { ts: string }
type PersistedChannelBatch = {
	fromTs: string
	throughTs: string
	messageCount: number
	clusters: MemoryDocInput[]
}
type ChannelObserveRow = {
	channel_key: string
	schedule_id: string
	team_id: string
	channel: string
	armed_at: number
	reset_epoch: number
}
type ChannelRetryRow = { attempt: number; exhausted: number }

function channelKey(payload: ChannelObservePayload): string {
	return `${payload.teamId}:${payload.channel}`
}

function nextArmSequence(): number {
	armSequence = Math.max(armSequence + 1, Date.now() * 1000)
	return armSequence
}

export function ensureChannelObserveTables(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_channel_observe (
			channel_key TEXT PRIMARY KEY,
			schedule_id TEXT NOT NULL,
			team_id TEXT NOT NULL,
			channel TEXT NOT NULL,
			armed_at INTEGER NOT NULL,
			reset_epoch INTEGER NOT NULL DEFAULT 0
		)
	`
	const ownershipColumns = agent.sql<{ name: string }>`
		PRAGMA table_info(brain_channel_observe)
	`
	if (!ownershipColumns.some((column) => column.name === "reset_epoch")) {
		agent.sql`
			ALTER TABLE brain_channel_observe
			ADD COLUMN reset_epoch INTEGER NOT NULL DEFAULT 0
		`
	}
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_channel_observe_cursor (
			channel TEXT PRIMARY KEY,
			last_ts TEXT NOT NULL DEFAULT '',
			updated_at INTEGER NOT NULL
		)
	`
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_channel_observe_scan (
			channel_key TEXT PRIMARY KEY,
			latest_ts TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_channel_observe_pending (
			channel_key TEXT NOT NULL,
			ts TEXT NOT NULL,
			user_id TEXT NOT NULL,
			text TEXT NOT NULL,
			PRIMARY KEY (channel_key, ts)
		)
	`
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_channel_observe_batch (
			channel_key TEXT NOT NULL,
			from_ts TEXT NOT NULL,
			through_ts TEXT NOT NULL,
			message_count INTEGER NOT NULL,
			clusters_json TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (channel_key, through_ts)
		)
	`
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_channel_observe_retry (
			channel_key TEXT PRIMARY KEY,
			attempt INTEGER NOT NULL,
			exhausted INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_channel_observe_probe (
			channel_key TEXT PRIMARY KEY,
			armed_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`
}

function loadChannelRetryState(
	agent: CompanyBrainAgent,
	key: string,
): { attempt: number; exhausted: boolean } {
	const row = agent.sql<ChannelRetryRow>`
		SELECT attempt, exhausted FROM brain_channel_observe_retry
		WHERE channel_key = ${key}
	`[0]
	return { attempt: row?.attempt ?? 0, exhausted: Boolean(row?.exhausted) }
}

function clearChannelRetryState(agent: CompanyBrainAgent, key: string): void {
	agent.sql`DELETE FROM brain_channel_observe_retry WHERE channel_key = ${key}`
	agent.sql`DELETE FROM brain_channel_observe_probe WHERE channel_key = ${key}`
}

function publishChannelProbe(
	agent: CompanyBrainAgent,
	key: string,
	armedAt: number,
): void {
	agent.sql`
		INSERT INTO brain_channel_observe_probe (channel_key, armed_at, updated_at)
		VALUES (${key}, ${armedAt}, ${Date.now()})
		ON CONFLICT(channel_key) DO UPDATE SET
			armed_at = excluded.armed_at,
			updated_at = excluded.updated_at
	`
}

function isChannelProbeAllowed(
	agent: CompanyBrainAgent,
	key: string,
	armedAt: number,
): boolean {
	return Boolean(
		agent.sql<{ armed_at: number }>`
			SELECT armed_at FROM brain_channel_observe_probe
			WHERE channel_key = ${key} AND armed_at = ${armedAt}
		`[0],
	)
}

function claimChannelProbe(
	agent: CompanyBrainAgent,
	key: string,
	armedAt: number,
): boolean {
	return Boolean(
		agent.sql<{ channel_key: string }>`
			DELETE FROM brain_channel_observe_probe
			WHERE channel_key = ${key} AND armed_at = ${armedAt}
			RETURNING channel_key
		`[0],
	)
}

function persistChannelRetryState(
	agent: CompanyBrainAgent,
	key: string,
	attempt: number,
	exhausted: boolean,
): void {
	agent.sql`
		INSERT INTO brain_channel_observe_retry (channel_key, attempt, exhausted, updated_at)
		VALUES (${key}, ${attempt}, ${exhausted ? 1 : 0}, ${Date.now()})
		ON CONFLICT(channel_key) DO UPDATE SET
			attempt = excluded.attempt,
			exhausted = excluded.exhausted,
			updated_at = excluded.updated_at
	`
	agent.sql`DELETE FROM brain_channel_observe_probe WHERE channel_key = ${key}`
}

function loadPersistedBatch(
	agent: CompanyBrainAgent,
	key: string,
): PersistedChannelBatch | undefined {
	const row = agent.sql<{
		from_ts: string
		through_ts: string
		message_count: number
		clusters_json: string
	}>`
		SELECT from_ts, through_ts, message_count, clusters_json
		FROM brain_channel_observe_batch
		WHERE channel_key = ${key}
		ORDER BY through_ts ASC
		LIMIT 1
	`[0]
	if (!row) return undefined
	return {
		fromTs: row.from_ts,
		throughTs: row.through_ts,
		messageCount: row.message_count,
		clusters: JSON.parse(row.clusters_json) as MemoryDocInput[],
	}
}

function stableClusterCustomId(
	orgId: string,
	key: string,
	fromTs: string,
	throughTs: string,
	index: number,
	resetEpoch: number,
): string {
	// resetEpoch scopes the id to a generation: an old-generation write can never
	// dedupe onto (and then get its stale-cleanup delete) a post-reset document.
	const hash = createHash("sha256")
		.update(`${orgId}:${key}:${fromTs}:${throughTs}:${index}:${resetEpoch}`)
		.digest("hex")
	return `company-brain-channel-observe:${hash}`
}

function getObserveCursor(
	agent: CompanyBrainAgent,
	payload: ChannelObservePayload,
): string {
	const key = channelKey(payload)
	return (
		agent.sql<{ last_ts: string }>`
			SELECT last_ts FROM brain_channel_observe_cursor
			WHERE channel = ${key} OR channel = ${payload.channel}
			ORDER BY CASE WHEN channel = ${key} THEN 0 ELSE 1 END
			LIMIT 1
		`[0]?.last_ts ?? ""
	)
}

function updateObserveCursor(
	agent: CompanyBrainAgent,
	key: string,
	lastTs: string,
): void {
	agent.sql`
		INSERT INTO brain_channel_observe_cursor (channel, last_ts, updated_at)
		VALUES (${key}, ${lastTs}, ${Date.now()})
		ON CONFLICT(channel) DO UPDATE SET last_ts = excluded.last_ts, updated_at = excluded.updated_at
		WHERE excluded.last_ts > brain_channel_observe_cursor.last_ts
	`
}

function isOwned(
	agent: CompanyBrainAgent,
	key: string,
	scheduleId: string,
): boolean {
	return Boolean(
		agent.sql<{ schedule_id: string }>`
			SELECT schedule_id FROM brain_channel_observe
			WHERE channel_key = ${key} AND schedule_id = ${scheduleId}
		`[0],
	)
}

async function scheduleChannelObserve(
	agent: CompanyBrainAgent,
	payload: ChannelObservePayload,
	delaySeconds: number,
): Promise<Schedule<ChannelObservePayload>> {
	return agent.schedule(delaySeconds, "runChannelObserve", payload)
}

async function rearmOwnedChannelObserve(
	agent: CompanyBrainAgent,
	payload: ChannelObservePayload,
	ownedScheduleId: string,
	delaySeconds: number,
	retryAttempt: number,
): Promise<void> {
	const key = channelKey(payload)
	let scheduled: Schedule<ChannelObservePayload>
	try {
		scheduled = await scheduleChannelObserve(
			agent,
			{ ...payload, retryAttempt },
			delaySeconds,
		)
	} catch (err) {
		queueChannelObserveRepair(agent, key)
		console.error("[company-brain] channel-observe schedule failed:", err)
		return
	}
	try {
		const updated = agent.sql<{ schedule_id: string }>`
			UPDATE brain_channel_observe
			SET schedule_id = ${scheduled.id}
			WHERE channel_key = ${key} AND schedule_id = ${ownedScheduleId}
			RETURNING schedule_id
		`
		if (updated.length) return
	} catch (err) {
		await agent.cancelSchedule(scheduled.id).catch(() => {})
		queueChannelObserveRepair(agent, key)
		console.error(
			"[company-brain] channel-observe ownership handoff failed:",
			err,
		)
		return
	}
	await agent.cancelSchedule(scheduled.id).catch(() => {})
}

function retryDelaySeconds(attempt: number): number {
	return Math.min(
		RETRY_BASE_DELAY_SECONDS * 2 ** Math.max(0, attempt - 1),
		RETRY_MAX_DELAY_SECONDS,
	)
}

async function retryOwnedChannelObserve(
	agent: CompanyBrainAgent,
	payload: ChannelObservePayload,
	key: string,
	scheduleId: string,
	error?: unknown,
): Promise<void> {
	if (!isOwned(agent, key, scheduleId)) return
	const next = advanceDurableRetry(
		loadChannelRetryState(agent, key),
		MAX_RETRY_ATTEMPTS,
	)
	persistChannelRetryState(agent, key, next.state.attempt, next.state.exhausted)
	if (!next.shouldSchedule) {
		finishOwnedChannelObserve(agent, key, scheduleId)
		const exhausted = new Error("channel_observe_retry_exhausted")
		captureException(exhausted, {
			tags: { component: "brain-channel-observe" },
			extra: {
				teamId: payload.teamId,
				channel: payload.channel,
				attempts: MAX_RETRY_ATTEMPTS,
			},
		})
		console.error(
			`[company-brain] channel-observe retries exhausted channel=${payload.channel}`,
			error instanceof Error ? error.name : "unknown",
		)
		return
	}
	await rearmOwnedChannelObserve(
		agent,
		payload,
		scheduleId,
		retryDelaySeconds(next.state.attempt),
		next.state.attempt,
	)
}

function finishOwnedChannelObserve(
	agent: CompanyBrainAgent,
	key: string,
	scheduleId: string,
): void {
	agent.sql`
		DELETE FROM brain_channel_observe
		WHERE channel_key = ${key} AND schedule_id = ${scheduleId}
	`
}

function clearTerminalChannelObserve(
	agent: CompanyBrainAgent,
	key: string,
	scheduleId: string,
): void {
	finishOwnedChannelObserve(agent, key, scheduleId)
	agent.sql`DELETE FROM brain_channel_observe_scan WHERE channel_key = ${key}`
	agent.sql`DELETE FROM brain_channel_observe_pending WHERE channel_key = ${key}`
	agent.sql`DELETE FROM brain_channel_observe_batch WHERE channel_key = ${key}`
	clearChannelRetryState(agent, key)
}

async function reconcileChannelObserveRow(
	agent: CompanyBrainAgent,
	key: string,
): Promise<boolean> {
	let scheduled: Schedule<ChannelObservePayload> | undefined
	try {
		const row = agent.sql<ChannelObserveRow>`
			SELECT channel_key, schedule_id, team_id, channel, armed_at, reset_epoch
			FROM brain_channel_observe WHERE channel_key = ${key}
		`[0]
		if (!row) return true
		const retry = loadChannelRetryState(agent, key)
		if (
			!canScheduleDurableRecovery(
				retry,
				isChannelProbeAllowed(agent, key, row.armed_at),
			)
		) {
			finishOwnedChannelObserve(agent, key, row.schedule_id)
			await agent.cancelSchedule(row.schedule_id).catch(() => {})
			return true
		}
		if (agent.getSchedules({ id: row.schedule_id }).length) return true
		scheduled = await scheduleChannelObserve(
			agent,
			{
				teamId: row.team_id,
				channel: row.channel,
				retryAttempt: retry.attempt,
				resetEpoch: row.reset_epoch,
			},
			retry.attempt > 0 && !retry.exhausted
				? retryDelaySeconds(retry.attempt)
				: CONTINUE_DELAY_SECONDS,
		)
		const updated = agent.sql<{ schedule_id: string }>`
			UPDATE brain_channel_observe
			SET schedule_id = ${scheduled.id}
			WHERE channel_key = ${key} AND schedule_id = ${row.schedule_id}
			RETURNING schedule_id
		`
		if (updated.length) return true
		await agent.cancelSchedule(scheduled.id).catch(() => {})
		return true
	} catch (err) {
		if (scheduled) await agent.cancelSchedule(scheduled.id).catch(() => {})
		console.error("[company-brain] channel-observe repair failed:", err)
		return false
	}
}

function queueChannelObserveRepair(
	agent: CompanyBrainAgent,
	key: string,
): void {
	agent.waitUntil(
		(async () => {
			for (const delayMs of REPAIR_DELAYS_MS) {
				await new Promise((resolve) => setTimeout(resolve, delayMs))
				if (await reconcileChannelObserveRow(agent, key)) return
			}
		})().catch((err) => {
			console.error(
				"[company-brain] channel-observe background repair failed:",
				err,
			)
		}),
	)
}

function migrateLegacyChannelState(
	agent: CompanyBrainAgent,
	legacyKey: string,
	compositeKey: string,
	migrateDurableState: boolean,
): void {
	const legacyCursor = agent.sql<{ last_ts: string }>`
		SELECT last_ts FROM brain_channel_observe_cursor
		WHERE channel = ${legacyKey}
	`[0]
	if (legacyCursor)
		updateObserveCursor(agent, compositeKey, legacyCursor.last_ts)
	agent.sql`
		DELETE FROM brain_channel_observe_cursor WHERE channel = ${legacyKey}
	`
	if (migrateDurableState) {
		agent.sql`
			INSERT OR IGNORE INTO brain_channel_observe_scan (channel_key, latest_ts, updated_at)
			SELECT ${compositeKey}, latest_ts, updated_at
			FROM brain_channel_observe_scan WHERE channel_key = ${legacyKey}
		`
		agent.sql`
			INSERT OR IGNORE INTO brain_channel_observe_pending (channel_key, ts, user_id, text)
			SELECT ${compositeKey}, ts, user_id, text
			FROM brain_channel_observe_pending WHERE channel_key = ${legacyKey}
		`
		agent.sql`
			INSERT OR IGNORE INTO brain_channel_observe_batch (
				channel_key, from_ts, through_ts, message_count, clusters_json, created_at
			)
			SELECT ${compositeKey}, from_ts, through_ts, message_count, clusters_json, created_at
			FROM brain_channel_observe_batch WHERE channel_key = ${legacyKey}
		`
		agent.sql`
			INSERT INTO brain_channel_observe_retry (channel_key, attempt, exhausted, updated_at)
			SELECT ${compositeKey}, attempt, exhausted, updated_at
			FROM brain_channel_observe_retry WHERE channel_key = ${legacyKey}
			ON CONFLICT(channel_key) DO UPDATE SET
				attempt = CASE
					WHEN excluded.attempt > brain_channel_observe_retry.attempt THEN excluded.attempt
					ELSE brain_channel_observe_retry.attempt
				END,
				exhausted = CASE
					WHEN excluded.exhausted > brain_channel_observe_retry.exhausted THEN excluded.exhausted
					ELSE brain_channel_observe_retry.exhausted
				END,
				updated_at = excluded.updated_at
		`
		agent.sql`
			INSERT INTO brain_channel_observe_probe (channel_key, armed_at, updated_at)
			SELECT ${compositeKey}, armed_at, updated_at
			FROM brain_channel_observe_probe WHERE channel_key = ${legacyKey}
			ON CONFLICT(channel_key) DO UPDATE SET
				armed_at = excluded.armed_at,
				updated_at = excluded.updated_at
		`
	}
	agent.sql`DELETE FROM brain_channel_observe_scan WHERE channel_key = ${legacyKey}`
	agent.sql`DELETE FROM brain_channel_observe_pending WHERE channel_key = ${legacyKey}`
	agent.sql`DELETE FROM brain_channel_observe_batch WHERE channel_key = ${legacyKey}`
	agent.sql`DELETE FROM brain_channel_observe_retry WHERE channel_key = ${legacyKey}`
	agent.sql`DELETE FROM brain_channel_observe_probe WHERE channel_key = ${legacyKey}`
}

async function migrateLegacyChannelObserveOwnership(
	agent: CompanyBrainAgent,
): Promise<void> {
	const legacyRows = agent.sql<ChannelObserveRow>`
		SELECT channel_key, schedule_id, team_id, channel, armed_at, reset_epoch
		FROM brain_channel_observe
		WHERE channel_key = channel
	`
	const schedulesToCancel: string[] = []
	for (const legacy of legacyRows) {
		const compositeKey = `${legacy.team_id}:${legacy.channel}`
		const composite = agent.sql<{ schedule_id: string }>`
			SELECT schedule_id FROM brain_channel_observe
			WHERE channel_key = ${compositeKey}
		`[0]
		if (composite) {
			agent.sql`
				DELETE FROM brain_channel_observe
				WHERE channel_key = ${legacy.channel_key}
					AND schedule_id = ${legacy.schedule_id}
			`
			migrateLegacyChannelState(agent, legacy.channel_key, compositeKey, false)
			schedulesToCancel.push(legacy.schedule_id)
			continue
		}
		const migrated = agent.sql<{ channel_key: string }>`
			UPDATE OR IGNORE brain_channel_observe
			SET channel_key = ${compositeKey}
			WHERE channel_key = ${legacy.channel_key}
				AND schedule_id = ${legacy.schedule_id}
			RETURNING channel_key
		`
		if (migrated.length) {
			migrateLegacyChannelState(agent, legacy.channel_key, compositeKey, true)
			continue
		}
		agent.sql`
			DELETE FROM brain_channel_observe
			WHERE channel_key = ${legacy.channel_key}
				AND schedule_id = ${legacy.schedule_id}
		`
		migrateLegacyChannelState(agent, legacy.channel_key, compositeKey, false)
		schedulesToCancel.push(legacy.schedule_id)
	}
	await Promise.all(
		schedulesToCancel.map((scheduleId) =>
			agent.cancelSchedule(scheduleId).catch(() => {}),
		),
	)
}

export async function reconcileChannelObserveSchedules(
	agent: CompanyBrainAgent,
): Promise<void> {
	ensureChannelObserveTables(agent)
	await migrateLegacyChannelObserveOwnership(agent)
	const rows = agent.sql<{ channel_key: string }>`
		SELECT channel_key FROM brain_channel_observe
	`
	await Promise.all(
		rows.map(async (row) => {
			if (!(await reconcileChannelObserveRow(agent, row.channel_key))) {
				queueChannelObserveRepair(agent, row.channel_key)
			}
		}),
	)
}

async function attemptChannelObserveArm(
	agent: CompanyBrainAgent,
	payload: ChannelObservePayload,
	key: string,
	armedAt: number,
): Promise<boolean> {
	const existing = agent.sql<ChannelObserveRow>`
		SELECT channel_key, schedule_id, team_id, channel, armed_at, reset_epoch
		FROM brain_channel_observe
		WHERE channel_key = ${key} OR channel_key = ${payload.channel}
	`
	if (
		existing.some((row) => row.channel_key === key && row.armed_at >= armedAt)
	) {
		return true
	}
	const retry = loadChannelRetryState(agent, key)
	let scheduled: Schedule<ChannelObservePayload> | undefined
	try {
		scheduled = await scheduleChannelObserve(
			agent,
			{ ...payload, retryAttempt: retry.attempt },
			OBSERVE_DELAY_SECONDS,
		)
		if (!isBrainMemoryResetEpochCurrent(agent, payload.resetEpoch ?? 0)) {
			await agent.cancelSchedule(scheduled.id).catch(() => false)
			return true
		}
		const persisted = Boolean(
			agent.sql<{ schedule_id: string }>`
				INSERT INTO brain_channel_observe (channel_key, schedule_id, team_id, channel, armed_at, reset_epoch)
				VALUES (${key}, ${scheduled.id}, ${payload.teamId}, ${payload.channel}, ${armedAt}, ${payload.resetEpoch ?? 0})
				ON CONFLICT(channel_key) DO UPDATE SET
					schedule_id = excluded.schedule_id,
					team_id = excluded.team_id,
					channel = excluded.channel,
					armed_at = excluded.armed_at,
					reset_epoch = excluded.reset_epoch
				WHERE brain_channel_observe.armed_at <= excluded.armed_at
				RETURNING schedule_id
			`[0],
		)
		if (!persisted) {
			await agent.cancelSchedule(scheduled.id).catch(() => {})
			return true
		}
		if (loadChannelRetryState(agent, key).exhausted) {
			publishChannelProbe(agent, key, armedAt)
		}
		const scheduleId = scheduled.id
		agent.sql`
			DELETE FROM brain_channel_observe
			WHERE channel_key = ${payload.channel} AND channel_key <> ${key}
		`
		await Promise.all(
			existing.flatMap((prior) =>
				prior.schedule_id === scheduleId
					? []
					: [agent.cancelSchedule(prior.schedule_id).catch(() => {})],
			),
		)
		return true
	} catch (err) {
		if (scheduled) {
			try {
				agent.sql`
					DELETE FROM brain_channel_observe
					WHERE channel_key = ${key} AND schedule_id = ${scheduled.id}
				`
			} catch {}
			await agent.cancelSchedule(scheduled.id).catch(() => {})
		}
		console.error("[company-brain] channel-observe initial arm failed:", err)
		return false
	}
}

function queueChannelObserveArmRetry(
	agent: CompanyBrainAgent,
	payload: ChannelObservePayload,
	key: string,
	armedAt: number,
): void {
	agent.waitUntil(
		(async () => {
			for (const delayMs of REPAIR_DELAYS_MS) {
				await new Promise((resolve) => setTimeout(resolve, delayMs))
				if (await attemptChannelObserveArm(agent, payload, key, armedAt)) {
					return
				}
			}
		})().catch((err) => {
			console.error("[company-brain] channel-observe arm repair failed:", err)
		}),
	)
}

export async function armChannelObserve(
	agent: CompanyBrainAgent,
	payload: ChannelObservePayload,
): Promise<void> {
	ensureChannelObserveTables(agent)
	const epochPayload = {
		...payload,
		resetEpoch: getBrainMemoryResetEpoch(agent),
	}
	const key = channelKey(epochPayload)
	const armedAt = nextArmSequence()
	if (!(await attemptChannelObserveArm(agent, epochPayload, key, armedAt))) {
		queueChannelObserveArmRetry(agent, epochPayload, key, armedAt)
	}
}

// Bot/app output (incl. the brain's own replies) isn't evidence and would create
// a self-reinforcing memory loop, so it never enters the pending spool.
function isBotAuthoredMessage(
	message: SlackThreadMessage,
	botUserId: string | null,
): boolean {
	return Boolean(
		message.bot_id ||
			message.app_id ||
			message.subtype === "bot_message" ||
			(botUserId && message.user === botUserId),
	)
}

async function spoolChannelPage(
	agent: CompanyBrainAgent,
	botToken: string,
	payload: ChannelObservePayload,
	key: string,
	cursor: string,
	scheduleId: string,
	botUserId: string | null,
): Promise<"complete" | "continue" | "retry" | "stale"> {
	const scan = agent.sql<{ latest_ts: string }>`
		SELECT latest_ts FROM brain_channel_observe_scan WHERE channel_key = ${key}
	`[0]
	const history = await getSlackChannelHistoryResult(
		botToken,
		payload.channel,
		{
			oldest: cursor || undefined,
			latest: scan?.latest_ts,
			inclusive: false,
			maxMessages: MAX_NEW_MESSAGES,
			maxPages: 1,
			limit: MAX_NEW_MESSAGES,
		},
	)
	if (!history.ok) return "retry"
	if (!isOwned(agent, key, scheduleId)) return "stale"

	const fresh = history.messages
		.filter((message): message is PendingMessage =>
			Boolean(message.ts && message.ts > cursor),
		)
		.sort((a, b) => a.ts.localeCompare(b.ts))
	// Spool bots too (a human reply is meaningless without them), but label them
	// so the distiller uses them as context, never as a fact source.
	for (const message of fresh) {
		const author = isBotAuthoredMessage(message, botUserId)
			? BOT_AUTHOR_LABEL
			: (message.user ?? "?")
		agent.sql`
			INSERT OR IGNORE INTO brain_channel_observe_pending (channel_key, ts, user_id, text)
			VALUES (${key}, ${message.ts}, ${author}, ${message.text ?? ""})
		`
	}

	if (history.complete) {
		agent.sql`DELETE FROM brain_channel_observe_scan WHERE channel_key = ${key}`
		return "complete"
	}
	if (!fresh.length) return "retry"
	const oldestTs = fresh[0]?.ts
	if (!oldestTs) return "retry"
	agent.sql`
		INSERT INTO brain_channel_observe_scan (channel_key, latest_ts, updated_at)
		VALUES (${key}, ${oldestTs}, ${Date.now()})
		ON CONFLICT(channel_key) DO UPDATE SET latest_ts = excluded.latest_ts, updated_at = excluded.updated_at
	`
	return "continue"
}

// Person tags may only reference people actually in the batch (authors + their
// @-mentions), so the model can't invent an unrelated or nonexistent person.
function trustedPersonIdsForBatch(
	agent: CompanyBrainAgent,
	key: string,
	fromTs: string,
	throughTs: string,
	botUserId: string | null,
): string[] {
	const rows = agent.sql<{ user_id: string; text: string }>`
		SELECT user_id, text FROM brain_channel_observe_pending
		WHERE channel_key = ${key} AND ts >= ${fromTs} AND ts <= ${throughTs}
	`
	const ids = new Set<string>()
	for (const row of rows) {
		// Bot lines are context only — they never make a person "trusted".
		if (row.user_id === BOT_AUTHOR_LABEL) continue
		if (row.user_id && row.user_id !== "?" && row.user_id !== botUserId) {
			ids.add(row.user_id)
		}
		for (const mentioned of mentionedUserIds(row.text, botUserId)) {
			ids.add(mentioned)
		}
	}
	return [...ids]
}

// Distilled memories must read with human names, not raw Slack ids. Resolve
// author + @-mention ids to display names for the evidence text only; person
// tags stay id-based via trustedPersonIdsForBatch.
type HumanizedBatch = {
	messages: Array<{ ts: string; user: string; text: string }>
	/** name→person_<id> for the batch's people, so the distiller can still tag by id. */
	roster: Array<{ name: string; tag: string }>
}

async function humanizeBatchNames(
	agent: CompanyBrainAgent,
	teamId: string,
	botToken: string,
	botUserId: string | null,
	messages: Array<{ ts: string; user: string; text: string }>,
): Promise<HumanizedBatch> {
	const ids = new Set<string>()
	for (const message of messages) {
		if (message.user && message.user !== BOT_AUTHOR_LABEL) ids.add(message.user)
		for (const mentioned of mentionedUserIds(message.text, botUserId)) {
			ids.add(mentioned)
		}
	}
	if (!ids.size) return { messages, roster: [] }
	let profiles: Map<string, SlackUserInfo>
	try {
		profiles = await getCachedSlackUserProfiles(agent, {
			teamId,
			botToken,
			userIds: [...ids],
		})
	} catch {
		return { messages, roster: [] }
	}
	const baseName = (id: string): string => {
		const info = profiles.get(id)
		return info?.name || info?.displayName || info?.handle || id
	}
	// Disambiguate people who share a display name, so a memory can never be tagged to
	// the wrong person: a collided name is qualified with the (unique) Slack handle, or
	// the id as a last resort. The same label is used in the text and the roster.
	const nameCounts = new Map<string, number>()
	for (const id of ids) {
		const base = baseName(id)
		nameCounts.set(base, (nameCounts.get(base) ?? 0) + 1)
	}
	const labelFor = (id: string): string => {
		const base = baseName(id)
		if ((nameCounts.get(base) ?? 0) <= 1) return base
		const handle = profiles.get(id)?.handle
		return handle ? `${base} (@${handle})` : `${base} (${id})`
	}
	// Names keep the evidence human-readable; the roster preserves the id mapping the
	// distiller needs to emit stable person_<id> tags (the tags themselves are still
	// gated to trusted batch ids at write time).
	const roster = [...ids]
		.filter((id) => id !== botUserId)
		.map((id) => ({ name: labelFor(id), tag: personBrainTagKey(id) }))
	return {
		messages: messages.map((message) => ({
			ts: message.ts,
			user:
				message.user === BOT_AUTHOR_LABEL
					? BOT_AUTHOR_LABEL
					: labelFor(message.user),
			text: message.text.replace(
				/<@([A-Z0-9]+)(?:\|[^>]+)?>/g,
				(_match, id: string) => `@${labelFor(id)}`,
			),
		})),
		roster,
	}
}

async function processPendingBatch(
	agent: CompanyBrainAgent,
	payload: ChannelObservePayload,
	key: string,
	scheduleId: string,
	ws: NonNullable<Awaited<ReturnType<typeof getWorkspaceByTeamId>>>,
	installedByUserId: string,
	botToken: string,
): Promise<"complete" | "continue" | "retry" | "stale"> {
	if (!isOwned(agent, key, scheduleId)) return "stale"
	const cursor = getObserveCursor(agent, payload)
	let persisted = loadPersistedBatch(agent, key)
	if (persisted && persisted.throughTs <= cursor) {
		agent.sql`
			DELETE FROM brain_channel_observe_batch
			WHERE channel_key = ${key} AND through_ts = ${persisted.throughTs}
		`
		persisted = loadPersistedBatch(agent, key)
	}
	agent.sql`
		DELETE FROM brain_channel_observe_pending
		WHERE channel_key = ${key} AND ts <= ${cursor}
	`
	if (!persisted) {
		const pending = agent.sql<{
			ts: string
			user_id: string
			text: string
		}>`
			SELECT ts, user_id, text FROM brain_channel_observe_pending
			WHERE channel_key = ${key} AND ts > ${cursor}
			ORDER BY ts ASC
			LIMIT ${MAX_NEW_MESSAGES}
		`.map((row) => ({ ts: row.ts, user: row.user_id, text: row.text }))
		if (!pending.length) return "complete"

		const { messages: named, roster } = await humanizeBatchNames(
			agent,
			payload.teamId,
			botToken,
			ws.botUserId,
			pending,
		)
		const promptBatch = buildSlackPromptBatch(named, MAX_CONVO_CHARS)
		const fromTs = promptBatch.messages[0]?.ts
		const throughTs = promptBatch.messages.reduce(
			(max, message) => ((message.ts ?? "") > max ? (message.ts ?? "") : max),
			cursor,
		)
		if (!fromTs || throughTs <= cursor) return "retry"
		if (!isOwned(agent, key, scheduleId)) return "stale"

		const rosterText = roster.length
			? `People in these messages — when a memory is about one of them, tag it with the exact key shown and write their name (never the id) in the content:\n${roster
					.map((r) => `- ${r.name} → ${r.tag}`)
					.join("\n")}\n\n`
			: ""
		const result = await generateObject({
			model: fastModel(),
			system: DISTILL_SYSTEM,
			prompt: `${rosterText}New messages in this channel:\n${promptBatch.prompt}\n\nDurable memories (or an empty list):`,
			schema: DistillSchema,
		})
		if (!isOwned(agent, key, scheduleId)) return "stale"
		const docDate = new Date(Number(throughTs.split(".")[0]) * 1000)
			.toISOString()
			.slice(0, 10)
		const clusters: MemoryDocInput[] = result.object.memories.map(
			(memory, index) => ({
				...memory,
				content: `DOCUMENT_DATE: ${docDate}\n${memory.content}`,
				internalCustomIdOverride: stableClusterCustomId(
					ws.orgId,
					key,
					fromTs,
					throughTs,
					index,
					payload.resetEpoch ?? 0,
				),
			}),
		)
		agent.sql`
			INSERT OR IGNORE INTO brain_channel_observe_batch (
				channel_key, from_ts, through_ts, message_count, clusters_json, created_at
			) VALUES (
				${key}, ${fromTs}, ${throughTs}, ${promptBatch.messages.length},
				${JSON.stringify(clusters)}, ${Date.now()}
			)
		`
		if (!isOwned(agent, key, scheduleId)) return "stale"
		persisted = loadPersistedBatch(agent, key)
		if (!persisted) return "retry"
	}

	if (persisted.clusters.length) {
		const org: SlackOrg = {
			id: ws.orgId,
			name: ws.orgName,
			slug: ws.orgSlug,
			metadata: ws.orgMetadata,
		}
		const out = await writeMemories(
			brainAgent(agent).env,
			undefined,
			org,
			installedByUserId,
			persisted.clusters,
			undefined,
			agent,
			{
				expectedResetEpoch: payload.resetEpoch ?? 0,
				allowedPersonSlackUserIds: trustedPersonIdsForBatch(
					agent,
					key,
					persisted.fromTs,
					persisted.throughTs,
					ws.botUserId,
				),
			},
		)
		if (out.written !== out.total) return "retry"
		console.log(
			`[company-brain] channel-observe org=${ws.orgId} channel=${payload.channel} messages=${persisted.messageCount} clusters=${persisted.clusters.length} written=${out.written}/${out.total}`,
		)
	}
	if (!isOwned(agent, key, scheduleId)) return "stale"
	updateObserveCursor(agent, key, persisted.throughTs)
	agent.sql`
		DELETE FROM brain_channel_observe_pending
		WHERE channel_key = ${key} AND ts <= ${persisted.throughTs}
	`
	agent.sql`
		DELETE FROM brain_channel_observe_batch
		WHERE channel_key = ${key} AND through_ts = ${persisted.throughTs}
	`
	return "continue"
}

export async function runChannelObserve(
	agent: CompanyBrainAgent,
	payload: ChannelObservePayload,
	schedule: Schedule<ChannelObservePayload>,
): Promise<void> {
	ensureChannelObserveTables(agent)
	const key = channelKey(payload)
	if (!isBrainMemoryResetEpochCurrent(agent, payload.resetEpoch ?? 0)) {
		finishOwnedChannelObserve(agent, key, schedule.id)
		return
	}
	if (!isOwned(agent, key, schedule.id)) return
	const retry = loadChannelRetryState(agent, key)
	const ownership = agent.sql<{ armed_at: number }>`
		SELECT armed_at FROM brain_channel_observe
		WHERE channel_key = ${key} AND schedule_id = ${schedule.id}
	`[0]
	if (
		retry.exhausted &&
		(!ownership || !claimChannelProbe(agent, key, ownership.armed_at))
	) {
		finishOwnedChannelObserve(agent, key, schedule.id)
		return
	}

	try {
		const env = brainAgent(agent).env
		const ws = await getWorkspaceByTeamId(env, payload.teamId)
		if (!isOwned(agent, key, schedule.id)) return
		// The workspace may have been rebound to another org while this org's DO
		// still owned the schedule. Never write with a workspace we don't own.
		if (!ws?.installedByUserId || ws.orgId !== agent.name) {
			clearTerminalChannelObserve(agent, key, schedule.id)
			return
		}
		const installedByUserId = ws.installedByUserId
		const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
		const info = await getSlackConversationInfo(botToken, payload.channel)
		if (!isOwned(agent, key, schedule.id)) return
		if (!info) throw new Error("channel_info_unavailable")
		if (info.isPrivate !== false) {
			clearTerminalChannelObserve(agent, key, schedule.id)
			return
		}

		const cursor = getObserveCursor(agent, payload)
		const scanActive = Boolean(
			agent.sql<{ latest_ts: string }>`
				SELECT latest_ts FROM brain_channel_observe_scan WHERE channel_key = ${key}
			`[0],
		)
		const pendingCount =
			agent.sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM brain_channel_observe_pending
				WHERE channel_key = ${key} AND ts > ${cursor}
			`[0]?.count ?? 0
		if (scanActive || !pendingCount) {
			const scanResult = await spoolChannelPage(
				agent,
				botToken,
				payload,
				key,
				cursor,
				schedule.id,
				ws.botUserId,
			)
			if (scanResult === "stale") return
			if (scanResult !== "complete") {
				if (scanResult === "retry") {
					await retryOwnedChannelObserve(agent, payload, key, schedule.id)
				} else {
					clearChannelRetryState(agent, key)
					await rearmOwnedChannelObserve(
						agent,
						payload,
						schedule.id,
						CONTINUE_DELAY_SECONDS,
						0,
					)
				}
				return
			}
			clearChannelRetryState(agent, key)
		}

		const processResult = await processPendingBatch(
			agent,
			payload,
			key,
			schedule.id,
			ws,
			installedByUserId,
			botToken,
		)
		if (processResult === "stale") return
		if (processResult === "complete") {
			clearChannelRetryState(agent, key)
			finishOwnedChannelObserve(agent, key, schedule.id)
			return
		}
		if (processResult === "retry") {
			await retryOwnedChannelObserve(agent, payload, key, schedule.id)
			return
		}
		clearChannelRetryState(agent, key)
		await rearmOwnedChannelObserve(
			agent,
			payload,
			schedule.id,
			CONTINUE_DELAY_SECONDS,
			0,
		)
	} catch (err) {
		captureException(err instanceof Error ? err : new Error(String(err)), {
			tags: { component: "brain-channel-observe" },
		})
		await retryOwnedChannelObserve(agent, payload, key, schedule.id, err).catch(
			(rearmError) => {
				console.error(
					"[company-brain] channel-observe retry arm failed:",
					rearmError,
				)
			},
		)
	}
}
