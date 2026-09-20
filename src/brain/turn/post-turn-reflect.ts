import type { Schedule } from "agents"
import { captureException } from "@/lib/capture"
import {
	getBrainMemoryResetEpoch,
	isBrainMemoryResetEpochCurrent,
} from "../memory/tree"
import type { CompanyBrainAgent } from "./agent"
import { observeInteractionStyle } from "./interaction-observe"
import { advanceDurableRetry, canScheduleDurableRecovery } from "./retry-state"

export const POST_TURN_REFLECT_DELAY_SECONDS = 3 * 60
const POST_TURN_CONTINUE_DELAY_SECONDS = 1
const POST_TURN_RETRY_BASE_DELAY_SECONDS = 60
const POST_TURN_RETRY_MAX_DELAY_SECONDS = 15 * 60
const POST_TURN_MAX_RETRY_ATTEMPTS = 5
const POST_TURN_REPAIR_DELAYS_MS = [1000, 5000, 15_000] as const
let armSequence = 0

export type PostTurnReflectPayload = {
	teamId: string
	channel: string
	threadTs: string
	originTraceId?: string
	askerSlackUserId?: string
	retryAttempt?: number
	resetEpoch?: number
}

type ReflectRow = {
	thread_key: string
	schedule_id: string
	team_id: string
	channel: string
	thread_ts: string
	origin_trace_id: string | null
	asker_slack_user_id: string | null
	armed_at: number
	reset_epoch: number
}
type ReflectRetryRow = { attempt: number; exhausted: number }

export function postTurnReflectThreadKey(
	teamId: string,
	channel: string,
	threadTs: string,
): string {
	return `${teamId}:${channel}:${threadTs}`
}

function nextArmSequence(): number {
	armSequence = Math.max(armSequence + 1, Date.now() * 1000)
	return armSequence
}

export function ensurePostTurnReflectTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_post_turn_reflect (
			thread_key TEXT PRIMARY KEY,
			schedule_id TEXT NOT NULL,
			team_id TEXT NOT NULL,
			channel TEXT NOT NULL,
			thread_ts TEXT NOT NULL,
			origin_trace_id TEXT,
			asker_slack_user_id TEXT,
			armed_at INTEGER NOT NULL,
			reset_epoch INTEGER NOT NULL DEFAULT 0
		)
	`
	const ownershipColumns = agent.sql<{ name: string }>`
		PRAGMA table_info(brain_post_turn_reflect)
	`
	if (!ownershipColumns.some((column) => column.name === "reset_epoch")) {
		agent.sql`
			ALTER TABLE brain_post_turn_reflect
			ADD COLUMN reset_epoch INTEGER NOT NULL DEFAULT 0
		`
	}
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_post_turn_reflect_retry (
			thread_key TEXT PRIMARY KEY,
			attempt INTEGER NOT NULL,
			exhausted INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_post_turn_reflect_probe (
			thread_key TEXT PRIMARY KEY,
			armed_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`
}

function loadPostTurnRetryState(
	agent: CompanyBrainAgent,
	key: string,
): { attempt: number; exhausted: boolean } {
	const row = agent.sql<ReflectRetryRow>`
		SELECT attempt, exhausted FROM brain_post_turn_reflect_retry
		WHERE thread_key = ${key}
	`[0]
	return { attempt: row?.attempt ?? 0, exhausted: Boolean(row?.exhausted) }
}

function clearPostTurnRetryState(agent: CompanyBrainAgent, key: string): void {
	agent.sql`DELETE FROM brain_post_turn_reflect_retry WHERE thread_key = ${key}`
	agent.sql`DELETE FROM brain_post_turn_reflect_probe WHERE thread_key = ${key}`
}

function publishPostTurnProbe(
	agent: CompanyBrainAgent,
	key: string,
	armedAt: number,
): void {
	agent.sql`
		INSERT INTO brain_post_turn_reflect_probe (thread_key, armed_at, updated_at)
		VALUES (${key}, ${armedAt}, ${Date.now()})
		ON CONFLICT(thread_key) DO UPDATE SET
			armed_at = excluded.armed_at,
			updated_at = excluded.updated_at
	`
}

function isPostTurnProbeAllowed(
	agent: CompanyBrainAgent,
	key: string,
	armedAt: number,
): boolean {
	return Boolean(
		agent.sql<{ armed_at: number }>`
			SELECT armed_at FROM brain_post_turn_reflect_probe
			WHERE thread_key = ${key} AND armed_at = ${armedAt}
		`[0],
	)
}

function claimPostTurnProbe(
	agent: CompanyBrainAgent,
	key: string,
	armedAt: number,
): boolean {
	return Boolean(
		agent.sql<{ thread_key: string }>`
			DELETE FROM brain_post_turn_reflect_probe
			WHERE thread_key = ${key} AND armed_at = ${armedAt}
			RETURNING thread_key
		`[0],
	)
}

function persistPostTurnRetryState(
	agent: CompanyBrainAgent,
	key: string,
	attempt: number,
	exhausted: boolean,
): void {
	agent.sql`
		INSERT INTO brain_post_turn_reflect_retry (thread_key, attempt, exhausted, updated_at)
		VALUES (${key}, ${attempt}, ${exhausted ? 1 : 0}, ${Date.now()})
		ON CONFLICT(thread_key) DO UPDATE SET
			attempt = excluded.attempt,
			exhausted = excluded.exhausted,
			updated_at = excluded.updated_at
	`
	agent.sql`DELETE FROM brain_post_turn_reflect_probe WHERE thread_key = ${key}`
}

export async function cancelPostTurnReflect(
	agent: CompanyBrainAgent,
	teamId: string,
	channel: string,
	threadTs: string,
): Promise<void> {
	ensurePostTurnReflectTable(agent)
	const key = postTurnReflectThreadKey(teamId, channel, threadTs)
	const rows = agent.sql<ReflectRow>`
		SELECT thread_key, schedule_id, team_id, channel, thread_ts, origin_trace_id, asker_slack_user_id, armed_at, reset_epoch
		FROM brain_post_turn_reflect WHERE thread_key = ${key}
	`
	const row = rows[0]
	clearPostTurnRetryState(agent, key)
	if (!row) return
	agent.sql`
		DELETE FROM brain_post_turn_reflect
		WHERE thread_key = ${key} AND schedule_id = ${row.schedule_id}
	`
	await agent.cancelSchedule(row.schedule_id).catch(() => {})
}

async function schedulePostTurnReflect(
	agent: CompanyBrainAgent,
	payload: PostTurnReflectPayload,
	delaySeconds: number,
): Promise<Schedule<PostTurnReflectPayload>> {
	return agent.schedule(delaySeconds, "runPostTurnReflect", payload)
}

async function rearmOwnedPostTurnReflect(
	agent: CompanyBrainAgent,
	payload: PostTurnReflectPayload,
	key: string,
	ownedScheduleId: string,
	delaySeconds: number,
	retryAttempt: number,
): Promise<void> {
	let scheduled: Schedule<PostTurnReflectPayload>
	try {
		scheduled = await schedulePostTurnReflect(
			agent,
			{ ...payload, retryAttempt },
			delaySeconds,
		)
	} catch (err) {
		queuePostTurnReflectRepair(agent, key)
		console.error("[company-brain] post-turn-reflect schedule failed:", err)
		return
	}
	try {
		const updated = agent.sql<{ schedule_id: string }>`
			UPDATE brain_post_turn_reflect
			SET schedule_id = ${scheduled.id}
			WHERE thread_key = ${key} AND schedule_id = ${ownedScheduleId}
			RETURNING schedule_id
		`
		if (updated.length) return
	} catch (err) {
		await agent.cancelSchedule(scheduled.id).catch(() => {})
		queuePostTurnReflectRepair(agent, key)
		console.error(
			"[company-brain] post-turn-reflect ownership handoff failed:",
			err,
		)
		return
	}
	await agent.cancelSchedule(scheduled.id).catch(() => {})
}

function retryDelaySeconds(attempt: number): number {
	return Math.min(
		POST_TURN_RETRY_BASE_DELAY_SECONDS * 2 ** Math.max(0, attempt - 1),
		POST_TURN_RETRY_MAX_DELAY_SECONDS,
	)
}

async function retryOwnedPostTurnReflect(
	agent: CompanyBrainAgent,
	payload: PostTurnReflectPayload,
	key: string,
	scheduleId: string,
	error?: unknown,
): Promise<void> {
	if (!ownsPostTurnReflect(agent, key, scheduleId)) return
	const next = advanceDurableRetry(
		loadPostTurnRetryState(agent, key),
		POST_TURN_MAX_RETRY_ATTEMPTS,
	)
	persistPostTurnRetryState(
		agent,
		key,
		next.state.attempt,
		next.state.exhausted,
	)
	if (!next.shouldSchedule) {
		agent.sql`
			DELETE FROM brain_post_turn_reflect
			WHERE thread_key = ${key} AND schedule_id = ${scheduleId}
		`
		captureException(new Error("post_turn_reflect_retry_exhausted"), {
			tags: { component: "brain-self-observe" },
			extra: {
				teamId: payload.teamId,
				channel: payload.channel,
				threadTs: payload.threadTs,
				attempts: POST_TURN_MAX_RETRY_ATTEMPTS,
			},
		})
		console.error(
			`[company-brain] post-turn-reflect retries exhausted channel=${payload.channel} thread=${payload.threadTs}`,
			error instanceof Error ? error.name : "unknown",
		)
		return
	}
	await rearmOwnedPostTurnReflect(
		agent,
		payload,
		key,
		scheduleId,
		retryDelaySeconds(next.state.attempt),
		next.state.attempt,
	)
}

async function reconcilePostTurnReflectRow(
	agent: CompanyBrainAgent,
	key: string,
): Promise<boolean> {
	let scheduled: Schedule<PostTurnReflectPayload> | undefined
	try {
		const row = agent.sql<ReflectRow>`
			SELECT thread_key, schedule_id, team_id, channel, thread_ts, origin_trace_id, asker_slack_user_id, armed_at, reset_epoch
			FROM brain_post_turn_reflect WHERE thread_key = ${key}
		`[0]
		if (!row) return true
		const retry = loadPostTurnRetryState(agent, key)
		if (
			!canScheduleDurableRecovery(
				retry,
				isPostTurnProbeAllowed(agent, key, row.armed_at),
			)
		) {
			agent.sql`
				DELETE FROM brain_post_turn_reflect
				WHERE thread_key = ${key} AND schedule_id = ${row.schedule_id}
			`
			await agent.cancelSchedule(row.schedule_id).catch(() => {})
			return true
		}
		if (agent.getSchedules({ id: row.schedule_id }).length) return true
		scheduled = await schedulePostTurnReflect(
			agent,
			{
				teamId: row.team_id,
				channel: row.channel,
				threadTs: row.thread_ts,
				originTraceId: row.origin_trace_id ?? undefined,
				askerSlackUserId: row.asker_slack_user_id ?? undefined,
				retryAttempt: retry.attempt,
				resetEpoch: row.reset_epoch,
			},
			retry.attempt > 0 && !retry.exhausted
				? retryDelaySeconds(retry.attempt)
				: POST_TURN_CONTINUE_DELAY_SECONDS,
		)
		const updated = agent.sql<{ schedule_id: string }>`
			UPDATE brain_post_turn_reflect
			SET schedule_id = ${scheduled.id}
			WHERE thread_key = ${key} AND schedule_id = ${row.schedule_id}
			RETURNING schedule_id
		`
		if (updated.length) return true
		await agent.cancelSchedule(scheduled.id).catch(() => {})
		return true
	} catch (err) {
		if (scheduled) await agent.cancelSchedule(scheduled.id).catch(() => {})
		console.error("[company-brain] post-turn-reflect repair failed:", err)
		return false
	}
}

function queuePostTurnReflectRepair(
	agent: CompanyBrainAgent,
	key: string,
): void {
	agent.waitUntil(
		(async () => {
			for (const delayMs of POST_TURN_REPAIR_DELAYS_MS) {
				await new Promise((resolve) => setTimeout(resolve, delayMs))
				if (await reconcilePostTurnReflectRow(agent, key)) return
			}
		})().catch((err) => {
			console.error(
				"[company-brain] post-turn-reflect background repair failed:",
				err,
			)
		}),
	)
}

export async function reconcilePostTurnReflectSchedules(
	agent: CompanyBrainAgent,
): Promise<void> {
	ensurePostTurnReflectTable(agent)
	const rows = agent.sql<{ thread_key: string }>`
		SELECT thread_key FROM brain_post_turn_reflect
	`
	await Promise.all(
		rows.map(async (row) => {
			if (!(await reconcilePostTurnReflectRow(agent, row.thread_key))) {
				queuePostTurnReflectRepair(agent, row.thread_key)
			}
		}),
	)
}

async function attemptPostTurnReflectArm(
	agent: CompanyBrainAgent,
	payload: PostTurnReflectPayload,
	key: string,
	armedAt: number,
): Promise<boolean> {
	const existing = agent.sql<ReflectRow>`
		SELECT thread_key, schedule_id, team_id, channel, thread_ts, origin_trace_id, asker_slack_user_id, armed_at, reset_epoch
		FROM brain_post_turn_reflect WHERE thread_key = ${key}
	`[0]
	if (existing && existing.armed_at >= armedAt) return true
	const retry = loadPostTurnRetryState(agent, key)
	let scheduled: Schedule<PostTurnReflectPayload> | undefined
	try {
		scheduled = await schedulePostTurnReflect(
			agent,
			{ ...payload, retryAttempt: retry.attempt },
			POST_TURN_REFLECT_DELAY_SECONDS,
		)
		if (!isBrainMemoryResetEpochCurrent(agent, payload.resetEpoch ?? 0)) {
			await agent.cancelSchedule(scheduled.id).catch(() => false)
			return true
		}
		const persisted = Boolean(
			agent.sql<{ schedule_id: string }>`
				INSERT INTO brain_post_turn_reflect (
					thread_key, schedule_id, team_id, channel, thread_ts,
					origin_trace_id, asker_slack_user_id, armed_at, reset_epoch
				) VALUES (
					${key}, ${scheduled.id}, ${payload.teamId}, ${payload.channel}, ${payload.threadTs},
					${payload.originTraceId ?? null}, ${payload.askerSlackUserId ?? null}, ${armedAt}, ${payload.resetEpoch ?? 0}
				)
				ON CONFLICT(thread_key) DO UPDATE SET
					schedule_id = excluded.schedule_id,
					team_id = excluded.team_id,
					channel = excluded.channel,
					thread_ts = excluded.thread_ts,
					origin_trace_id = excluded.origin_trace_id,
					asker_slack_user_id = excluded.asker_slack_user_id,
					armed_at = excluded.armed_at,
					reset_epoch = excluded.reset_epoch
				WHERE brain_post_turn_reflect.armed_at <= excluded.armed_at
				RETURNING schedule_id
			`[0],
		)
		if (!persisted) {
			await agent.cancelSchedule(scheduled.id).catch(() => {})
			return true
		}
		if (loadPostTurnRetryState(agent, key).exhausted) {
			publishPostTurnProbe(agent, key, armedAt)
		}
		if (existing && existing.schedule_id !== scheduled.id) {
			await agent.cancelSchedule(existing.schedule_id).catch(() => {})
		}
		console.log(
			`[company-brain] post-turn-reflect armed delay=${POST_TURN_REFLECT_DELAY_SECONDS}s channel=${payload.channel} thread=${payload.threadTs} schedule=${scheduled.id} originTrace=${payload.originTraceId ?? "-"}`,
		)
		return true
	} catch (err) {
		if (scheduled) {
			try {
				agent.sql`
					DELETE FROM brain_post_turn_reflect
					WHERE thread_key = ${key} AND schedule_id = ${scheduled.id}
				`
			} catch {}
			await agent.cancelSchedule(scheduled.id).catch(() => {})
		}
		console.error("[company-brain] post-turn-reflect initial arm failed:", err)
		return false
	}
}

function queuePostTurnReflectArmRetry(
	agent: CompanyBrainAgent,
	payload: PostTurnReflectPayload,
	key: string,
	armedAt: number,
): void {
	agent.waitUntil(
		(async () => {
			for (const delayMs of POST_TURN_REPAIR_DELAYS_MS) {
				await new Promise((resolve) => setTimeout(resolve, delayMs))
				if (await attemptPostTurnReflectArm(agent, payload, key, armedAt)) {
					return
				}
			}
		})().catch((err) => {
			console.error("[company-brain] post-turn-reflect arm repair failed:", err)
		}),
	)
}

function ownsPostTurnReflect(
	agent: CompanyBrainAgent,
	key: string,
	scheduleId: string,
): boolean {
	return Boolean(
		agent.sql<{ schedule_id: string }>`
			SELECT schedule_id FROM brain_post_turn_reflect
			WHERE thread_key = ${key} AND schedule_id = ${scheduleId}
		`[0],
	)
}

export async function armPostTurnReflect(
	agent: CompanyBrainAgent,
	payload: PostTurnReflectPayload,
): Promise<void> {
	ensurePostTurnReflectTable(agent)
	const epochPayload = {
		...payload,
		resetEpoch: getBrainMemoryResetEpoch(agent),
	}
	const key = postTurnReflectThreadKey(
		epochPayload.teamId,
		epochPayload.channel,
		epochPayload.threadTs,
	)
	const armedAt = nextArmSequence()
	if (!(await attemptPostTurnReflectArm(agent, epochPayload, key, armedAt))) {
		queuePostTurnReflectArmRetry(agent, epochPayload, key, armedAt)
	}
}

export async function runPostTurnReflect(
	agent: CompanyBrainAgent,
	payload: PostTurnReflectPayload,
	schedule: Schedule<PostTurnReflectPayload>,
): Promise<void> {
	ensurePostTurnReflectTable(agent)
	const key = postTurnReflectThreadKey(
		payload.teamId,
		payload.channel,
		payload.threadTs,
	)
	const row = agent.sql<ReflectRow>`
		SELECT thread_key, schedule_id, team_id, channel, thread_ts, origin_trace_id, asker_slack_user_id, armed_at, reset_epoch
		FROM brain_post_turn_reflect WHERE thread_key = ${key}
	`[0]
	if (!row || row.schedule_id !== schedule.id) {
		console.log(
			`[company-brain] post-turn-reflect skip stale channel=${payload.channel} thread=${payload.threadTs} schedule=${schedule.id}`,
		)
		return
	}
	if (!isBrainMemoryResetEpochCurrent(agent, payload.resetEpoch ?? 0)) {
		agent.sql`
			DELETE FROM brain_post_turn_reflect
			WHERE thread_key = ${key} AND schedule_id = ${schedule.id}
		`
		return
	}
	const retry = loadPostTurnRetryState(agent, key)
	if (retry.exhausted && !claimPostTurnProbe(agent, key, row.armed_at)) {
		agent.sql`
			DELETE FROM brain_post_turn_reflect
			WHERE thread_key = ${key} AND schedule_id = ${schedule.id}
		`
		return
	}
	try {
		const result = await observeInteractionStyle(agent, payload, () =>
			ownsPostTurnReflect(agent, key, schedule.id),
		)
		if (result === "stale") return
		if (result === "continue" || result === "retry") {
			if (result === "retry") {
				await retryOwnedPostTurnReflect(agent, payload, key, schedule.id)
			} else {
				clearPostTurnRetryState(agent, key)
				await rearmOwnedPostTurnReflect(
					agent,
					payload,
					key,
					schedule.id,
					POST_TURN_CONTINUE_DELAY_SECONDS,
					0,
				)
			}
			return
		}
		clearPostTurnRetryState(agent, key)
		agent.sql`
			DELETE FROM brain_post_turn_reflect
			WHERE thread_key = ${key} AND schedule_id = ${schedule.id}
		`
	} catch (err) {
		console.error("[company-brain] post-turn-reflect observe failed:", err)
		await retryOwnedPostTurnReflect(
			agent,
			payload,
			key,
			schedule.id,
			err,
		).catch((rearmError) => {
			console.error(
				"[company-brain] post-turn-reflect retry arm failed:",
				rearmError,
			)
		})
	}
}
