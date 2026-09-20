import type { CompanyBrainAgent } from "../turn/agent"
import { isSystemSkillId, SYSTEM_SKILLS } from "./system"
import {
	normalizeSkillName,
	ORG_SKILL_CAP,
	PERSONAL_SKILL_CAP,
	type SkillEditableInput,
	type SkillOrigin,
	type SkillScope,
	validateSkillInput,
} from "./validation"

export const SKILL_UNUSED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** How long a draft survives past settling or expiry before it is swept. */
export const SKILL_DRAFT_RETENTION_MS = 24 * 60 * 60 * 1000

export type SkillStatus = "active" | "disabled"

export type BrainSkill = {
	id: string
	name: string
	description: string
	body: string
	scope: SkillScope
	status: SkillStatus
	creatorUserId: string
	creatorSlackUserId: string | null
	sourceTeamId: string | null
	origin: SkillOrigin
	sourceThread: string | null
	version: number
	usageCount: number
	lastUsedAt: number | null
	createdAt: number
	updatedAt: number
	rejectionReason: string | null
	unused: boolean
	canEdit: boolean
	canDelete: boolean
}

export type RuntimeSkill = {
	id: string
	name: string
	description: string
	body: string
	version: number
	usageCount: number
	lastUsedAt: number | null
	updatedAt: number
}

export type SkillCreateInput = SkillEditableInput & {
	origin: SkillOrigin
	creatorSlackUserId?: string | null
	sourceTeamId?: string | null
	sourceThread?: string | null
}

export type SkillViewer = { userId: string; isAdmin: boolean }

export class SkillStoreError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "SkillStoreError"
	}
}
export class SkillNotFoundError extends SkillStoreError {
	constructor(message: string) {
		super(message)
		this.name = "SkillNotFoundError"
	}
}
export class SkillForbiddenError extends SkillStoreError {
	constructor(message: string) {
		super(message)
		this.name = "SkillForbiddenError"
	}
}
export class SkillConflictError extends SkillStoreError {
	constructor(message: string) {
		super(message)
		this.name = "SkillConflictError"
	}
}

const ORG_SKILL_ADMIN_ERROR =
	"forbidden: only organization admins and owners can manage organization skills"

/** Organization-wide authoring is an admin/owner capability. Personal
 * ownership is enforced separately because even privileged members may not
 * manage another user's private skill. Exported so request surfaces can fail
 * before Slack lookups. */
export function assertOrgSkillScopeAuthorized(
	scope: SkillScope,
	isAdmin: boolean,
): void {
	if (scope === "org" && !isAdmin) {
		throw new SkillForbiddenError(ORG_SKILL_ADMIN_ERROR)
	}
}

type SkillRow = {
	id: string
	name: string
	description: string
	body: string
	scope: string
	status: string
	creator_user_id: string
	creator_slack_user_id: string | null
	source_team_id: string | null
	origin: string
	source_thread: string | null
	version: number
	usage_count: number
	last_used_at: number | null
	created_at: number
	updated_at: number
	rejection_reason: string | null
}

function rowToSkill(row: SkillRow, now = Date.now()): BrainSkill {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		body: row.body,
		scope: row.scope === "personal" ? "personal" : "org",
		status: row.status === "active" ? "active" : "disabled",
		creatorUserId: row.creator_user_id,
		creatorSlackUserId: row.creator_slack_user_id,
		sourceTeamId: row.source_team_id,
		origin: row.origin as SkillOrigin,
		sourceThread: row.source_thread,
		version: row.version,
		usageCount: row.usage_count,
		lastUsedAt: row.last_used_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		rejectionReason: row.rejection_reason,
		unused:
			row.last_used_at === null
				? now - row.created_at >= SKILL_UNUSED_WINDOW_MS
				: now - row.last_used_at >= SKILL_UNUSED_WINDOW_MS,
		canEdit: false,
		canDelete: false,
	}
}

function rowHasPersonalScope(row: SkillRow): boolean {
	return row.scope === "personal"
}

function rowHasOrgScope(row: SkillRow): boolean {
	return row.scope === "org"
}

function canManageRow(row: SkillRow, viewer: SkillViewer): boolean {
	if (rowHasPersonalScope(row) && row.creator_user_id !== viewer.userId) {
		return false
	}
	if (rowHasOrgScope(row) && !viewer.isAdmin) return false
	return true
}

function withPermissions(
	skill: BrainSkill,
	row: SkillRow,
	viewer: SkillViewer,
): BrainSkill {
	const canManage = canManageRow(row, viewer)
	return {
		...skill,
		canEdit: canManage,
		canDelete: canManage,
	}
}

export function ensureSkillTables(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_skill (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL COLLATE NOCASE,
			description TEXT NOT NULL,
			body TEXT NOT NULL,
			scope TEXT NOT NULL,
			status TEXT NOT NULL,
			creator_user_id TEXT NOT NULL,
			creator_slack_user_id TEXT,
			source_team_id TEXT,
			origin TEXT NOT NULL,
			source_thread TEXT,
			version INTEGER NOT NULL DEFAULT 1,
			usage_count INTEGER NOT NULL DEFAULT 0,
			last_used_at INTEGER,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			rejection_reason TEXT,
			approved_name TEXT,
			approved_description TEXT,
			approved_body TEXT,
			approved_scope TEXT,
			approved_version INTEGER
		)
	`
	// A private skill must not reserve its name org-wide: the resulting conflict
	// would disclose that the private name exists.
	agent.sql`
		CREATE UNIQUE INDEX IF NOT EXISTS brain_skill_org_name_ci
		ON brain_skill(name COLLATE NOCASE) WHERE scope = 'org'
	`
	agent.sql`
		CREATE UNIQUE INDEX IF NOT EXISTS brain_skill_personal_name_ci
		ON brain_skill(creator_user_id, name COLLATE NOCASE) WHERE scope = 'personal'
	`
	agent.sql`CREATE INDEX IF NOT EXISTS brain_skill_creator ON brain_skill(creator_user_id)`
	agent.sql`CREATE INDEX IF NOT EXISTS brain_skill_status_scope ON brain_skill(status, scope)`
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_skill_draft (
			id TEXT PRIMARY KEY,
			status TEXT NOT NULL,
			draft_json TEXT NOT NULL,
			processing_token TEXT,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		)
	`
}

/** Reclaims drafts nobody ever clicked, which is the case that strands a body.
 * Runs on agent start and whenever a draft is written, never on a read path.
 * The window is measured past expiry, so a card still worth clicking survives. */
export function sweepExpiredSkillDrafts(agent: CompanyBrainAgent): void {
	const settledBefore = Date.now() - SKILL_DRAFT_RETENTION_MS
	agent.sql`
		DELETE FROM brain_skill_draft
		WHERE (status IN ('created', 'cancelled') AND created_at < ${settledBefore})
			OR (status IN ('pending', 'processing') AND expires_at < ${settledBefore})
	`
}

function allRows(agent: CompanyBrainAgent): SkillRow[] {
	ensureSkillTables(agent)
	return agent.sql<SkillRow>`
		SELECT id, name, description, body, scope, status,
			creator_user_id, creator_slack_user_id, source_team_id, origin,
			source_thread,
			version, usage_count, last_used_at, created_at, updated_at,
			rejection_reason
		FROM brain_skill ORDER BY updated_at DESC
	`
}

function validationContext(
	agent: CompanyBrainAgent,
	creatorUserId: string,
	excludeId?: string,
) {
	const rows = allRows(agent)
	return {
		existingNames: rows.map((row) => ({
			id: row.id,
			name: row.name,
			scope:
				row.scope === "personal" ? ("personal" as const) : ("org" as const),
			creatorUserId: row.creator_user_id,
		})),
		excludeId,
		creatorUserId,
		orgSkillCount: rows.filter(
			(row) => row.scope === "org" && row.id !== excludeId,
		).length,
		personalSkillCount: rows.filter(
			(row) =>
				row.creator_user_id === creatorUserId &&
				row.scope === "personal" &&
				row.id !== excludeId,
		).length,
	}
}

function remapConstraintError(error: unknown): never {
	const message = error instanceof Error ? error.message : String(error)
	if (/unique|brain_skill_name_ci/i.test(message)) {
		throw new SkillConflictError("a skill with that name already exists")
	}
	throw error
}

export function listSkills(
	agent: CompanyBrainAgent,
	viewer: SkillViewer,
): BrainSkill[] {
	const rows = allRows(agent)
	return rows.flatMap((row) => {
		if (row.creator_user_id === viewer.userId) {
			return [withPermissions(rowToSkill(row), row, viewer)]
		}
		if (viewer.isAdmin && row.scope === "org") {
			return [withPermissions(rowToSkill(row), row, viewer)]
		}
		if (row.scope === "org" && row.status === "active") {
			return [withPermissions(rowToSkill(row), row, viewer)]
		}
		return []
	})
}

export function createSkill(
	agent: CompanyBrainAgent,
	input: SkillCreateInput,
	creatorUserId: string,
	isAdmin: boolean,
): BrainSkill {
	ensureSkillTables(agent)
	const preflight = validateSkillInput(input)
	assertOrgSkillScopeAuthorized(preflight.scope, isAdmin)
	const validated = validateSkillInput(
		preflight,
		validationContext(agent, creatorUserId),
	)
	const id = crypto.randomUUID()
	const now = Date.now()
	try {
		agent.sql`
			INSERT INTO brain_skill (
				id, name, description, body, scope, status,
				creator_user_id, creator_slack_user_id, source_team_id, origin,
				source_thread,
				version, usage_count, last_used_at, created_at, updated_at
			) VALUES (
				${id}, ${validated.name}, ${validated.description}, ${validated.body},
				${validated.scope}, ${"active"}, ${creatorUserId},
				${input.creatorSlackUserId ?? null}, ${input.sourceTeamId ?? null},
				${input.origin},
				${input.sourceThread ?? null}, ${1}, ${0}, ${null}, ${now}, ${now}
			)
		`
	} catch (error) {
		remapConstraintError(error)
	}
	const createdRow = getRow(agent, id)
	if (!createdRow) throw new SkillStoreError("failed to persist skill")
	return withPermissions(rowToSkill(createdRow), createdRow, {
		userId: creatorUserId,
		isAdmin,
	})
}

function assertCanManageCurrentSkill(
	row: SkillRow,
	userId: string,
	isAdmin: boolean,
): void {
	if (rowHasPersonalScope(row) && row.creator_user_id !== userId) {
		throw new SkillForbiddenError("forbidden: not your skill")
	}
	if (rowHasOrgScope(row) && !isAdmin) {
		throw new SkillForbiddenError(ORG_SKILL_ADMIN_ERROR)
	}
}

function assertCanMoveToScope(
	row: SkillRow,
	targetScope: SkillScope,
	userId: string,
	isAdmin: boolean,
): void {
	assertOrgSkillScopeAuthorized(targetScope, isAdmin)
	if (targetScope === "personal" && row.creator_user_id !== userId) {
		throw new SkillForbiddenError(
			"forbidden: only the creator can make a skill personal",
		)
	}
}

function getRow(agent: CompanyBrainAgent, id: string): SkillRow | null {
	ensureSkillTables(agent)
	const rows = agent.sql<SkillRow>`
		SELECT id, name, description, body, scope, status,
			creator_user_id, creator_slack_user_id, source_team_id, origin,
			source_thread,
			version, usage_count, last_used_at, created_at, updated_at,
			rejection_reason
		FROM brain_skill WHERE id = ${id}
	`
	return rows[0] ?? null
}

export function updateSkill(
	agent: CompanyBrainAgent,
	id: string,
	input: SkillEditableInput,
	userId: string,
	isAdmin: boolean,
	expectedVersion: number,
): BrainSkill {
	const existingRow = getRow(agent, id)
	if (!existingRow) throw new SkillNotFoundError("skill not found")
	assertCanManageCurrentSkill(existingRow, userId, isAdmin)
	if (existingRow.version !== expectedVersion) {
		throw new SkillConflictError(
			"a newer version exists; refresh before saving",
		)
	}
	const preflight = validateSkillInput(input)
	assertCanMoveToScope(existingRow, preflight.scope, userId, isAdmin)
	const validated = validateSkillInput(
		preflight,
		validationContext(agent, existingRow.creator_user_id, id),
	)
	const nextVersion = expectedVersion + 1
	let claimed: { id: string }[]
	try {
		claimed = agent.sql<{ id: string }>`
			UPDATE brain_skill SET
				name = ${validated.name}, description = ${validated.description},
				body = ${validated.body}, scope = ${validated.scope},
				status = 'active',
				version = ${nextVersion}, updated_at = ${Date.now()},
				rejection_reason = ${null}, approved_name = ${null},
				approved_description = ${null}, approved_body = ${null},
				approved_scope = ${null}, approved_version = ${null}
			WHERE id = ${id} AND version = ${expectedVersion}
			RETURNING id
		`
	} catch (error) {
		remapConstraintError(error)
	}
	if (!claimed.length) {
		throw new SkillConflictError(
			"a newer version exists; refresh before saving",
		)
	}
	const savedRow = getRow(agent, id)
	if (!savedRow) throw new SkillStoreError("failed to persist skill")
	return withPermissions(rowToSkill(savedRow), savedRow, { userId, isAdmin })
}

export function deleteSkill(
	agent: CompanyBrainAgent,
	id: string,
	userId: string,
	isAdmin: boolean,
	expectedVersion: number,
): BrainSkill | null {
	const existingRow = getRow(agent, id)
	if (!existingRow) return null
	assertCanManageCurrentSkill(existingRow, userId, isAdmin)
	if (existingRow.version !== expectedVersion) {
		throw new SkillConflictError(
			"a newer version exists; refresh before deleting",
		)
	}
	const deleted = agent.sql<{ id: string }>`
		DELETE FROM brain_skill
		WHERE id = ${id} AND version = ${expectedVersion}
		RETURNING id
	`
	if (!deleted.length) {
		throw new SkillConflictError(
			"a newer version exists; refresh before deleting",
		)
	}
	return withPermissions(rowToSkill(existingRow), existingRow, {
		userId,
		isAdmin,
	})
}

function runtimeSkillFromRow(row: SkillRow): RuntimeSkill | null {
	if (row.status !== "active") return null
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		body: row.body,
		version: row.version,
		usageCount: row.usage_count,
		lastUsedAt: row.last_used_at,
		updatedAt: row.updated_at,
	}
}

/** An org skill can be created while a member already holds that name
 * privately, since refusing it would disclose the private name. The viewer's
 * own skill wins that name, and the org one is withheld from this list rather
 * than shown beside it: a name the model can read but cannot resolve to the
 * body it just read is worse than one it never sees. */
export function listVisibleRuntimeSkills(
	agent: CompanyBrainAgent,
	input: { userId?: string },
): RuntimeSkill[] {
	const personal: RuntimeSkill[] = []
	const org: RuntimeSkill[] = []
	for (const row of allRows(agent)) {
		const runtime = runtimeSkillFromRow(row)
		if (!runtime) continue
		if (row.scope === "org") {
			org.push(runtime)
		} else if (
			row.scope === "personal" &&
			input.userId !== undefined &&
			row.creator_user_id === input.userId
		) {
			personal.push(runtime)
		}
	}
	const claimed = new Set(
		SYSTEM_SKILLS.map((skill) => normalizeSkillName(skill.name)),
	)
	const visiblePersonal = personal.filter(
		(skill) => !claimed.has(normalizeSkillName(skill.name)),
	)
	for (const skill of visiblePersonal) {
		claimed.add(normalizeSkillName(skill.name))
	}
	return [
		...SYSTEM_SKILLS,
		...visiblePersonal,
		...org.filter((skill) => !claimed.has(normalizeSkillName(skill.name))),
	]
}

export function loadVisibleSkillByName(
	agent: CompanyBrainAgent,
	input: { userId?: string; name: string },
): RuntimeSkill | null {
	const normalized = input.name.trim().replace(/\s+/g, " ").toLocaleLowerCase()
	const skill = listVisibleRuntimeSkills(agent, input).find(
		(candidate) =>
			candidate.name.trim().replace(/\s+/g, " ").toLocaleLowerCase() ===
			normalized,
	)
	if (!skill) return null
	return recordSkillLoad(agent, skill)
}

export function recordSkillLoad(
	agent: CompanyBrainAgent,
	skill: RuntimeSkill,
): RuntimeSkill {
	if (isSystemSkillId(skill.id)) return skill
	const now = Date.now()
	agent.sql`
		UPDATE brain_skill SET usage_count = usage_count + 1,
			last_used_at = ${now}
		WHERE id = ${skill.id}
	`
	return {
		...skill,
		usageCount: skill.usageCount + 1,
		lastUsedAt: now,
	}
}

function levenshtein(a: string, b: string): number {
	const prev = Array.from({ length: b.length + 1 }, (_, index) => index)
	for (let i = 1; i <= a.length; i++) {
		let diagonal = prev[0] ?? 0
		prev[0] = i
		for (let j = 1; j <= b.length; j++) {
			const above = prev[j] ?? j
			prev[j] = Math.min(
				(prev[j] ?? j) + 1,
				(prev[j - 1] ?? j - 1) + 1,
				diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
			)
			diagonal = above
		}
	}
	return prev[b.length] ?? a.length
}

export function nearestSkillNames(
	name: string,
	skills: Pick<RuntimeSkill, "name">[],
	limit = 5,
): string[] {
	const needle = name.trim().toLocaleLowerCase()
	return skills
		.map((skill) => ({
			name: skill.name,
			distance: levenshtein(needle, skill.name.toLocaleLowerCase()),
		}))
		.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
		.slice(0, Math.max(0, Math.min(5, limit)))
		.map((candidate) => candidate.name)
}

// Re-export caps with the store API for callers that report limits.
export { ORG_SKILL_CAP, PERSONAL_SKILL_CAP }
export type { SkillEditableInput }
