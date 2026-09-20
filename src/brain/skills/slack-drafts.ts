import type { CompanyBrainAgent } from "../turn/agent"
import { ensureSkillTables, sweepExpiredSkillDrafts } from "./store"
import type { ValidatedSkillInput } from "./validation"

export const SKILL_DRAFT_EXPIRY_MS = 15 * 60 * 1000

/** A settled draft is only ever read back for its status, so the playbook text
 * it was carrying is dropped rather than kept indefinitely in the DO. */
function settled(
	draft: PendingSkillDraft,
	status: Exclude<PendingSkillDraftStatus, "pending" | "processing">,
): PendingSkillDraft {
	return {
		...draft,
		status,
		processingToken: undefined,
		input: { ...draft.input, body: "" },
	}
}

export function skillDraftDeliveryKind(
	channelId: string,
): "direct_message" | "ephemeral" {
	return channelId.startsWith("D") ? "direct_message" : "ephemeral"
}

export type PendingSkillDraftStatus =
	| "pending"
	| "processing"
	| "created"
	| "cancelled"

export type PendingSkillDraft = {
	id: string
	status: PendingSkillDraftStatus
	input: ValidatedSkillInput
	creatorUserId: string
	creatorSlackUserId: string
	teamId: string
	originChannelId: string
	requestedScope?: "personal" | "org"
	threadTs?: string
	sourceThread?: string
	createdSkillId?: string
	processingToken?: string
	createdAt: number
	expiresAt: number
}

type DraftRow = {
	id: string
	status: PendingSkillDraftStatus
	draft_json: string
	processing_token: string | null
	created_at: number
	expires_at: number
}

export function insertPendingSkillDraft(
	agent: CompanyBrainAgent,
	draft: PendingSkillDraft,
): void {
	ensureSkillTables(agent)
	sweepExpiredSkillDrafts(agent)
	agent.sql`
		INSERT INTO brain_skill_draft (
			id, status, draft_json, processing_token, created_at, expires_at
		) VALUES (
			${draft.id}, ${draft.status}, ${JSON.stringify(draft)}, ${null},
			${draft.createdAt}, ${draft.expiresAt}
		)
	`
}

export function getPendingSkillDraft(
	agent: CompanyBrainAgent,
	id: string,
): PendingSkillDraft | null {
	ensureSkillTables(agent)
	const row = agent.sql<DraftRow>`
		SELECT id, status, draft_json, processing_token, created_at, expires_at
		FROM brain_skill_draft WHERE id = ${id}
	`[0]
	if (!row) return null
	try {
		const draft = JSON.parse(row.draft_json) as PendingSkillDraft
		return {
			...draft,
			id: row.id,
			status: row.status,
			processingToken: row.processing_token ?? undefined,
			createdAt: row.created_at,
			expiresAt: row.expires_at,
		}
	} catch {
		return null
	}
}

/** The draft row is written before the confirmation card is posted, so a failed
 * post has to remove it for "nothing was saved" to be true. */
export function deletePendingSkillDraft(
	agent: CompanyBrainAgent,
	id: string,
): void {
	agent.sql`DELETE FROM brain_skill_draft WHERE id = ${id}`
}

/** One conditional write is the ownership boundary across Slack retries and
 * double-clicks. The token lets this caller prove it owns the processing row. */
export function claimPendingSkillDraft(
	agent: CompanyBrainAgent,
	id: string,
	now = Date.now(),
): PendingSkillDraft | null {
	ensureSkillTables(agent)
	const processingToken = crypto.randomUUID()
	const claimed = agent.sql<{ id: string }>`
		UPDATE brain_skill_draft SET status = 'processing',
			processing_token = ${processingToken}
		WHERE id = ${id} AND status = 'pending' AND expires_at > ${now}
		RETURNING id
	`
	if (!claimed.length) return null
	const fresh = getPendingSkillDraft(agent, id)
	return fresh?.processingToken === processingToken ? fresh : null
}

export function cancelPendingSkillDraft(
	agent: CompanyBrainAgent,
	id: string,
): PendingSkillDraft | null {
	const draft = getPendingSkillDraft(agent, id)
	if (!draft) return null
	const next = settled(draft, "cancelled")
	const changed = agent.sql<{ id: string }>`
		UPDATE brain_skill_draft SET status = 'cancelled',
			draft_json = ${JSON.stringify(next)}
		WHERE id = ${id} AND status = 'pending'
		RETURNING id
	`
	return changed.length ? next : null
}

export function finishClaimedSkillDraft(
	agent: CompanyBrainAgent,
	draft: PendingSkillDraft,
): boolean {
	if (!draft.processingToken) return false
	const next = settled(draft, "created")
	const changed = agent.sql<{ id: string }>`
		UPDATE brain_skill_draft SET status = ${next.status},
			draft_json = ${JSON.stringify(next)}, processing_token = ${null}
		WHERE id = ${draft.id} AND status = 'processing'
			AND processing_token = ${draft.processingToken}
		RETURNING id
	`
	return changed.length > 0
}

export function failClaimedSkillDraft(
	agent: CompanyBrainAgent,
	draft: PendingSkillDraft,
): boolean {
	if (!draft.processingToken) return false
	const next = settled(draft, "cancelled")
	const changed = agent.sql<{ id: string }>`
		UPDATE brain_skill_draft SET status = 'cancelled',
			draft_json = ${JSON.stringify(next)}, processing_token = ${null}
		WHERE id = ${draft.id} AND status = 'processing'
			AND processing_token = ${draft.processingToken}
		RETURNING id
	`
	return changed.length > 0
}

function escapeMrkdwn(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
}

export const SLACK_SECTION_TEXT_MAX_CHARS = 3_000

function boundedEscapedMrkdwn(value: string, maxChars: number): string {
	if (maxChars <= 0) return ""
	const escaped = escapeMrkdwn(value)
	if (escaped.length <= maxChars) return escaped
	if (maxChars === 1) return "…"

	const budget = maxChars - 1
	let bounded = ""
	for (const codePoint of value) {
		const encoded = escapeMrkdwn(codePoint)
		if (bounded.length + encoded.length > budget) break
		bounded += encoded
	}
	return `${bounded}…`
}

function skillSummaryMrkdwn(args: {
	name: string
	description: string
	title?: string
	suffix?: string
}): string {
	const prefix = args.title ? `*${args.title}: ` : "*"
	const afterName = "*\n"
	const suffix = args.suffix ?? ""
	const maximumNameChars = Math.max(
		0,
		SLACK_SECTION_TEXT_MAX_CHARS -
			prefix.length -
			afterName.length -
			suffix.length,
	)
	// Valid skill names expand to at most 600 characters (`&` -> `&amp;`).
	// Keep that defensive bound so the description and fixed scope line always
	// have room even if this renderer is called with unvalidated input.
	const name = boundedEscapedMrkdwn(args.name, Math.min(600, maximumNameChars))
	const descriptionChars = Math.max(
		0,
		SLACK_SECTION_TEXT_MAX_CHARS -
			prefix.length -
			name.length -
			afterName.length -
			suffix.length,
	)
	return `${prefix}${name}${afterName}${boundedEscapedMrkdwn(args.description, descriptionChars)}${suffix}`
}

function preview(body: string): string {
	const clean = escapeMrkdwn(body.trim()).replaceAll("```", "``\u200b`")
	const bounded = clean.length > 1_600 ? `${clean.slice(0, 1_599)}…` : clean
	return `\`\`\`\n${bounded}\n\`\`\``
}

export function skillDraftBlocks(
	draft: PendingSkillDraft,
	isAdmin: boolean,
): unknown[] {
	const requestedScope = draft.requestedScope
	const suggested = draft.input.scope
	const button = (scope: "personal" | "org", text: string) => ({
		type: "button",
		action_id: `brain_skill_scope_${scope}`,
		value: draft.id,
		...(suggested === scope ? { style: "primary" } : {}),
		text: { type: "plain_text", text, emoji: true },
	})
	return [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: skillSummaryMrkdwn({
					name: draft.input.name,
					description: draft.input.description,
				}),
			},
		},
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `*Playbook preview*\n${preview(draft.input.body)}`,
			},
		},
		{
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: requestedScope
						? `Create this as ${requestedScope === "org" ? "an Organization-wide" : "a Personal"} skill?`
						: isAdmin
							? "Should this skill be Personal or Organization-wide?"
							: "This skill will be private to you.",
				},
			],
		},
		{
			type: "actions",
			elements: requestedScope
				? [
						{
							type: "button",
							action_id: "brain_skill_approve",
							value: draft.id,
							style: "primary",
							text: { type: "plain_text", text: "Approve", emoji: true },
						},
						{
							type: "button",
							action_id: "brain_skill_cancel",
							value: draft.id,
							text: { type: "plain_text", text: "Deny", emoji: true },
						},
					]
				: [
						button("personal", "Personal"),
						...(isAdmin ? [button("org", "Organization-wide")] : []),
						{
							type: "button",
							action_id: "brain_skill_cancel",
							value: draft.id,
							text: { type: "plain_text", text: "Cancel", emoji: true },
						},
					],
		},
	]
}

export function resolvedSkillDraftBlocks(
	draft: PendingSkillDraft,
	status: "created" | "cancelled" | "expired" | "error",
	message?: string,
	createdScope?: "personal" | "org",
): unknown[] {
	const defaults = {
		created: `✅ Saved *${escapeMrkdwn(draft.input.name)}*${
			createdScope === "org"
				? " as an organization-wide skill"
				: createdScope === "personal"
					? " as a personal skill"
					: ""
		}.`,
		cancelled: "Skill draft cancelled.",
		expired: "⌛ This skill draft expired.",
		error: "Couldn't save this skill.",
	}
	return [
		{
			type: "section",
			text: { type: "mrkdwn", text: message ?? defaults[status] },
		},
	]
}
