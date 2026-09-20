import type { CompanyBrainAgent } from "../turn/agent"

// The lean, EARNED watchlist: entities that earned a slot by producing a real post.
// Recency-weighted, prunable, and deletable so it stays small and high-signal.

export type WatchTargetKind =
	| "competitor"
	| "person"
	| "product"
	| "topic"
	| "term"

export type WatchTarget = {
	id: string
	kind: WatchTargetKind
	label: string
	createdAt: number
	updatedAt: number
}

export function ensureWatchTargetTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_watch_target (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			label TEXT NOT NULL,
			norm_label TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`
	agent.sql`
		CREATE UNIQUE INDEX IF NOT EXISTS brain_watch_target_kind_label
		ON brain_watch_target (kind, norm_label)
	`
}

type WatchTargetRow = {
	id: string
	kind: string
	label: string
	created_at: number
	updated_at: number
}

function rowToWatchTarget(row: WatchTargetRow): WatchTarget {
	return {
		id: row.id,
		kind: row.kind as WatchTargetKind,
		label: row.label,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

export function listWatchTargets(agent: CompanyBrainAgent): WatchTarget[] {
	ensureWatchTargetTable(agent)
	return agent.sql<WatchTargetRow>`
		SELECT id, kind, label, created_at, updated_at
		FROM brain_watch_target ORDER BY updated_at DESC
	`.map(rowToWatchTarget)
}

// Add or refresh a target, deduped by (kind, label); refreshing bumps recency.
export function upsertWatchTarget(
	agent: CompanyBrainAgent,
	input: { kind: WatchTargetKind; label: string },
): void {
	ensureWatchTargetTable(agent)
	const label = input.label.trim()
	const normLabel = label.toLowerCase()
	const now = Date.now()
	const existing = agent.sql<{ id: string }>`
		SELECT id FROM brain_watch_target
		WHERE kind = ${input.kind} AND norm_label = ${normLabel}
	`[0]
	if (existing) {
		agent.sql`UPDATE brain_watch_target SET updated_at = ${now} WHERE id = ${existing.id}`
		return
	}
	agent.sql`
		INSERT INTO brain_watch_target (id, kind, label, norm_label, created_at, updated_at)
		VALUES (${crypto.randomUUID()}, ${input.kind}, ${label}, ${normLabel}, ${now}, ${now})
	`
}

// Remove a target — curation, or decay of a stale entry. By id, or (kind,label).
export function deleteWatchTarget(
	agent: CompanyBrainAgent,
	target: { id?: string; kind?: WatchTargetKind; label?: string },
): void {
	ensureWatchTargetTable(agent)
	if (target.id) {
		agent.sql`DELETE FROM brain_watch_target WHERE id = ${target.id}`
		return
	}
	if (target.kind && target.label) {
		const normLabel = target.label.trim().toLowerCase()
		agent.sql`DELETE FROM brain_watch_target WHERE kind = ${target.kind} AND norm_label = ${normLabel}`
	}
}

export type RankedWatchTarget = WatchTarget & { weight: number }

// Recency weight: a target seen this run scores ~1, older ones decay toward 0
// (14-day half-life). Differentiates across runs; within a run fresh targets tie.
export function rankedWatchTargets(
	agent: CompanyBrainAgent,
	opts: { now?: number; halfLifeDays?: number } = {},
): RankedWatchTarget[] {
	const now = opts.now ?? Date.now()
	const halfLife = (opts.halfLifeDays ?? 14) * 86_400_000
	return listWatchTargets(agent)
		.map((t) => ({ ...t, weight: 0.5 ** ((now - t.updatedAt) / halfLife) }))
		.sort((a, b) => b.weight - a.weight || b.updatedAt - a.updatedAt)
}

// Keep the watchlist lean: retain the top `max` by recency weight, drop the rest.
export function pruneWatchTargets(
	agent: CompanyBrainAgent,
	opts: { max?: number } = {},
): void {
	const max = opts.max ?? 20
	for (const t of rankedWatchTargets(agent).slice(max))
		agent.sql`DELETE FROM brain_watch_target WHERE id = ${t.id}`
}
