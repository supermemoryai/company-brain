import { captureException } from "@/lib/capture"
import { BrainCostLedger, chargeBrainLlmCost } from "../billing/cost"
import {
	getBrainMemoryResetEpoch,
	isBrainMemoryResetEpochCurrent,
} from "../memory/tree"
import { openSlackConversation } from "../slack/client"
import { loadOrgSlackContext } from "../slack/org-context"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { loadOrg } from "../turn/research"
import { type DraftJob, runDraft } from "./draft"
import { derivePlan } from "./plan"
import { loadRecipientRoster } from "./roster"
import {
	ensureAutoResearchDraftTable,
	insertAutoResearchDraft,
	pendingDraftBodies,
	sentDraftBodies,
} from "./store"
import { ensureWatchTargetTable, rankedWatchTargets } from "./watchlist"

export const AUTO_RESEARCH_CALLBACK = "runAutoResearch" as const

// Manual-only: an admin triggers a run from the observatory, it drafts, and every
// draft waits for a human to send it. Nothing here reaches Slack.

// DO-local lease so two triggers can't run the same org concurrently. TTL bounds a
// crashed run's hold; the owner token stops an expired run releasing a newer lease.
const LEASE_TTL_MS = 15 * 60_000
// A whole round now fits in one batch, so renewal can't ride on batch boundaries.
const LEASE_HEARTBEAT_MS = 5 * 60_000

function ensureLockTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_auto_research_lock (
			id INTEGER PRIMARY KEY,
			locked_until INTEGER NOT NULL,
			owner TEXT
		)
	`
	const cols = agent.sql<{
		name: string
	}>`PRAGMA table_info(brain_auto_research_lock)`
	if (!cols.some((c) => c.name === "owner"))
		agent.sql`ALTER TABLE brain_auto_research_lock ADD COLUMN owner TEXT`
	// Guarded per column: grouping them means a table that already has one never
	// gets the rest, and every progress write then fails on a missing column.
	if (!cols.some((c) => c.name === "phase"))
		agent.sql`ALTER TABLE brain_auto_research_lock ADD COLUMN phase TEXT`
	if (!cols.some((c) => c.name === "jobs_total"))
		agent.sql`ALTER TABLE brain_auto_research_lock ADD COLUMN jobs_total INTEGER`
	if (!cols.some((c) => c.name === "jobs_done"))
		agent.sql`ALTER TABLE brain_auto_research_lock ADD COLUMN jobs_done INTEGER`
	if (!cols.some((c) => c.name === "jobs_active"))
		agent.sql`ALTER TABLE brain_auto_research_lock ADD COLUMN jobs_active INTEGER`
	if (!cols.some((c) => c.name === "last_outcome"))
		agent.sql`ALTER TABLE brain_auto_research_lock ADD COLUMN last_outcome TEXT`
	if (!cols.some((c) => c.name === "last_outcome_at"))
		agent.sql`ALTER TABLE brain_auto_research_lock ADD COLUMN last_outcome_at INTEGER`
}

// "Running" alone can't distinguish planning from a stalled batch, so the run
// reports where it actually is. Owner-scoped like renew and release: a run
// unwinding after losing its lease must not overwrite the new owner's counts.
function setAutoResearchProgress(
	agent: CompanyBrainAgent,
	token: string,
	phase: string,
	total = 0,
	done = 0,
	active = 0,
): void {
	agent.sql`
		UPDATE brain_auto_research_lock
		SET phase = ${phase}, jobs_total = ${total}, jobs_done = ${done},
			jobs_active = ${active}
		WHERE id = 1 AND owner = ${token}
	`
}

// Check-and-set is atomic within one DO tick (no await between read and write).
// `force` steals a held lease: a worker restart mid-run leaves one behind with no
// live run to release it, and an admin can see there's nothing actually running.
function acquireAutoResearchLease(
	agent: CompanyBrainAgent,
	force = false,
): string | null {
	ensureLockTable(agent)
	const now = Date.now()
	const held = agent.sql<{ locked_until: number }>`
		SELECT locked_until FROM brain_auto_research_lock WHERE id = 1
	`[0]
	if (held && held.locked_until > now && !force) return null
	const token = crypto.randomUUID()
	const until = now + LEASE_TTL_MS
	agent.sql`
		INSERT INTO brain_auto_research_lock (id, locked_until, owner) VALUES (1, ${until}, ${token})
		ON CONFLICT(id) DO UPDATE SET locked_until = ${until}, owner = ${token}
	`
	return token
}

// A worker restart mid-run (deploy, reload) leaves the lease held until it expires,
// so the trigger reports it rather than silently doing nothing.
export function autoResearchRunState(agent: CompanyBrainAgent): {
	running: boolean
	freeAt: number | null
	phase: string | null
	jobsTotal: number
	jobsDone: number
	jobsActive: number
	lastOutcome: string | null
	lastOutcomeAt: number | null
} {
	ensureLockTable(agent)
	const held = agent.sql<{
		locked_until: number
		phase: string | null
		jobs_total: number | null
		jobs_done: number | null
		jobs_active: number | null
		last_outcome: string | null
		last_outcome_at: number | null
	}>`SELECT * FROM brain_auto_research_lock WHERE id = 1`[0]
	const running = Boolean(held && held.locked_until > Date.now())
	return {
		running,
		freeAt: running ? (held?.locked_until ?? null) : null,
		phase: running ? (held?.phase ?? null) : null,
		jobsTotal: running ? (held?.jobs_total ?? 0) : 0,
		jobsDone: running ? (held?.jobs_done ?? 0) : 0,
		jobsActive: running ? (held?.jobs_active ?? 0) : 0,
		// Not gated on `running`: its whole job is explaining a finished round.
		lastOutcome: held?.last_outcome ?? null,
		lastOutcomeAt: held?.last_outcome_at ?? null,
	}
}

// Each job is a full agent turn, so a run can outlive the TTL. Renew between jobs
// rather than holding a long lease that a crash would sit on.
function renewAutoResearchLease(
	agent: CompanyBrainAgent,
	token: string,
): boolean {
	agent.sql`
		UPDATE brain_auto_research_lock SET locked_until = ${Date.now() + LEASE_TTL_MS}
		WHERE id = 1 AND owner = ${token}
	`
	const held = agent.sql<{ owner: string | null }>`
		SELECT owner FROM brain_auto_research_lock WHERE id = 1
	`[0]
	return held?.owner === token
}

const SKIP_WORDING: Record<string, string> = {
	nothing_to_say: "the model found nothing new worth sending",
	empty_body: "the model returned an empty note",
	ownership_lost: "another run took over before it could be stored",
}

// Says what actually happened. A single hardcoded explanation was wrong whenever
// the real reason differed, which is worse than saying nothing.
function runOutcome(
	drafted: number,
	planned: number,
	skipped: string[],
): string {
	if (!planned)
		return "Nothing planned: no channel targets or people came out of planning for this round."
	const reasons = [...new Set(skipped)].map(
		(r) =>
			SKIP_WORDING[r] ??
			(r.startsWith("turn_") ? `the drafting turn ended as ${r.slice(5)}` : r),
	)
	const tail = reasons.length ? ` Skipped: ${reasons.join("; ")}.` : ""
	if (drafted) return `Drafted ${drafted} of ${planned} planned notes.${tail}`
	return `Planned ${planned} ${planned === 1 ? "note" : "notes"} but kept none.${tail}`
}

// A finished run leaves no trace in the console otherwise: it flips back to idle
// and the operator can't tell a skipped round from a crashed one.
function setAutoResearchOutcome(
	agent: CompanyBrainAgent,
	outcome: string,
): void {
	ensureLockTable(agent)
	agent.sql`
		UPDATE brain_auto_research_lock
		SET last_outcome = ${outcome}, last_outcome_at = ${Date.now()}
		WHERE id = 1
	`
}

// Sync, so a caller can pair it with a write in the same DO tick.
function holdsAutoResearchLease(
	agent: CompanyBrainAgent,
	token: string,
): boolean {
	const held = agent.sql<{ owner: string | null; locked_until: number }>`
		SELECT owner, locked_until FROM brain_auto_research_lock WHERE id = 1
	`[0]
	return held?.owner === token && held.locked_until > Date.now()
}

function releaseAutoResearchLease(
	agent: CompanyBrainAgent,
	token: string,
): void {
	ensureLockTable(agent)
	agent.sql`UPDATE brain_auto_research_lock SET locked_until = 0 WHERE id = 1 AND owner = ${token}`
}

// Deleting the code that registered the cron doesn't cancel schedules already held
// by a Durable Object. Crons only, so a queued manual run is untouched.
export async function cancelAutoResearchSchedules(
	agent: CompanyBrainAgent,
): Promise<void> {
	const retired = agent
		.getSchedules<AutoResearchPayload>()
		.filter((s) => s.callback === AUTO_RESEARCH_CALLBACK && s.type === "cron")
	if (!retired.length) return
	await Promise.all(
		retired.map((s) => agent.cancelSchedule(s.id).catch(() => {})),
	)
	console.log(
		`[company-brain] auto-research retired cron cancelled org=${agent.name} count=${retired.length}`,
	)
}

export type AutoResearchPayload = {
	/** Free-text direction from the operator who triggered the run. */
	steer?: string
	maxTargets?: number
	maxPeople?: number
	/** Steal a lease left behind by a run that died with the worker. */
	force?: boolean
}

// Turns are almost all model and tool I/O, so they overlap fine inside one DO.
// Sized to cover a whole round in one batch: a round then costs one draft's
// wall time instead of ceil(jobs / concurrency) times it.
const DRAFT_CONCURRENCY = 6
const DEFAULT_MAX_TARGETS = 3
const DEFAULT_MAX_PEOPLE = 2

// plan → draft each item → store. One ledger spans the run for cost visibility;
// the org is never billed for work it didn't ask for. Never throws.
export async function runAutoResearch(
	agent: CompanyBrainAgent,
	payload: AutoResearchPayload = {},
): Promise<void> {
	const orgId = agent.name
	const env = brainAgent(agent).env
	const lease = acquireAutoResearchLease(agent, payload.force)
	if (!lease) {
		console.log(
			`[company-brain] auto-research skipped: run in progress org=${orgId}`,
		)
		return
	}
	// If an org reset advances this mid-run, abort before storing stale drafts.
	const resetEpoch = getBrainMemoryResetEpoch(agent)
	const ledger = new BrainCostLedger()
	try {
		setAutoResearchProgress(agent, lease, "planning")
		const org = await loadOrg(agent)
		if (!org) {
			console.warn(`[company-brain] auto-research aborted: no org org=${orgId}`)
			return
		}
		const slack = await loadOrgSlackContext(agent)
		const roster = slack
			? await loadRecipientRoster(agent, {
					teamId: slack.teamId,
					botToken: slack.botToken,
				})
			: []
		const alreadySent = sentDraftBodies(agent)
		const alreadyDrafted = pendingDraftBodies(agent)
		const planResult = await derivePlan(agent, {
			steer: payload.steer,
			sentBodies: alreadySent,
			draftedBodies: alreadyDrafted,
			roster,
			costLedger: ledger,
		})
		if (!planResult.plan) {
			setAutoResearchOutcome(
				agent,
				planResult.reason === "no_context"
					? "Nothing planned: this org has no company context, brain profile, or tracked topics yet, so there was no lens to research against."
					: "Nothing planned: the planning step failed. Check the logs for this run.",
			)
			return
		}
		const plan = planResult.plan

		// Earned watch targets that the planner didn't raise itself still deserve a
		// look, so they can't starve behind freshly derived ones.
		const maxTargets = payload.maxTargets ?? DEFAULT_MAX_TARGETS
		const planned = new Set(
			plan.targets.map((t) => `${t.kind}:${t.label.toLowerCase()}`),
		)
		// Backfill only fills an unsteered round. An operator who said what this
		// round is for shouldn't get watchlist topics they didn't ask for.
		const revisits = payload.steer?.trim()
			? []
			: rankedWatchTargets(agent)
					.filter((t) => !planned.has(`${t.kind}:${t.label.toLowerCase()}`))
					.slice(0, Math.max(0, maxTargets - plan.targets.length))
					.map((t) => ({
						kind: t.kind,
						label: t.label,
						angle: `Something new since we last mentioned ${t.label}.`,
					}))

		// Person notes run FIRST: they're the harder, more valuable half, and a round
		// is capped, so putting them last is what makes them get starved.
		const jobs: DraftJob[] = []
		if (slack) {
			for (const person of plan.people.slice(
				0,
				payload.maxPeople ?? DEFAULT_MAX_PEOPLE,
			)) {
				// Opening the IM only resolves the channel; it posts nothing.
				const dmChannelId = await openSlackConversation(
					slack.botToken,
					person.recipient.slackUserId,
				)
				if (dmChannelId) jobs.push({ kind: "dm", person, dmChannelId })
			}
		}
		for (const target of [...plan.targets, ...revisits].slice(0, maxTargets))
			jobs.push({ kind: "channel", target })

		ensureAutoResearchDraftTable(agent)
		ensureWatchTargetTable(agent)
		let drafted = 0
		const skipped: string[] = []
		let done = 0
		let active = 0
		setAutoResearchProgress(agent, lease, "drafting", jobs.length)
		// Batched rather than serial: a round used to cost the sum of every draft.
		for (let i = 0; i < jobs.length; i += DRAFT_CONCURRENCY) {
			// A stolen or expired lease means someone else owns the run now.
			if (!renewAutoResearchLease(agent, lease)) {
				console.log(
					`[company-brain] auto-research stopped: lease lost org=${orgId}`,
				)
				return
			}
			const batch = jobs.slice(i, i + DRAFT_CONCURRENCY)
			active = batch.length
			console.log(
				`[company-brain] auto-research batch org=${orgId} jobs=${i + 1}-${i + batch.length}/${jobs.length}`,
			)
			setAutoResearchProgress(
				agent,
				lease,
				"drafting",
				jobs.length,
				done,
				active,
			)
			// Never fatal: the owner-conditional insert is what guarantees correctness,
			// so a heartbeat that can't run only costs us the lease, not the round.
			const heartbeat = setInterval(() => {
				try {
					if (!renewAutoResearchLease(agent, lease))
						console.log(
							`[company-brain] auto-research lease lost mid-batch org=${orgId}`,
						)
				} catch {}
			}, LEASE_HEARTBEAT_MS)
			try {
				await Promise.all(
					batch.map(async (job) => {
						try {
							const result = await runDraft({
								agent,
								org,
								focus: plan.focus,
								steer: payload.steer,
								alreadySent,
								alreadyDrafted,
								job,
								slack,
								fallbackUserId: slack?.installedByUserId ?? orgId,
								env,
							})
							// Stored as each settles, so a finished draft doesn't wait on the
							// slowest sibling to survive a restart. Both guards are read in
							// the same tick as the insert: a reset can land mid-draft, and a
							// lease that expired or was force-taken means this run's output
							// no longer belongs in the queue.
							if (!result.draft) {
								skipped.push(result.reason)
							} else if (
								isBrainMemoryResetEpochCurrent(agent, resetEpoch) &&
								holdsAutoResearchLease(agent, lease)
							) {
								insertAutoResearchDraft(agent, result.draft)
								drafted++
							} else {
								skipped.push("ownership_lost")
								console.log(
									`[company-brain] auto-research draft discarded org=${orgId} kind=${job.kind} reason=ownership_lost`,
								)
							}
						} catch (err) {
							console.warn(
								`[company-brain] auto-research draft error org=${orgId} kind=${job.kind}:`,
								err instanceof Error ? err.message : err,
							)
						} finally {
							done++
							active--
							setAutoResearchProgress(
								agent,
								lease,
								"drafting",
								jobs.length,
								done,
								active,
							)
						}
					}),
				)
			} finally {
				clearInterval(heartbeat)
			}
			if (!isBrainMemoryResetEpochCurrent(agent, resetEpoch)) {
				console.log(
					`[company-brain] auto-research aborted: reset during run org=${orgId}`,
				)
				return
			}
		}
		console.log(
			`[company-brain] auto-research run org=${orgId} jobs=${jobs.length} drafted=${drafted}`,
		)
		setAutoResearchOutcome(agent, runOutcome(drafted, jobs.length, skipped))
	} catch (err) {
		captureException(err instanceof Error ? err : new Error(String(err)), {
			tags: { component: "auto-research-run" },
		})
	} finally {
		releaseAutoResearchLease(agent, lease)
		// Measured for our own visibility, never billed: nobody asked for this run.
		await chargeBrainLlmCost({
			orgId,
			ledger,
			source: "auto_research",
			env,
			skipBilling: true,
		}).catch((err) =>
			console.warn(
				"[company-brain-billing] auto_research failed:",
				err instanceof Error ? err.message : err,
			),
		)
	}
}

// Org reset: wipe accumulated drafts and watch targets so nothing stale reappears.
export async function resetAutoResearch(
	agent: CompanyBrainAgent,
): Promise<void> {
	await cancelAutoResearchSchedules(agent)
	ensureWatchTargetTable(agent)
	ensureAutoResearchDraftTable(agent)
	ensureLockTable(agent)
	agent.sql`DELETE FROM brain_watch_target`
	agent.sql`DELETE FROM brain_auto_research_draft`
	agent.sql`DELETE FROM brain_auto_research_lock`
}
