import type { CompanyBrainAgent } from "../../turn/agent"

export const SANDBOX_SESSION_TTL_MS = 60 * 60 * 1000

export type SandboxSession = {
	sessionKey: string
	sandboxId: string
	orgId: string
	userId: string | null
	channel: string | null
	threadTs: string | null
	defaultCwd: string
	repoUrl: string | null
	goal: string | null
	createdAt: number
	updatedAt: number
	expiresAt: number
}

type SandboxSessionRow = {
	session_key: string
	sandbox_id: string
	org_id: string
	user_id: string | null
	channel: string | null
	thread_ts: string | null
	default_cwd: string
	repo_url: string | null
	goal: string | null
	created_at: number
	updated_at: number
	expires_at: number
}

export type SandboxSessionScope = {
	orgId: string
	userId?: string
	channel?: string
	threadTs?: string
	/** Isolates turns that have no thread to key on, which would otherwise share
	 * one session row and overwrite each other when they run concurrently. */
	turnId?: string
}

export function sandboxSessionKey(scope: SandboxSessionScope): string {
	return [
		scope.orgId,
		scope.userId ?? "org",
		scope.channel ?? "api",
		scope.threadTs ?? scope.turnId ?? "turn",
	].join(":")
}

export function ensureSandboxSessionTables(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_sandbox_session (
			session_key TEXT PRIMARY KEY,
			sandbox_id TEXT NOT NULL,
			org_id TEXT NOT NULL,
			user_id TEXT,
			channel TEXT,
			thread_ts TEXT,
			default_cwd TEXT NOT NULL,
			repo_url TEXT,
			goal TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		)
	`
	// Add repo_url to pre-existing tables so reuse can match on repo scope.
	try {
		agent.sql`ALTER TABLE brain_sandbox_session ADD COLUMN repo_url TEXT`
	} catch {}
}

function fromRow(row: SandboxSessionRow): SandboxSession {
	return {
		sessionKey: row.session_key,
		sandboxId: row.sandbox_id,
		orgId: row.org_id,
		userId: row.user_id,
		channel: row.channel,
		threadTs: row.thread_ts,
		defaultCwd: row.default_cwd,
		repoUrl: row.repo_url,
		goal: row.goal,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		expiresAt: row.expires_at,
	}
}

export function loadSandboxSession(
	agent: CompanyBrainAgent,
	sessionKey: string,
): SandboxSession | null {
	const [row] = agent.sql<SandboxSessionRow>`
		SELECT * FROM brain_sandbox_session WHERE session_key = ${sessionKey}
	`
	if (!row) return null
	if (row.expires_at <= Date.now()) {
		deleteSandboxSession(agent, sessionKey)
		return null
	}
	return fromRow(row)
}

export function saveSandboxSession(
	agent: CompanyBrainAgent,
	input: Omit<SandboxSession, "createdAt" | "updatedAt" | "expiresAt"> & {
		createdAt?: number
		updatedAt?: number
		expiresAt?: number
	},
): SandboxSession {
	const now = Date.now()
	const createdAt = input.createdAt ?? now
	const updatedAt = input.updatedAt ?? now
	const expiresAt = input.expiresAt ?? now + SANDBOX_SESSION_TTL_MS
	agent.sql`
		INSERT INTO brain_sandbox_session (
			session_key, sandbox_id, org_id, user_id, channel, thread_ts,
			default_cwd, repo_url, goal, created_at, updated_at, expires_at
		) VALUES (
			${input.sessionKey}, ${input.sandboxId}, ${input.orgId}, ${input.userId ?? null},
			${input.channel ?? null}, ${input.threadTs ?? null}, ${input.defaultCwd},
			${input.repoUrl ?? null}, ${input.goal ?? null}, ${createdAt}, ${updatedAt}, ${expiresAt}
		)
		ON CONFLICT(session_key) DO UPDATE SET
			sandbox_id = excluded.sandbox_id,
			default_cwd = excluded.default_cwd,
			repo_url = excluded.repo_url,
			goal = excluded.goal,
			updated_at = excluded.updated_at,
			expires_at = excluded.expires_at
	`
	return {
		...input,
		userId: input.userId ?? null,
		channel: input.channel ?? null,
		threadTs: input.threadTs ?? null,
		repoUrl: input.repoUrl ?? null,
		goal: input.goal ?? null,
		createdAt,
		updatedAt,
		expiresAt,
	}
}

export function touchSandboxSession(
	agent: CompanyBrainAgent,
	session: SandboxSession,
): SandboxSession {
	return saveSandboxSession(agent, {
		...session,
		updatedAt: Date.now(),
		expiresAt: Date.now() + SANDBOX_SESSION_TTL_MS,
	})
}

export function deleteSandboxSession(
	agent: CompanyBrainAgent,
	sessionKey: string,
): void {
	agent.sql`
		DELETE FROM brain_sandbox_session WHERE session_key = ${sessionKey}
	`
}
