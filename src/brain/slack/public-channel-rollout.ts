import { and, db, eq, inArray } from "@repo/db"
import { organization } from "@repo/db/schema/auth"
import { generateId } from "@repo/lib/generate-id"
import { documentStatuses } from "../../memory/memories"
import * as Effect from "effect/Effect"
import { makeAppLayer } from "@/config"
import { decryptToken } from "@/lib/crypto"
import { orgCanRunCompanyBrain } from "@/lib/payments/company-brain-entitlement"
import { captureActivationRung } from "@/lib/posthog"
import { SHARED_TEAM_BRAIN_CONTAINER_TAG } from "@/lib/spaces/provisioning"
import { addMemorySingle } from "@/routes/memories/handler-effect"
import {
	PUBLIC_CHANNEL_ROLLOUT_ACTION_ID,
	PUBLIC_CHANNEL_ROLLOUT_DAYS,
} from "../constants"
import { maybeSyncBrainProfileConfig } from "../memory/profile-sync"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { normalizeSlackMessageContent } from "./attachments"
import { invalidateChannelDirectory } from "./channel-directory"
import {
	composeChannelIntroduction,
	extractChannelThemes,
} from "./channel-introduction"
import {
	getSlackChannelHistoryPage,
	getSlackThreadHistoryPage,
	joinSlackPublicChannel,
	listSlackPublicChannelsPage,
	lookupSlackUserInfo,
	openSlackConversation,
	postSlackEphemeral,
	postSlackMessage,
	postSlackMessageIdempotent,
	type SlackThreadMessage,
	updateSlackMessage,
} from "./client"
import {
	type ChannelTheme,
	crosscheckThemesWithConnectedTools,
	type ToolCrosscheck,
} from "./connected-tool-crosscheck"
import {
	buildSlackHistoryDocuments,
	recentSlackChannelEvidence,
} from "./history-document"
import { isEligiblePublicChannel } from "./public-channel-policy"
import { isSlackHistoryThreadRoot } from "./public-channel-thread-root"
import {
	escapeSlackText,
	getOrgActorBySlackIdentity,
	getWorkspaceByTeamId,
	type SlackWorkspaceRow,
	slackUserDisplayName,
} from "./workspace"

const REQUIRED_SCOPES = [
	"channels:history",
	"channels:join",
	"channels:read",
	"chat:write",
	"users:read",
	"users:read.email",
]
const NEXT_STEP_DELAY_SECONDS = 1
const MEMORY_POLL_DELAY_SECONDS = 30
const MAX_STAGE_ATTEMPTS = 5
const MAX_RUN_FAILURES = 10
const MAX_MEMORY_WAIT_MS = 24 * 60 * 60 * 1000
const CROSSCHECK_CHANNEL_BATCH = 8
const HOME_WELCOME_BUBBLE_DELAY_MS = 1000

export type PublicChannelRolloutStart = {
	teamId: string
	homeChannelId: string
	slackUserId: string
}

export type PublicChannelRolloutPayload = { runId: string }

export type PublicChannelBeachhead = {
	teamId: string
	installerSlackUserId?: string
	/** Dormant-org revival sends the notice as a DM too; nobody watches those home channels. */
	notifyInstallerDm?: boolean
}

// Let the install greeting land before the join notice follows it.
const BEACHHEAD_DELAY_SECONDS = 5 * 60
const BEACHHEAD_CHANNEL_COUNT = 2

export type AdminRolloutCardPayload = {
	teamId: string
	installerSlackUserId?: string
}

export type PublicChannelRolloutCardPayload = {
	teamId: string
	homeChannelId: string
	installerSlackUserId?: string
	welcome?: {
		version: number
		messages: string[]
	}
}

type RolloutRow = {
	run_id: string
	team_id: string
	home_channel_id: string
	status: "running" | "done" | "failed"
	phase: "discover" | "join" | "collect" | "crosscheck" | "introduce"
	actor_user_id: string
	actor_slack_user_id: string
	actor_name: string
	window_start_ms: number
	window_end_ms: number
	list_cursor: string | null
	configured_servers_json: string
	used_servers_json: string
	failure_count: number
	last_error: string | null
	channel_filter_json: string | null
	created_at: number
	updated_at: number
}

type RolloutChannelRow = {
	run_id: string
	channel_id: string
	name: string
	topic: string | null
	purpose: string | null
	was_member: number
	already_introduced: number
	theme_only: number
	join_status: "pending" | "joined" | "failed"
	stage:
		| "history"
		| "threads"
		| "package"
		| "enqueue"
		| "crosscheck"
		| "wait_memory"
		| "done"
		| "failed"
	history_cursor: string | null
	theme_json: string
	check_json: string
	intro_client_id: string
	intro_ts: string | null
	attempts: number
	last_error: string | null
	created_at: number
	updated_at: number
}

type RolloutThreadRow = {
	thread_ts: string
	cursor: string | null
	status: "pending" | "reading" | "done" | "failed"
	attempts: number
}

type RolloutDocumentRow = {
	custom_id: string
	ord: number
	content: string | null
	metadata_json: string
	document_id: string | null
	status: "pending" | "submitted" | "done" | "failed"
	attempts: number
	submitted_at: number | null
}

type CardRow = {
	team_id: string
	home_channel_id: string
	message_ts: string
	admin_channel_id: string | null
	admin_message_ts: string | null
	updated_at: number
}

type HomeWelcomeRow = {
	team_id: string
	home_channel_id: string
	version: number
	next_message_index: number
	completed_at: number | null
}

export function ensurePublicChannelRolloutTables(
	agent: CompanyBrainAgent,
): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_public_channel_rollout_card (
			id INTEGER PRIMARY KEY,
			team_id TEXT NOT NULL,
			home_channel_id TEXT NOT NULL,
			message_ts TEXT NOT NULL,
			admin_channel_id TEXT,
			admin_message_ts TEXT,
			updated_at INTEGER NOT NULL
		)
	`
	try {
		agent.sql`ALTER TABLE brain_public_channel_rollout_card ADD COLUMN admin_channel_id TEXT`
	} catch {}
	try {
		agent.sql`ALTER TABLE brain_public_channel_rollout_card ADD COLUMN admin_message_ts TEXT`
	} catch {}
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_home_welcome (
			id INTEGER PRIMARY KEY,
			team_id TEXT NOT NULL,
			home_channel_id TEXT NOT NULL,
			version INTEGER NOT NULL,
			next_message_index INTEGER NOT NULL DEFAULT 0,
			completed_at INTEGER
		)
	`
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_public_channel_rollout (
			id INTEGER PRIMARY KEY,
			run_id TEXT NOT NULL,
			team_id TEXT NOT NULL,
			home_channel_id TEXT NOT NULL,
			status TEXT NOT NULL,
			phase TEXT NOT NULL,
			actor_user_id TEXT NOT NULL,
			actor_slack_user_id TEXT NOT NULL,
			actor_name TEXT NOT NULL,
			window_start_ms INTEGER NOT NULL,
			window_end_ms INTEGER NOT NULL,
			list_cursor TEXT,
			configured_servers_json TEXT NOT NULL DEFAULT '[]',
			used_servers_json TEXT NOT NULL DEFAULT '[]',
			failure_count INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			channel_filter_json TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`
	try {
		agent.sql`ALTER TABLE brain_public_channel_rollout ADD COLUMN channel_filter_json TEXT`
	} catch {}
	try {
		agent.sql`ALTER TABLE brain_public_channel_rollout_channel ADD COLUMN theme_only INTEGER NOT NULL DEFAULT 0`
	} catch {}
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_public_channel_rollout_channel (
			run_id TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			name TEXT NOT NULL,
			topic TEXT,
			purpose TEXT,
			was_member INTEGER NOT NULL DEFAULT 0,
			already_introduced INTEGER NOT NULL DEFAULT 0,
			theme_only INTEGER NOT NULL DEFAULT 0,
			join_status TEXT NOT NULL DEFAULT 'pending',
			stage TEXT NOT NULL DEFAULT 'history',
			history_cursor TEXT,
			theme_json TEXT NOT NULL DEFAULT '[]',
			check_json TEXT NOT NULL DEFAULT '[]',
			intro_client_id TEXT NOT NULL,
			intro_ts TEXT,
			attempts INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (run_id, channel_id)
		)
	`
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_public_channel_rollout_thread (
			run_id TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			thread_ts TEXT NOT NULL,
			cursor TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			attempts INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (run_id, channel_id, thread_ts)
		)
	`
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_public_channel_rollout_message (
			run_id TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			ts TEXT NOT NULL,
			user_id TEXT,
			text TEXT,
			bot_id TEXT,
			subtype TEXT,
			app_id TEXT,
			thread_ts TEXT,
			reply_count INTEGER,
			files_json TEXT NOT NULL DEFAULT '[]',
			reactions_json TEXT NOT NULL DEFAULT '[]',
			PRIMARY KEY (run_id, channel_id, ts)
		)
	`
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_public_channel_rollout_document (
			run_id TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			custom_id TEXT NOT NULL,
			ord INTEGER NOT NULL DEFAULT 0,
			content TEXT,
			metadata_json TEXT NOT NULL,
			document_id TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			attempts INTEGER NOT NULL DEFAULT 0,
			submitted_at INTEGER,
			PRIMARY KEY (run_id, channel_id, custom_id)
		)
	`
	const documentColumns = agent.sql<{ name: string }>`
		PRAGMA table_info(brain_public_channel_rollout_document)
	`
	if (!documentColumns.some((column) => column.name === "ord")) {
		agent.sql`
			ALTER TABLE brain_public_channel_rollout_document
			ADD COLUMN ord INTEGER NOT NULL DEFAULT 0
		`
	}
	agent.sql`
		CREATE INDEX IF NOT EXISTS idx_brain_public_rollout_channel_stage
		ON brain_public_channel_rollout_channel (run_id, stage, join_status, name)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS idx_brain_public_rollout_thread_status
		ON brain_public_channel_rollout_thread (run_id, channel_id, status, thread_ts)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS idx_brain_public_rollout_document_status
		ON brain_public_channel_rollout_document (run_id, channel_id, status, ord)
	`
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_public_channel_introduction (
			team_id TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			intro_ts TEXT NOT NULL,
			introduced_at INTEGER NOT NULL,
			theme_json TEXT,
			PRIMARY KEY (team_id, channel_id)
		)
	`
	try {
		agent.sql`ALTER TABLE brain_public_channel_introduction ADD COLUMN theme_json TEXT`
		// Backfill once, on the ALTER.
		agent.sql`
			UPDATE brain_public_channel_introduction
			SET theme_json = (
				SELECT c.theme_json FROM brain_public_channel_rollout_channel c
				WHERE c.channel_id = brain_public_channel_introduction.channel_id
					AND c.theme_json IS NOT NULL AND c.theme_json != '[]'
				LIMIT 1
			)
			WHERE theme_json IS NULL
		`
	} catch {}
}

function parseJsonArray<T>(value: string | null | undefined): T[] {
	try {
		const parsed = JSON.parse(value ?? "[]") as unknown
		return Array.isArray(parsed) ? (parsed as T[]) : []
	} catch {
		return []
	}
}

function rolloutErrorCode(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error)
	return /^[a-z0-9_:.-]{1,160}$/i.test(message)
		? message
		: error instanceof Error
			? error.name
			: "unknown_error"
}

function currentRun(agent: CompanyBrainAgent): RolloutRow | undefined {
	return agent.sql<RolloutRow>`
		SELECT run_id, team_id, home_channel_id, status, phase, actor_user_id,
			actor_slack_user_id, actor_name, window_start_ms, window_end_ms,
			list_cursor, configured_servers_json, used_servers_json,
			failure_count, last_error, channel_filter_json, created_at, updated_at
		FROM brain_public_channel_rollout WHERE id = 1
	`[0]
}

function rolloutCard(agent: CompanyBrainAgent): CardRow | undefined {
	return agent.sql<CardRow>`
		SELECT team_id, home_channel_id, message_ts, admin_channel_id, admin_message_ts, updated_at
		FROM brain_public_channel_rollout_card WHERE id = 1
	`[0]
}

async function ensureHomeWelcome(
	agent: CompanyBrainAgent,
	botToken: string,
	payload: PublicChannelRolloutCardPayload,
): Promise<void> {
	const supplied = payload.welcome
	if (!supplied) return
	const messages = supplied.messages
		.flatMap((message) => {
			const trimmed = message.trim()
			return trimmed ? [trimmed] : []
		})
		.slice(0, 8)
	if (!messages.length) return
	const version = Number.isFinite(supplied.version)
		? Math.max(1, Math.floor(supplied.version))
		: 1
	let row = agent.sql<HomeWelcomeRow>`
		SELECT team_id, home_channel_id, version, next_message_index, completed_at
		FROM brain_home_welcome WHERE id = 1
	`[0]
	if (
		!row ||
		row.team_id !== payload.teamId ||
		row.home_channel_id !== payload.homeChannelId ||
		row.version !== version
	) {
		agent.sql`
			INSERT INTO brain_home_welcome (
				id, team_id, home_channel_id, version, next_message_index, completed_at
			) VALUES (1, ${payload.teamId}, ${payload.homeChannelId}, ${version}, 0, NULL)
			ON CONFLICT(id) DO UPDATE SET
				team_id = excluded.team_id,
				home_channel_id = excluded.home_channel_id,
				version = excluded.version,
				next_message_index = 0,
				completed_at = NULL
		`
		row = agent.sql<HomeWelcomeRow>`
			SELECT team_id, home_channel_id, version, next_message_index, completed_at
			FROM brain_home_welcome WHERE id = 1
		`[0]
	}
	if (row?.completed_at && row.next_message_index >= messages.length) return

	const nextMessageIndex = Math.min(
		Math.max(Number(row?.next_message_index ?? 0), 0),
		messages.length,
	)
	for (let index = nextMessageIndex; index < messages.length; index++) {
		const message = messages[index]
		if (!message) continue
		const ts = await postSlackMessage(botToken, payload.homeChannelId, message)
		if (!ts) throw new Error(`home_welcome_message_${index + 1}_failed`)
		agent.sql`
			UPDATE brain_home_welcome
			SET next_message_index = ${index + 1}
			WHERE id = 1
		`
		if (index < messages.length - 1) {
			await new Promise((resolve) =>
				setTimeout(resolve, HOME_WELCOME_BUBBLE_DELAY_MS),
			)
		}
	}
	const completedAt = Date.now()
	agent.sql`
		UPDATE brain_home_welcome
		SET next_message_index = ${messages.length}, completed_at = ${completedAt}
		WHERE id = 1
	`
}

// Channel messages look the same to everyone, so only the DM copy has the button.
export function publicChannelRolloutCardBlocks(args: {
	status: "idle" | "running" | "done" | "failed"
	/** Beachhead run context; absent for full-workspace runs. */
	beachhead?: { channelIds: string[]; readoutPosted?: boolean }
	/** Set on the admin DM copy, which carries the button. */
	admin?: { homeChannelId: string }
}): unknown[] {
	const refs = args.beachhead?.channelIds.map((id) => `<#${id}>`).join(" and ")
	const here = args.admin ? `in <#${args.admin.homeChannelId}>` : "here"
	const readoutAt = args.admin
		? `in <#${args.admin.homeChannelId}>`
		: "just below"
	const body =
		args.status === "idle"
			? `I'll join your most active public channels shortly and post what I learn ${here}, so everyone gets a feel for what I'm good for. Invite me to any channel yourself, or an admin can add me across all of them at once.`
			: args.status === "running"
				? args.beachhead
					? `Joining ${refs}, your busiest channels. First read-out ${here} within the hour.\n_Remove me from any channel and I'll stay out._`
					: `Adding me across your public channels. I'll check in ${here} once I'm caught up.`
				: args.status === "done"
					? args.beachhead
						? args.beachhead.readoutPosted
							? `Caught up on ${refs} — read-out ${readoutAt}.`
							: `I've read the last ${PUBLIC_CHANNEL_ROLLOUT_DAYS} days of ${refs}. Quiet week there, so not much to report yet, but I'm caught up and ready for questions.`
						: "I'm across your public channels and caught up."
					: "I hit a snag getting into channels. An admin can start me off again."

	const buttonLabel = !args.admin
		? null
		: args.status === "idle" || args.status === "failed"
			? "Add me to my public channels"
			: args.status === "done"
				? args.beachhead
					? "Add me to the rest of my channels"
					: "Check for new public channels"
				: null

	const check =
		args.status === "done" ? " ✅" : args.status === "failed" ? " ⚠️" : ""
	return [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `*Getting to know your Slack*${check}\n${body}`,
			},
		},
		...(buttonLabel
			? [
					{
						type: "actions",
						elements: [
							{
								type: "button",
								action_id: PUBLIC_CHANNEL_ROLLOUT_ACTION_ID,
								value: "start",
								style: "primary",
								text: { type: "plain_text", text: buttonLabel, emoji: true },
							},
						],
					},
				]
			: []),
	]
}

export type PublicChannelRolloutOverview = {
	status: "running" | "done" | "failed"
	discovered: number
	joined: number
	ready: number
	introduced: number
	failed: number
}

// Read-only snapshot for /brain/overview; null until a rollout has ever started.
export function getPublicChannelRolloutOverview(
	agent: CompanyBrainAgent,
): PublicChannelRolloutOverview | null {
	ensurePublicChannelRolloutTables(agent)
	const run = currentRun(agent)
	if (!run) return null
	return { status: run.status, ...rolloutCounts(agent, run.run_id) }
}

function rolloutCounts(agent: CompanyBrainAgent, runId: string) {
	const [counts] = agent.sql<{
		discovered: number
		joined: number
		ready: number
		introduced: number
		failed: number
	}>`
		SELECT
			COUNT(*) AS discovered,
			SUM(CASE WHEN join_status = 'joined' THEN 1 ELSE 0 END) AS joined,
			SUM(CASE WHEN stage = 'done' THEN 1 ELSE 0 END) AS ready,
			SUM(CASE WHEN intro_ts IS NOT NULL THEN 1 ELSE 0 END) AS introduced,
			SUM(CASE WHEN stage = 'failed' THEN 1 ELSE 0 END) AS failed
		FROM brain_public_channel_rollout_channel WHERE run_id = ${runId}
	`
	return {
		discovered: Number(counts?.discovered ?? 0),
		joined: Number(counts?.joined ?? 0),
		ready: Number(counts?.ready ?? 0),
		introduced: Number(counts?.introduced ?? 0),
		failed: Number(counts?.failed ?? 0),
	}
}

async function refreshRolloutCard(
	agent: CompanyBrainAgent,
	botToken: string,
	status: "running" | "done" | "failed",
): Promise<void> {
	const run = currentRun(agent)
	const card = rolloutCard(agent)
	if (!run || !card) return
	const channelIds = run.channel_filter_json
		? parseJsonArray<string>(run.channel_filter_json)
		: null
	// The read-out only posts when themes exist, so theme presence decides copy.
	const hasThemes = channelIds
		? agent.sql<{ n: number }>`
			SELECT COUNT(*) AS n FROM brain_public_channel_rollout_channel
			WHERE run_id = ${run.run_id} AND stage = 'done' AND theme_json != '[]'
		`[0]
		: undefined
	const beachhead = channelIds?.length
		? {
				beachhead: {
					channelIds,
					readoutPosted: Number(hasThemes?.n ?? 0) > 0,
				},
			}
		: {}
	await updateSlackMessage(
		botToken,
		card.home_channel_id,
		card.message_ts,
		"Getting to know your Slack",
		publicChannelRolloutCardBlocks({ status, ...beachhead }),
	)
	if (card.admin_channel_id && card.admin_message_ts) {
		await updateSlackMessage(
			botToken,
			card.admin_channel_id,
			card.admin_message_ts,
			"Getting to know your Slack",
			publicChannelRolloutCardBlocks({
				status,
				...beachhead,
				admin: { homeChannelId: card.home_channel_id },
			}),
		)
	}
	agent.sql`
		UPDATE brain_public_channel_rollout_card SET updated_at = ${Date.now()}
		WHERE id = 1
	`
}

export async function ensurePublicChannelRolloutCard(
	agent: CompanyBrainAgent,
	payload: PublicChannelRolloutCardPayload,
): Promise<void> {
	ensurePublicChannelRolloutTables(agent)
	const existing = rolloutCard(agent)
	const env = brainAgent(agent).env
	const ws = await getWorkspaceByTeamId(env, payload.teamId)
	if (!ws || ws.orgId !== agent.name) return
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	await ensureHomeWelcome(agent, botToken, payload)
	if (
		existing?.team_id === payload.teamId &&
		existing.home_channel_id === payload.homeChannelId
	) {
		return
	}
	const ts = await postSlackMessage(
		botToken,
		payload.homeChannelId,
		"Getting to know your Slack",
		undefined,
		publicChannelRolloutCardBlocks({ status: "idle" }),
	)
	if (!ts) return
	agent.sql`
		INSERT INTO brain_public_channel_rollout_card (id, team_id, home_channel_id, message_ts, updated_at)
		VALUES (1, ${payload.teamId}, ${payload.homeChannelId}, ${ts}, ${Date.now()})
		ON CONFLICT(id) DO UPDATE SET
			team_id = excluded.team_id,
			home_channel_id = excluded.home_channel_id,
			message_ts = excluded.message_ts,
			updated_at = excluded.updated_at
	`
}

/**
 * The installer's DM copy, the one with the button. Posted from the greeting
 * flow rather than bootstrap so it lands after the introduction instead of
 * opening the DM with a button from a bot that has not said hello yet.
 */
export async function ensureAdminRolloutCard(
	agent: CompanyBrainAgent,
	payload: AdminRolloutCardPayload,
): Promise<void> {
	ensurePublicChannelRolloutTables(agent)
	const card = rolloutCard(agent)
	if (!card || card.admin_channel_id) return
	const env = brainAgent(agent).env
	const ws = await getWorkspaceByTeamId(env, payload.teamId)
	if (!ws || ws.orgId !== agent.name) return
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	const admin = await postAdminRolloutCard(botToken, {
		teamId: payload.teamId,
		homeChannelId: card.home_channel_id,
		installerSlackUserId: payload.installerSlackUserId,
	})
	if (!admin) return
	agent.sql`
		UPDATE brain_public_channel_rollout_card
		SET admin_channel_id = ${admin.channelId}, admin_message_ts = ${admin.messageTs}, updated_at = ${Date.now()}
		WHERE id = 1
	`
	const run = currentRun(agent)
	if (run) await refreshRolloutCard(agent, botToken, run.status)
}

// The installer is the only admin we can resolve to a Slack DM at install time.
async function postAdminRolloutCard(
	botToken: string,
	payload: PublicChannelRolloutCardPayload,
): Promise<{ channelId: string; messageTs: string } | null> {
	if (!payload.installerSlackUserId) return null
	const channelId = await openSlackConversation(
		botToken,
		payload.installerSlackUserId,
	)
	if (!channelId) return null
	const messageTs = await postSlackMessage(
		botToken,
		channelId,
		"Getting to know your Slack",
		undefined,
		publicChannelRolloutCardBlocks({
			status: "idle",
			admin: { homeChannelId: payload.homeChannelId },
		}),
	)
	return messageTs ? { channelId, messageTs } : null
}

function grantedScopes(scopes: string | null): Set<string> {
	return new Set(
		(scopes ?? "")
			.split(/[ ,]+/)
			.map((scope) => scope.trim())
			.filter(Boolean),
	)
}

function organizationMetadata(metadata: unknown): Record<string, unknown> {
	if (typeof metadata === "string") {
		try {
			const parsed = JSON.parse(metadata) as unknown
			if (parsed && typeof parsed === "object") {
				return parsed as Record<string, unknown>
			}
		} catch {}
	}
	return metadata && typeof metadata === "object"
		? (metadata as Record<string, unknown>)
		: {}
}

function rolloutActorName(value: string): string {
	return (
		value
			.replace(/[<>&\r\n]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 80) || "your admin"
	)
}

// Never auto-picked; the admin-initiated full rollout may still include them.
const BEACHHEAD_NAME_BLOCKLIST =
	/(^|[-_])(hr|people|finance|legal|security|compliance|incident|salar|payroll|comp)([-_]|$)/i
// Not blocked, just last in line: only picked when no work channel qualifies.
const BEACHHEAD_SOCIAL_NAMES =
	/(^|[-_])(random|social|watercooler|memes|fun|offtopic|celebration|celebrations)([-_]|$)/i

export async function armPublicChannelBeachhead(
	agent: CompanyBrainAgent,
	payload: PublicChannelBeachhead,
): Promise<void> {
	ensurePublicChannelRolloutTables(agent)
	await agent.schedule(
		BEACHHEAD_DELAY_SECONDS,
		"runPublicChannelBeachhead",
		payload,
	)
}

export async function runPublicChannelBeachhead(
	agent: CompanyBrainAgent,
	payload: PublicChannelBeachhead,
): Promise<void> {
	ensurePublicChannelRolloutTables(agent)
	const bail = (reason: string) =>
		console.log(
			`[company-brain] beachhead skipped org=${agent.name} team=${payload.teamId} reason=${reason}`,
		)
	const card = rolloutCard(agent)
	if (!card) return bail("no_card")
	const active = currentRun(agent)
	// A prior finished run means channels were already handled; only block on those.
	if (active) return bail(`run_exists_${active.status}`)

	const env = brainAgent(agent).env
	const ws = await getWorkspaceByTeamId(env, payload.teamId)
	if (!ws || ws.orgId !== agent.name) return bail("workspace_mismatch")
	if (
		!(await orgCanRunCompanyBrain(env, ws.orgId, (promise) =>
			agent.waitUntil(promise),
		))
	)
		return bail("entitlement")

	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	const scopes = grantedScopes(ws.scopes)
	if (REQUIRED_SCOPES.some((scope) => !scopes.has(scope)))
		return bail("missing_scopes")

	const picks = await pickBeachheadChannels(botToken, card.home_channel_id)
	if (!picks.length) return bail("no_eligible_channels")

	const profile = await lookupSlackUserInfo(
		botToken,
		payload.installerSlackUserId ?? "",
	)
	const actorUserId = profile.ok
		? (
				await getOrgActorBySlackIdentity(env, {
					orgId: ws.orgId,
					teamId: payload.teamId,
					slackUserId: payload.installerSlackUserId as string,
					email: profile.user.email,
				})
			).actor?.userId
		: undefined
	// The installer may have left; the run still needs an owner for attribution.
	const runActorUserId = actorUserId ?? ws.installedByUserId
	if (!runActorUserId) return bail("no_actor")

	// The card's "joining <#a> and <#b>" state is the notice; dormant orgs get a DM.
	if (payload.notifyInstallerDm && payload.installerSlackUserId) {
		const channelRefs = picks.map((c) => `<#${c.id}>`).join(" and ")
		await dmSlackUserSafe(
			botToken,
			payload.installerSlackUserId,
			`I'm joining ${channelRefs}, your busiest ${picks.length === 1 ? "channel" : "channels"}, so I can actually be useful. First read-out in <#${card.home_channel_id}> within the hour. Remove me from a channel anytime and I'll stay out.`,
		)
	}

	await beginRolloutRun(agent, {
		ws,
		botToken,
		teamId: payload.teamId,
		homeChannelId: card.home_channel_id,
		actorUserId: runActorUserId,
		actorSlackUserId: payload.installerSlackUserId,
		actorName: profile.ok
			? rolloutActorName(
					slackUserDisplayName(profile.user) ??
						profile.user.email?.split("@")[0] ??
						"your admin",
				)
			: "Supermemory",
		channelFilter: picks.map((c) => c.id),
	})
	console.log(
		`[company-brain] beachhead join started org=${agent.name} team=${payload.teamId} channels=${picks.map((c) => c.name).join(",")}`,
	)
}

async function pickBeachheadChannels(
	botToken: string,
	homeChannelId: string,
): Promise<Array<{ id: string; name: string }>> {
	const candidates: Array<{
		id: string
		name: string
		members: number
		social: boolean
	}> = []
	let cursor: string | undefined
	for (let pageNum = 0; pageNum < 25; pageNum++) {
		const page = await listSlackPublicChannelsPage(botToken, { cursor })
		if (!page.ok) return []
		for (const channel of page.items) {
			if (!isEligiblePublicChannel(channel, { homeChannelId })) continue
			if (channel.isMember) continue
			if (BEACHHEAD_NAME_BLOCKLIST.test(channel.name)) continue
			candidates.push({
				id: channel.id,
				name: channel.name,
				members: channel.memberCount ?? 0,
				social: BEACHHEAD_SOCIAL_NAMES.test(channel.name),
			})
		}
		if (page.complete) break
		cursor = page.nextCursor
	}
	return candidates
		.sort((a, b) =>
			a.social === b.social ? b.members - a.members : a.social ? 1 : -1,
		)
		.slice(0, BEACHHEAD_CHANNEL_COUNT)
}

// The payoff that earns the wider ask. Posts only when there are real themes;
// a quiet week is reported on the card instead, without a notification.
// Slack only honors client_msg_id for UUID-shaped ids; derive one from the run
// id so retries reuse it without persisting another column.
async function deterministicUuid(seed: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(seed),
	)
	const bytes = Array.from(new Uint8Array(digest).slice(0, 16))
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
	const hex = bytes.map((x) => x.toString(16).padStart(2, "0")).join("")
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function postBeachheadReadout(
	agent: CompanyBrainAgent,
	run: RolloutRow,
	botToken: string,
): Promise<{ ok: boolean; retryAfterSeconds?: number; error?: string }> {
	const channels = agent.sql<{
		channel_id: string
		name: string
		theme_json: string
	}>`
		SELECT channel_id, name, theme_json
		FROM brain_public_channel_rollout_channel
		WHERE run_id = ${run.run_id} AND stage = 'done'
		ORDER BY name ASC
	`
	const sections: string[] = []
	for (const channel of channels) {
		const themes = parseJsonArray<ChannelTheme>(channel.theme_json).slice(0, 3)
		if (!themes.length) continue
		// Model output from channel content: escape so it cannot mint <!channel>.
		const bullets = themes
			.map(
				(theme) =>
					`*${escapeSlackText(theme.title)}* — ${escapeSlackText(theme.summary)}`,
			)
			.join("\n")
		sections.push(`*<#${channel.channel_id}>*\n${bullets}`)
	}
	if (!sections.length) return { ok: true }

	const refs = channels.map((c) => `<#${c.channel_id}>`).join(" and ")
	const posted = await postSlackMessageIdempotent(
		botToken,
		run.home_channel_id,
		`Here's what I learned from ${refs}`,
		await deterministicUuid(`beachhead-readout:${run.run_id}`),
		[
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `*Here's what I learned from ${refs}*\n\n${sections.join("\n\n")}`,
				},
			},
			{
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: "That's two channels. An admin can add me to the rest, or invite me to any channel yourself.",
					},
				],
			},
		],
	)
	return posted.ok
		? { ok: true }
		: {
				ok: false,
				...(posted.retryAfterSeconds
					? { retryAfterSeconds: posted.retryAfterSeconds }
					: {}),
				...(posted.error ? { error: posted.error } : {}),
			}
}

async function dmSlackUserSafe(
	botToken: string,
	slackUserId: string,
	text: string,
): Promise<void> {
	try {
		const channel = await openSlackConversation(botToken, slackUserId)
		if (channel) await postSlackMessage(botToken, channel, text)
	} catch {}
}

export async function startPublicChannelRollout(
	agent: CompanyBrainAgent,
	payload: PublicChannelRolloutStart,
): Promise<void> {
	ensurePublicChannelRolloutTables(agent)
	const env = brainAgent(agent).env
	const ws = await getWorkspaceByTeamId(env, payload.teamId)
	const card = rolloutCard(agent)
	// The button now lives on the admin DM copy, so the click arrives from there.
	const fromCard =
		card &&
		(card.home_channel_id === payload.homeChannelId ||
			card.admin_channel_id === payload.homeChannelId)
	if (!ws || ws.orgId !== agent.name || !card || !fromCard) {
		return
	}
	const replyChannelId = payload.homeChannelId
	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	const scopes = grantedScopes(ws.scopes)
	const missing = REQUIRED_SCOPES.filter((scope) => !scopes.has(scope))
	if (missing.length) {
		await postSlackEphemeral(
			botToken,
			replyChannelId,
			payload.slackUserId,
			`This installation needs to be reauthorized before I can join and read public channels. Missing Slack scopes: ${missing.join(", ")}. Reinstall Company Brain from the Supermemory app, then try again.`,
		)
		return
	}
	const profile = await lookupSlackUserInfo(botToken, payload.slackUserId)
	const actor = profile.ok
		? (
				await getOrgActorBySlackIdentity(env, {
					orgId: ws.orgId,
					teamId: payload.teamId,
					slackUserId: payload.slackUserId,
					email: profile.user.email,
				})
			).actor
		: null
	if (!profile.ok || !actor?.isAdmin) {
		await postSlackEphemeral(
			botToken,
			replyChannelId,
			payload.slackUserId,
			"Only a Company Brain organization admin can add me across the workspace.",
		)
		return
	}

	const active = currentRun(agent)
	if (active?.status === "running") {
		await postSlackEphemeral(
			botToken,
			replyChannelId,
			payload.slackUserId,
			"I’m already working through the public channels. I’ll keep this card updated.",
		)
		return
	}

	const actorName = rolloutActorName(
		slackUserDisplayName(profile.user) ??
			profile.user.email?.split("@")[0] ??
			"your admin",
	)
	await beginRolloutRun(agent, {
		ws,
		botToken,
		teamId: payload.teamId,
		homeChannelId: card.home_channel_id,
		actorUserId: actor.userId,
		actorSlackUserId: payload.slackUserId,
		actorName,
	})
	await postSlackEphemeral(
		botToken,
		replyChannelId,
		payload.slackUserId,
		"On it. I’ll join eligible public channels, ingest the last seven days, cross-check channel themes against organization-shared read-only tools, and introduce myself only after memory processing finishes.",
	)
}

// Shared by the button and the no-click fallback: reset prior run state, insert
// the new run, and schedule the first step.
async function beginRolloutRun(
	agent: CompanyBrainAgent,
	args: {
		ws: SlackWorkspaceRow
		botToken: string
		teamId: string
		homeChannelId: string
		actorUserId: string
		actorSlackUserId?: string
		actorName: string
		channelFilter?: string[]
	},
): Promise<void> {
	const { ws, botToken, actorName } = args
	const channelFilterJson = args.channelFilter?.length
		? JSON.stringify(args.channelFilter)
		: null
	const now = Date.now()
	const runId = generateId()
	agent.sql`DELETE FROM brain_public_channel_rollout_thread`
	agent.sql`DELETE FROM brain_public_channel_rollout_message`
	agent.sql`DELETE FROM brain_public_channel_rollout_document`
	agent.sql`DELETE FROM brain_public_channel_rollout_channel`
	agent.sql`
		INSERT INTO brain_public_channel_rollout (
			id, run_id, team_id, home_channel_id, status, phase,
			actor_user_id, actor_slack_user_id, actor_name,
			window_start_ms, window_end_ms, list_cursor,
			configured_servers_json, used_servers_json, failure_count,
			last_error, channel_filter_json, created_at, updated_at
		) VALUES (
			1, ${runId}, ${args.teamId}, ${args.homeChannelId}, 'running', 'discover',
			${args.actorUserId}, ${args.actorSlackUserId ?? ""}, ${actorName},
			${now - PUBLIC_CHANNEL_ROLLOUT_DAYS * 24 * 60 * 60 * 1000}, ${now}, NULL,
			'[]', '[]', 0, NULL, ${channelFilterJson}, ${now}, ${now}
		)
		ON CONFLICT(id) DO UPDATE SET
			run_id = excluded.run_id, team_id = excluded.team_id,
			home_channel_id = excluded.home_channel_id, status = excluded.status,
			phase = excluded.phase, actor_user_id = excluded.actor_user_id,
			actor_slack_user_id = excluded.actor_slack_user_id,
			actor_name = excluded.actor_name, window_start_ms = excluded.window_start_ms,
			window_end_ms = excluded.window_end_ms, list_cursor = NULL,
			configured_servers_json = '[]', used_servers_json = '[]',
			failure_count = 0, last_error = NULL,
			channel_filter_json = excluded.channel_filter_json,
			created_at = excluded.created_at, updated_at = excluded.updated_at
	`
	const metadata = organizationMetadata(ws.orgMetadata)
	await maybeSyncBrainProfileConfig(agent, {
		orgId: ws.orgId,
		orgName: ws.orgName,
		domain:
			typeof metadata.brainWorkspaceDomain === "string"
				? metadata.brainWorkspaceDomain
				: undefined,
		installerUserId: ws.installedByUserId,
		asker: { userId: args.actorUserId, name: actorName },
	})
	await refreshRolloutCard(agent, botToken, "running")
	await agent.schedule(NEXT_STEP_DELAY_SECONDS, "runPublicChannelRollout", {
		runId,
	})
}

function storeMessages(
	agent: CompanyBrainAgent,
	runId: string,
	channelId: string,
	messages: SlackThreadMessage[],
): void {
	for (const message of messages) {
		if (!message.ts) continue
		const text = normalizeSlackMessageContent(message) || null
		agent.sql`
			INSERT INTO brain_public_channel_rollout_message (
				run_id, channel_id, ts, user_id, text, bot_id, subtype, app_id,
				thread_ts, reply_count, files_json, reactions_json
			) VALUES (
				${runId}, ${channelId}, ${message.ts}, ${message.user ?? null},
				${text}, ${message.bot_id ?? null},
				${message.subtype ?? null}, ${message.app_id ?? null},
				${message.thread_ts ?? null}, ${message.reply_count ?? null},
				${JSON.stringify(message.files ?? [])},
				${JSON.stringify(message.reactions ?? [])}
			)
			ON CONFLICT(run_id, channel_id, ts) DO UPDATE SET
				user_id = excluded.user_id, text = excluded.text,
				bot_id = excluded.bot_id, subtype = excluded.subtype,
				app_id = excluded.app_id, thread_ts = excluded.thread_ts,
				reply_count = excluded.reply_count, files_json = excluded.files_json,
				reactions_json = excluded.reactions_json
		`
		if (isSlackHistoryThreadRoot(message)) {
			agent.sql`
				INSERT OR IGNORE INTO brain_public_channel_rollout_thread (
					run_id, channel_id, thread_ts, cursor, status, attempts
				) VALUES (${runId}, ${channelId}, ${message.ts}, NULL, 'pending', 0)
			`
		}
	}
}

function storedMessages(
	agent: CompanyBrainAgent,
	runId: string,
	channelId: string,
): SlackThreadMessage[] {
	const rows = agent.sql<{
		ts: string
		user_id: string | null
		text: string | null
		bot_id: string | null
		subtype: string | null
		app_id: string | null
		thread_ts: string | null
		reply_count: number | null
		files_json: string
		reactions_json: string
	}>`
		SELECT ts, user_id, text, bot_id, subtype, app_id, thread_ts,
			reply_count, files_json, reactions_json
		FROM brain_public_channel_rollout_message
		WHERE run_id = ${runId} AND channel_id = ${channelId}
		ORDER BY CAST(ts AS REAL) ASC
	`
	return rows.map((row) => ({
		ts: row.ts,
		user: row.user_id ?? undefined,
		text: row.text ?? undefined,
		bot_id: row.bot_id ?? undefined,
		subtype: row.subtype ?? undefined,
		app_id: row.app_id ?? undefined,
		thread_ts: row.thread_ts ?? undefined,
		reply_count: row.reply_count ?? undefined,
		files: parseJsonArray<NonNullable<SlackThreadMessage["files"]>[number]>(
			row.files_json,
		),
		reactions: parseJsonArray<
			NonNullable<SlackThreadMessage["reactions"]>[number]
		>(row.reactions_json),
	}))
}

function nextChannel(
	agent: CompanyBrainAgent,
	runId: string,
	whereSql: "join" | "collect" | "crosscheck" | "introduce",
): RolloutChannelRow | undefined {
	return agent.sql<RolloutChannelRow>`
		SELECT run_id, channel_id, name, topic, purpose, was_member,
			already_introduced, theme_only, join_status, stage, history_cursor,
			theme_json, check_json, intro_client_id, intro_ts,
			attempts, last_error, created_at, updated_at
		FROM brain_public_channel_rollout_channel
		WHERE run_id = ${runId} AND (
			(${whereSql} = 'join' AND join_status = 'pending') OR
			(${whereSql} = 'collect' AND join_status = 'joined'
				AND stage IN ('history', 'threads', 'package', 'enqueue')) OR
			(${whereSql} = 'crosscheck' AND stage = 'crosscheck') OR
			(${whereSql} = 'introduce' AND stage = 'wait_memory')
		)
		ORDER BY name ASC LIMIT 1
	`[0]
}

async function scheduleNext(
	agent: CompanyBrainAgent,
	runId: string,
	delaySeconds = NEXT_STEP_DELAY_SECONDS,
): Promise<void> {
	await agent.schedule(delaySeconds, "runPublicChannelRollout", { runId })
}

async function discoverStep(
	agent: CompanyBrainAgent,
	run: RolloutRow,
	botToken: string,
): Promise<void> {
	const page = await listSlackPublicChannelsPage(botToken, {
		cursor: run.list_cursor ?? undefined,
	})
	if (!page.ok) {
		if (page.retryAfterSeconds) {
			await scheduleNext(agent, run.run_id, page.retryAfterSeconds)
			return
		}
		throw new Error(`channel_discovery:${page.error}`)
	}
	const now = Date.now()
	// Beachhead runs pin discovery to the exact channels named in the notice.
	const filter = run.channel_filter_json
		? new Set(parseJsonArray<string>(run.channel_filter_json))
		: null
	for (const channel of page.items) {
		if (filter && !filter.has(channel.id)) continue
		if (
			!isEligiblePublicChannel(channel, { homeChannelId: run.home_channel_id })
		) {
			continue
		}
		const introduced = agent.sql<{ theme_json: string | null }>`
			SELECT theme_json FROM brain_public_channel_introduction
			WHERE team_id = ${run.team_id} AND channel_id = ${channel.id} LIMIT 1
		`[0]
		// Already-introduced channels skip history/theme/crosscheck; only new
		// channels run the catch-up pipeline on "check for new public channels".
		// Beachhead runs re-read regardless: the read-out is the whole point.
		const alreadyIntroduced = !filter && Boolean(introduced)
		// Introduced before themes were stored durably: re-derive them in place.
		// Members only, so a channel the bot was removed from is never rejoined.
		const needsTheme =
			alreadyIntroduced &&
			channel.isMember &&
			(!introduced?.theme_json || introduced.theme_json === "[]")
		agent.sql`
			INSERT OR IGNORE INTO brain_public_channel_rollout_channel (
				run_id, channel_id, name, topic, purpose, was_member,
				already_introduced, theme_only, join_status, stage, history_cursor,
				theme_json, check_json, intro_client_id, intro_ts,
				attempts, last_error, created_at, updated_at
			) VALUES (
				${run.run_id}, ${channel.id}, ${channel.name}, ${channel.topic ?? null},
				${channel.purpose ?? null}, ${channel.isMember ? 1 : 0},
				${alreadyIntroduced ? 1 : 0},
				${needsTheme ? 1 : 0},
				${alreadyIntroduced && !needsTheme ? "joined" : "pending"},
				${alreadyIntroduced && !needsTheme ? "done" : "history"},
				NULL,
				'[]', '[]', ${crypto.randomUUID()}, NULL,
				0, NULL, ${now}, ${now}
			)
		`
	}
	if (page.complete) {
		agent.sql`
			UPDATE brain_public_channel_rollout
			SET phase = 'join', list_cursor = NULL, updated_at = ${now}
			WHERE id = 1 AND run_id = ${run.run_id}
		`
		await refreshRolloutCard(agent, botToken, "running")
	} else {
		agent.sql`
			UPDATE brain_public_channel_rollout
			SET list_cursor = ${page.nextCursor ?? null}, updated_at = ${now}
			WHERE id = 1 AND run_id = ${run.run_id}
		`
	}
	await scheduleNext(agent, run.run_id)
}

async function joinStep(
	agent: CompanyBrainAgent,
	run: RolloutRow,
	botToken: string,
): Promise<void> {
	const channel = nextChannel(agent, run.run_id, "join")
	if (!channel) {
		agent.sql`
			UPDATE brain_public_channel_rollout SET phase = 'collect', updated_at = ${Date.now()}
			WHERE id = 1 AND run_id = ${run.run_id}
		`
		await refreshRolloutCard(agent, botToken, "running")
		await scheduleNext(agent, run.run_id)
		return
	}
	if (channel.was_member) {
		agent.sql`
			UPDATE brain_public_channel_rollout_channel
			SET join_status = 'joined', attempts = 0, updated_at = ${Date.now()}
			WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
		`
		await scheduleNext(agent, run.run_id)
		return
	}
	const joined = await joinSlackPublicChannel(botToken, channel.channel_id)
	if (!joined.ok && joined.retryAfterSeconds) {
		await scheduleNext(agent, run.run_id, joined.retryAfterSeconds)
		return
	}
	if (!joined.ok) {
		const attempts = channel.attempts + 1
		if (attempts < MAX_STAGE_ATTEMPTS && joined.error !== "missing_scope") {
			agent.sql`
				UPDATE brain_public_channel_rollout_channel
				SET attempts = ${attempts}, last_error = ${joined.error}, updated_at = ${Date.now()}
				WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
			`
			await scheduleNext(agent, run.run_id, Math.min(2 ** attempts, 60))
			return
		}
		agent.sql`
			UPDATE brain_public_channel_rollout_channel
			SET join_status = 'failed', stage = 'failed', attempts = ${attempts},
				last_error = ${joined.error}, updated_at = ${Date.now()}
			WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
		`
	} else {
		agent.sql`
			UPDATE brain_public_channel_rollout_channel
			SET join_status = 'joined', attempts = 0, last_error = NULL, updated_at = ${Date.now()}
			WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
		`
		await invalidateChannelDirectory(brainAgent(agent).env, run.team_id)
	}
	await scheduleNext(agent, run.run_id)
}

async function packageChannel(
	agent: CompanyBrainAgent,
	run: RolloutRow,
	channel: RolloutChannelRow,
	botUserId: string | null,
): Promise<void> {
	const messages = storedMessages(agent, run.run_id, channel.channel_id)
	// Theme recovery reads to derive a theme and stops there; this channel's
	// history is already ingested from the run that introduced it.
	if (!channel.theme_only) {
		const docs = buildSlackHistoryDocuments({
			teamId: run.team_id,
			channelId: channel.channel_id,
			channelName: channel.name,
			topic: channel.topic,
			purpose: channel.purpose,
			windowStartMs: run.window_start_ms,
			windowEndMs: run.window_end_ms,
			botUserId,
			messages,
		})
		for (const [index, doc] of docs.entries()) {
			agent.sql`
				INSERT OR REPLACE INTO brain_public_channel_rollout_document (
					run_id, channel_id, custom_id, ord, content, metadata_json,
					document_id, status, attempts, submitted_at
				) VALUES (
					${run.run_id}, ${channel.channel_id}, ${doc.customId}, ${index}, ${doc.content},
					${JSON.stringify(doc.metadata)}, NULL, 'pending', 0, NULL
				)
			`
		}
	}
	const evidence = recentSlackChannelEvidence(messages, botUserId, 40, {
		startMs: run.window_start_ms,
		endMs: run.window_end_ms,
	})
	const validMessageTs = messages.flatMap((message) => {
		if (!message.ts) return []
		const ms = Number.parseFloat(message.ts) * 1000
		if (
			!Number.isFinite(ms) ||
			ms < run.window_start_ms ||
			ms > run.window_end_ms
		) {
			return []
		}
		return [message.ts]
	})
	const themes = await extractChannelThemes({
		channelId: channel.channel_id,
		channelName: channel.name,
		topic: channel.topic,
		purpose: channel.purpose,
		evidence,
		validMessageTs,
		orgId: agent.name,
		env: brainAgent(agent).env,
	})
	// Recovery only wants the theme: ingesting again would mint fresh document
	// ids for the same days, since the id hashes this run's window bounds.
	if (channel.theme_only) {
		agent.sql`
			UPDATE brain_public_channel_introduction SET theme_json = ${JSON.stringify(themes)}
			WHERE team_id = ${run.team_id} AND channel_id = ${channel.channel_id}
		`
		agent.sql`
			UPDATE brain_public_channel_rollout_channel
			SET stage = 'done', theme_json = ${JSON.stringify(themes)},
				attempts = 0, last_error = NULL, updated_at = ${Date.now()}
			WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
		`
		agent.sql`
			DELETE FROM brain_public_channel_rollout_message
			WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
		`
		return
	}
	agent.sql`
		UPDATE brain_public_channel_rollout_channel
		SET stage = 'enqueue', theme_json = ${JSON.stringify(themes)},
			attempts = 0, last_error = NULL, updated_at = ${Date.now()}
		WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
	`
}

async function submitDocument(
	agent: CompanyBrainAgent,
	run: RolloutRow,
	channel: RolloutChannelRow,
	doc: RolloutDocumentRow,
): Promise<void> {
	if (!doc.content) throw new Error("history_document_missing_content")
	const env = brainAgent(agent).env
	const [org] = await db(env)
		.select({
			id: organization.id,
			name: organization.name,
			metadata: organization.metadata,
		})
		.from(organization)
		.where(eq(organization.id, agent.name))
		.limit(1)
	if (!org) throw new Error("organization_not_found")
	const result = await Effect.runPromise(
		addMemorySingle({
			org,
			userId: run.actor_user_id,
			source: "company-brain-slack-history",
			requestParams: {
				content: doc.content,
				customId: doc.custom_id,
				containerTag: SHARED_TEAM_BRAIN_CONTAINER_TAG,
				metadata: JSON.parse(doc.metadata_json) as Record<
					string,
					string | number | boolean | string[]
				>,
			},
			isFullReplace: true,
			dreaming: "dynamic",
			preserveBrainTags: true,
		}).pipe(Effect.provide(makeAppLayer({ env }))),
	)
	if (!result.id || (result.status !== "queued" && result.status !== "done")) {
		throw new Error(`history_ingest_${result.status}`)
	}
	agent.sql`
		UPDATE brain_public_channel_rollout_document
		SET document_id = ${result.id}, status = 'submitted', content = NULL,
			submitted_at = ${Date.now()}, attempts = 0
		WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
			AND custom_id = ${doc.custom_id}
	`
}

async function collectStep(
	agent: CompanyBrainAgent,
	run: RolloutRow,
	botToken: string,
	botUserId: string | null,
): Promise<void> {
	const channel = nextChannel(agent, run.run_id, "collect")
	if (!channel) {
		agent.sql`
			UPDATE brain_public_channel_rollout SET phase = 'crosscheck', updated_at = ${Date.now()}
			WHERE id = 1 AND run_id = ${run.run_id}
		`
		await refreshRolloutCard(agent, botToken, "running")
		await scheduleNext(agent, run.run_id)
		return
	}

	if (channel.stage === "history") {
		const page = await getSlackChannelHistoryPage(
			botToken,
			channel.channel_id,
			{
				oldest: String(run.window_start_ms / 1000),
				latest: String(run.window_end_ms / 1000),
				cursor: channel.history_cursor ?? undefined,
			},
		)
		if (!page.ok) {
			if (page.retryAfterSeconds) {
				await scheduleNext(agent, run.run_id, page.retryAfterSeconds)
				return
			}
			const attempts = channel.attempts + 1
			agent.sql`
				UPDATE brain_public_channel_rollout_channel
				SET attempts = ${attempts},
					stage = ${attempts >= MAX_STAGE_ATTEMPTS ? "failed" : "history"},
					last_error = ${`channel_history:${page.error}`}, updated_at = ${Date.now()}
				WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
			`
			await scheduleNext(agent, run.run_id, Math.min(2 ** attempts, 60))
			return
		}
		storeMessages(agent, run.run_id, channel.channel_id, page.items)
		agent.sql`
			UPDATE brain_public_channel_rollout_channel
			SET history_cursor = ${page.nextCursor ?? null},
				stage = ${page.complete ? "threads" : "history"},
				attempts = 0, updated_at = ${Date.now()}
			WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
		`
		await scheduleNext(agent, run.run_id)
		return
	}

	if (channel.stage === "threads") {
		const thread = agent.sql<RolloutThreadRow>`
			SELECT thread_ts, cursor, status, attempts
			FROM brain_public_channel_rollout_thread
			WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
				AND status IN ('pending', 'reading')
			ORDER BY CAST(thread_ts AS REAL) ASC LIMIT 1
		`[0]
		if (!thread) {
			agent.sql`
				UPDATE brain_public_channel_rollout_channel SET stage = 'package', updated_at = ${Date.now()}
				WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
			`
			await scheduleNext(agent, run.run_id)
			return
		}
		const page = await getSlackThreadHistoryPage(
			botToken,
			channel.channel_id,
			thread.thread_ts,
			{ cursor: thread.cursor ?? undefined },
		)
		if (!page.ok) {
			if (page.retryAfterSeconds) {
				await scheduleNext(agent, run.run_id, page.retryAfterSeconds)
				return
			}
			const attempts = thread.attempts + 1
			if (attempts < MAX_STAGE_ATTEMPTS) {
				agent.sql`
					UPDATE brain_public_channel_rollout_thread SET attempts = ${attempts}
					WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
						AND thread_ts = ${thread.thread_ts}
				`
				await scheduleNext(agent, run.run_id, Math.min(2 ** attempts, 60))
				return
			}
			agent.sql`
				UPDATE brain_public_channel_rollout_thread SET status = 'failed', attempts = ${attempts}
				WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
					AND thread_ts = ${thread.thread_ts}
			`
			agent.sql`
				UPDATE brain_public_channel_rollout_channel
				SET stage = 'failed', last_error = ${`thread_history:${page.error}`}, updated_at = ${Date.now()}
				WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
			`
		} else {
			storeMessages(agent, run.run_id, channel.channel_id, page.items)
			agent.sql`
				UPDATE brain_public_channel_rollout_thread
				SET cursor = ${page.nextCursor ?? null},
					status = ${page.complete ? "done" : "reading"}, attempts = 0
				WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
					AND thread_ts = ${thread.thread_ts}
			`
		}
		await scheduleNext(agent, run.run_id)
		return
	}

	if (channel.stage === "package") {
		await packageChannel(agent, run, channel, botUserId)
		await scheduleNext(agent, run.run_id)
		return
	}

	const pendingDoc = agent.sql<RolloutDocumentRow>`
		SELECT custom_id, ord, content, metadata_json, document_id, status, attempts, submitted_at
		FROM brain_public_channel_rollout_document
		WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
			AND status = 'pending'
		ORDER BY ord ASC LIMIT 1
	`[0]
	if (pendingDoc) {
		try {
			await submitDocument(agent, run, channel, pendingDoc)
		} catch (error) {
			const attempts = pendingDoc.attempts + 1
			const message = rolloutErrorCode(error)
			agent.sql`
				UPDATE brain_public_channel_rollout_document
				SET attempts = ${attempts}, status = ${attempts >= MAX_STAGE_ATTEMPTS ? "failed" : "pending"}
				WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
					AND custom_id = ${pendingDoc.custom_id}
			`
			if (attempts >= MAX_STAGE_ATTEMPTS) {
				agent.sql`
					UPDATE brain_public_channel_rollout_channel
					SET stage = 'failed', last_error = ${message}, updated_at = ${Date.now()}
					WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
				`
			}
			await scheduleNext(agent, run.run_id, Math.min(2 ** attempts, 60))
			return
		}
		await scheduleNext(agent, run.run_id)
		return
	}
	const failedDoc = agent.sql<{ present: number }>`
		SELECT 1 AS present FROM brain_public_channel_rollout_document
		WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
			AND status = 'failed' LIMIT 1
	`[0]
	agent.sql`
		UPDATE brain_public_channel_rollout_channel
		SET stage = ${failedDoc ? "failed" : "crosscheck"}, updated_at = ${Date.now()}
		WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
	`
	await scheduleNext(agent, run.run_id)
}

async function crosscheckStep(
	agent: CompanyBrainAgent,
	run: RolloutRow,
): Promise<void> {
	const channels = agent.sql<RolloutChannelRow>`
		SELECT run_id, channel_id, name, topic, purpose, was_member,
			already_introduced, theme_only, join_status, stage, history_cursor,
			theme_json, check_json, intro_client_id, intro_ts,
			attempts, last_error, created_at, updated_at
		FROM brain_public_channel_rollout_channel
		WHERE run_id = ${run.run_id} AND stage = 'crosscheck'
		ORDER BY name ASC LIMIT ${CROSSCHECK_CHANNEL_BATCH}
	`
	if (!channels.length) {
		agent.sql`
			UPDATE brain_public_channel_rollout SET phase = 'introduce', updated_at = ${Date.now()}
			WHERE id = 1 AND run_id = ${run.run_id}
		`
		await scheduleNext(agent, run.run_id)
		return
	}
	const themes = channels.flatMap((channel) =>
		parseJsonArray<ChannelTheme>(channel.theme_json),
	)
	const checked = await crosscheckThemesWithConnectedTools(
		brainAgent(agent).env,
		agent.name,
		themes,
	)
	for (const channel of channels) {
		const themeIds = new Set(
			parseJsonArray<ChannelTheme>(channel.theme_json).map((theme) => theme.id),
		)
		const checks = checked.checks.filter((check) => themeIds.has(check.themeId))
		agent.sql`
			UPDATE brain_public_channel_rollout_channel
			SET stage = 'wait_memory', check_json = ${JSON.stringify(checks)},
				updated_at = ${Date.now()}
			WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
		`
	}
	const configured = [
		...new Set([
			...parseJsonArray<string>(run.configured_servers_json),
			...checked.configuredServers,
		]),
	]
	const used = [
		...new Set([
			...parseJsonArray<string>(run.used_servers_json),
			...checked.usedServers,
		]),
	]
	agent.sql`
		UPDATE brain_public_channel_rollout
		SET configured_servers_json = ${JSON.stringify(configured)},
			used_servers_json = ${JSON.stringify(used)}, updated_at = ${Date.now()}
		WHERE id = 1 AND run_id = ${run.run_id}
	`
	await scheduleNext(agent, run.run_id)
}

async function memoryReady(
	agent: CompanyBrainAgent,
	run: RolloutRow,
	channel: RolloutChannelRow,
): Promise<"ready" | "waiting" | "failed"> {
	const docs = agent.sql<RolloutDocumentRow>`
		SELECT custom_id, ord, content, metadata_json, document_id, status, attempts, submitted_at
		FROM brain_public_channel_rollout_document
		WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
	`
	if (!docs.length) return "ready"
	if (docs.some((doc) => doc.status === "failed" || !doc.document_id)) {
		return "failed"
	}
	const ids = docs.flatMap((doc) => (doc.document_id ? [doc.document_id] : []))
	const rows = [
		...(await documentStatuses(brainAgent(agent).env, ids)).values(),
	]
	if (rows.some((row) => row.status === "failed")) return "failed"
	if (
		rows.length === ids.length &&
		rows.every((row) => row.status === "done" && row.dreamingStatus === "done")
	) {
		for (const id of ids) {
			agent.sql`
				UPDATE brain_public_channel_rollout_document SET status = 'done'
				WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
					AND document_id = ${id}
			`
		}
		return "ready"
	}
	const oldest = Math.min(...docs.map((doc) => doc.submitted_at ?? Date.now()))
	return Date.now() - oldest > MAX_MEMORY_WAIT_MS ? "failed" : "waiting"
}

async function introduceStep(
	agent: CompanyBrainAgent,
	run: RolloutRow,
	botToken: string,
): Promise<void> {
	const channel = nextChannel(agent, run.run_id, "introduce")
	if (!channel) {
		const counts = rolloutCounts(agent, run.run_id)
		// Deliver before the run flips to done, or a failed post is never
		// retried while the card still claims the read-out happened. Failures
		// throw into the outer bounded-retry handler, which marks the run
		// failed at MAX_RUN_FAILURES instead of letting it fall through to done.
		if (run.channel_filter_json) {
			const readout = await postBeachheadReadout(agent, run, botToken)
			if (!readout.ok) {
				if (readout.retryAfterSeconds) {
					await scheduleNext(agent, run.run_id, readout.retryAfterSeconds)
					return
				}
				throw new Error("beachhead_readout_failed")
			}
		}
		agent.sql`
			UPDATE brain_public_channel_rollout
			SET status = 'done', updated_at = ${Date.now()}, failure_count = 0
			WHERE id = 1 AND run_id = ${run.run_id}
		`
		await refreshRolloutCard(agent, botToken, "done")
		// A run that joined nothing granted nothing, however cleanly it finished.
		if (counts.joined > 0) {
			captureActivationRung({
				orgId: agent.name,
				userId: run.actor_user_id || undefined,
				rung: "channels",
				source: run.channel_filter_json ? "beachhead" : "rollout",
				detail: {
					channels_discovered: counts.discovered,
					channels_joined: counts.joined,
					channels_ready: counts.ready,
				},
			})
		}
		console.log(
			`[company-brain] public-channel rollout done run=${run.run_id} discovered=${counts.discovered} joined=${counts.joined} introduced=${counts.introduced} failed=${counts.failed}`,
		)
		return
	}
	const ready = await memoryReady(agent, run, channel)
	if (ready === "waiting") {
		await scheduleNext(agent, run.run_id, MEMORY_POLL_DELAY_SECONDS)
		return
	}
	if (ready === "failed") {
		agent.sql`
			UPDATE brain_public_channel_rollout_channel
			SET stage = 'failed', last_error = 'memory_processing_failed', updated_at = ${Date.now()}
			WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
		`
		await scheduleNext(agent, run.run_id)
		return
	}

	if (channel.already_introduced) {
		// Re-read for a channel whose durable theme was lost: keep the theme, skip
		// the intro it already got.
		if (channel.theme_json && channel.theme_json !== "[]") {
			agent.sql`
				UPDATE brain_public_channel_introduction SET theme_json = ${channel.theme_json}
				WHERE team_id = ${run.team_id} AND channel_id = ${channel.channel_id}
			`
		}
		agent.sql`
			UPDATE brain_public_channel_rollout_channel SET stage = 'done', updated_at = ${Date.now()}
			WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
		`
		agent.sql`
			DELETE FROM brain_public_channel_rollout_message
			WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
		`
		await scheduleNext(agent, run.run_id)
		return
	}
	const themes = parseJsonArray<ChannelTheme>(channel.theme_json)
	const checks = parseJsonArray<ToolCrosscheck>(channel.check_json)
	const introduction = await composeChannelIntroduction({
		channelName: channel.name,
		installerName: run.actor_name,
		themes,
		checks,
		orgId: agent.name,
		env: brainAgent(agent).env,
	})
	const posted = await postSlackMessageIdempotent(
		botToken,
		channel.channel_id,
		introduction,
		channel.intro_client_id,
		[
			{
				type: "section",
				text: { type: "mrkdwn", text: introduction.slice(0, 2900) },
			},
			{
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: "I'll chime in when the conversation is something I can help with. Not wanted in this channel? Tune it at <https://app.supermemory.ai/configure/proactivity|app.supermemory.ai/configure/proactivity> _(admin only)_.",
					},
				],
			},
		],
	)
	if (!posted.ok && posted.retryAfterSeconds) {
		await scheduleNext(agent, run.run_id, posted.retryAfterSeconds)
		return
	}
	if (!posted.ok) {
		const attempts = channel.attempts + 1
		if (attempts < MAX_STAGE_ATTEMPTS) {
			agent.sql`
				UPDATE brain_public_channel_rollout_channel
				SET attempts = ${attempts}, last_error = ${posted.error}, updated_at = ${Date.now()}
				WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
			`
			await scheduleNext(agent, run.run_id, Math.min(2 ** attempts, 60))
			return
		}
		agent.sql`
			UPDATE brain_public_channel_rollout_channel
			SET stage = 'failed', attempts = ${attempts}, last_error = ${posted.error}, updated_at = ${Date.now()}
			WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
		`
		await scheduleNext(agent, run.run_id)
		return
	}
	const now = Date.now()
	agent.sql`
		INSERT INTO brain_public_channel_introduction (channel_id, team_id, intro_ts, introduced_at, theme_json)
		VALUES (${channel.channel_id}, ${run.team_id}, ${posted.ts}, ${now}, ${channel.theme_json})
		ON CONFLICT(team_id, channel_id) DO UPDATE SET
			intro_ts = excluded.intro_ts,
			theme_json = excluded.theme_json
	`
	agent.sql`
		UPDATE brain_public_channel_rollout_channel
		SET stage = 'done', intro_ts = ${posted.ts}, attempts = 0,
			last_error = NULL, updated_at = ${now}
		WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
	`
	agent.sql`
		DELETE FROM brain_public_channel_rollout_message
		WHERE run_id = ${run.run_id} AND channel_id = ${channel.channel_id}
	`
	await scheduleNext(agent, run.run_id)
}

export function isChannelAwaitingRolloutIntroduction(
	agent: CompanyBrainAgent,
	channelId: string,
): boolean {
	return Boolean(
		agent.sql<{ present: number }>`
		SELECT 1 AS present
		FROM brain_public_channel_rollout_channel c
		JOIN brain_public_channel_rollout r ON r.run_id = c.run_id
		WHERE r.id = 1 AND r.status = 'running' AND c.channel_id = ${channelId}
			AND c.already_introduced = 0 AND c.stage NOT IN ('done', 'failed')
		LIMIT 1
	`[0],
	)
}

export async function runPublicChannelRollout(
	agent: CompanyBrainAgent,
	payload: PublicChannelRolloutPayload,
): Promise<void> {
	ensurePublicChannelRolloutTables(agent)
	const run = currentRun(agent)
	if (!run || run.run_id !== payload.runId || run.status !== "running") return
	const env = brainAgent(agent).env
	// Rollout alarms outlive the trial: stop the run once entitlement lapses.
	if (
		!(await orgCanRunCompanyBrain(env, agent.name, (promise) =>
			agent.waitUntil(promise),
		))
	) {
		console.log(
			`[company-brain] rollout blocked: entitlement org=${agent.name} run=${run.run_id}`,
		)
		agent.sql`
			UPDATE brain_public_channel_rollout
			SET status = 'failed', last_error = 'entitlement_blocked', updated_at = ${Date.now()}
			WHERE id = 1
		`
		return
	}
	try {
		const ws = await getWorkspaceByTeamId(env, run.team_id)
		if (!ws || ws.orgId !== agent.name) throw new Error("workspace_not_found")
		const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
		if (run.phase === "discover") {
			await discoverStep(agent, run, botToken)
		} else if (run.phase === "join") {
			await joinStep(agent, run, botToken)
		} else if (run.phase === "collect") {
			await collectStep(agent, run, botToken, ws.botUserId)
		} else if (run.phase === "crosscheck") {
			await crosscheckStep(agent, run)
		} else {
			await introduceStep(agent, run, botToken)
		}
		agent.sql`
			UPDATE brain_public_channel_rollout SET failure_count = 0, last_error = NULL
			WHERE id = 1 AND run_id = ${run.run_id} AND status = 'running'
		`
	} catch (error) {
		const message = rolloutErrorCode(error)
		const failures = run.failure_count + 1
		console.warn(
			`[company-brain] public-channel rollout step failed run=${run.run_id} phase=${run.phase} failures=${failures}: ${message}`,
		)
		if (failures >= MAX_RUN_FAILURES) {
			agent.sql`
				UPDATE brain_public_channel_rollout
				SET status = 'failed', failure_count = ${failures}, last_error = ${message}, updated_at = ${Date.now()}
				WHERE id = 1 AND run_id = ${run.run_id}
			`
			const ws = await getWorkspaceByTeamId(env, run.team_id).catch(() => null)
			if (ws) {
				const token = await decryptToken(
					ws.botTokenEnc,
					env.ENCRYPTION_SECRET,
				).catch(() => null)
				if (token) await refreshRolloutCard(agent, token, "failed")
			}
			return
		}
		agent.sql`
			UPDATE brain_public_channel_rollout
			SET failure_count = ${failures}, last_error = ${message}, updated_at = ${Date.now()}
			WHERE id = 1 AND run_id = ${run.run_id}
		`
		await scheduleNext(agent, run.run_id, Math.min(2 ** failures, 5 * 60))
	}
}
