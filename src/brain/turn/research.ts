import { generateText, Output } from "ai"
import { z } from "zod"
import { fastModel } from "@/config"
import { getGenerateTextStructuredOutput } from "@/lib/ai-utils"
import {
	type ContextSearchRequest,
	contextScrapeMarkdown,
	contextSearch,
	creditsUsd,
	hasContextWeb,
} from "@/lib/context-dev"
import {
	BrainCostLedger,
	recordFinishEvent,
	scheduleChargeBrainLlmCost,
} from "../billing/cost"
import { FAST_MODEL_BILLING_NAME } from "../billing/model-prices"
import {
	getBrainMemoryResetEpoch,
	isBrainMemoryResetEpochCurrent,
} from "../memory/tree"
import { flushBrainTelemetry } from "../observability"
import type { SlackOrg } from "../slack/workspace"
import { brainAgent, type CompanyBrainAgent } from "./agent"
import { getHomeChannel } from "./home-channel"

export type ResearchOnSignupInput = {
	domain: string
	ownerId: string
	force?: boolean
	runId?: number
	resetEpoch?: number
}

export type ResearchStat = { label: string; value: string }

export type ResearchEvent = {
	aspect: string
	label: string
	status: string
	detail: string | null
	stats: ResearchStat[]
	highlights: string[]
	sources: string[]
	createdAt: number
}

export type ResearchState = {
	status: string | null
	domain: string | null
	findings: number
	events: ResearchEvent[]
}

// Quick setup beats up front so the flow ramps from fast prep into slower research.
const SETUP_STEPS: { key: string; title: string; delayMs: number }[] = [
	{
		key: "workspace",
		title: "Setting up your Company Brain workspace",
		delayMs: 600,
	},
	{ key: "prepare", title: "Preparing deep research", delayMs: 700 },
]

type ResearchAspect = {
	key: string
	title: string
	query: (domain: string, orgName: string) => string
	instruction: (domain: string, orgName: string) => string
	freshness?: ContextSearchRequest["freshness"]
}

// Unstarted aspects must still render or Slack marks the plan complete.
export const RESEARCH_ASPECT_PLAN: { key: string; title: string }[] = [
	{ key: "overview", title: "Company overview" },
	{ key: "products", title: "Products & offerings" },
	{ key: "people", title: "Team & key people" },
	{ key: "work", title: "Notable projects & work" },
	{ key: "competitors", title: "Competitors" },
	{ key: "traction", title: "Recent milestones" },
]

const PLAIN = "Plain text, no preamble, no markdown."

const RESEARCH_ASPECTS: ResearchAspect[] = [
	{
		key: "overview",
		title: "Company overview",
		query: (domain, name) =>
			`${name} ${domain} company overview industry headquarters founded`,
		instruction: (domain, name) =>
			`In 2-3 sentences, what does "${name}" (${domain}) do — industry, mission, approximate size, headquarters, and founding year? ${PLAIN}`,
	},
	{
		key: "products",
		title: "Products & offerings",
		query: (domain, name) =>
			`${name} ${domain} products services pricing customers`,
		instruction: (domain, name) =>
			`In 2-3 sentences, what are "${name}"'s (${domain}) main products, services, and offerings, and who are their customers or users? ${PLAIN}`,
	},
	{
		key: "people",
		title: "Team & key people",
		query: (domain, name) => `${name} ${domain} founders CEO leadership team`,
		instruction: (domain, name) =>
			`Name the founders, leadership, and notable people at "${name}" (${domain}) with their roles, in 2-3 sentences. ${PLAIN}`,
	},
	{
		key: "work",
		title: "Notable projects & work",
		query: (domain, name) =>
			`${name} ${domain} notable projects open source github engineering`,
		instruction: (domain, name) =>
			`In 2-3 sentences, what is "${name}"'s (${domain}) notable work — flagship projects, open-source or GitHub presence, engineering or product output? ${PLAIN}`,
	},
	{
		key: "competitors",
		title: "Competitors",
		query: (domain, name) => `${name} ${domain} competitors alternatives vs`,
		instruction: (domain, name) =>
			`In 2-3 sentences, who does "${name}" (${domain}) compete with, and how do they position against them? Name the actual competing companies. ${PLAIN}`,
	},
	{
		key: "traction",
		title: "Recent milestones",
		query: (domain, name) =>
			`${name} ${domain} funding round launch partnership customers news`,
		instruction: (domain, name) =>
			`In 2-3 sentences, what are "${name}"'s (${domain}) recent milestones — funding, launches, partnerships, major customers, or news from the past year? ${PLAIN}`,
		freshness: "last_year",
	},
]

const RESEARCH_SEARCH_TIMEOUT_MS = 15_000
const RESEARCH_SCRAPE_TIMEOUT_MS = 30_000
const RESEARCH_RESULTS = 6
const HOMEPAGE_EXCERPT_CHARS = 6_000
const NO_INFO = "NO_INFO"

export type ResearchWebInput = {
	query: string
	instruction: string
	freshness?: ContextSearchRequest["freshness"]
	page?: ResearchPage | null
}

export type ResearchPage = { url: string; markdown: string }

// One credit for the company's own site beats six snippet-only aspect searches.
export async function researchHomepage(
	env: Env,
	domain: string,
	costLedger?: BrainCostLedger,
): Promise<ResearchPage | null> {
	if (!hasContextWeb(env)) return null
	const url = `https://${domain}`
	try {
		const page = await contextScrapeMarkdown(
			env,
			url,
			RESEARCH_SCRAPE_TIMEOUT_MS,
		)
		costLedger?.recordVendorUsd("context.dev", creditsUsd(page))
		const markdown = page.markdown?.trim()
		return markdown
			? { url, markdown: markdown.slice(0, HOMEPAGE_EXCERPT_CHARS) }
			: null
	} catch (err) {
		console.warn("[company-brain] research homepage scrape failed:", err)
		return null
	}
}

// Snippets are not an answer, so the fast model writes the blurb from them.
export async function brainWebSearch(
	env: Env,
	input: ResearchWebInput,
	costLedger?: BrainCostLedger,
): Promise<{ summary: string; sources: string[] } | null> {
	if (!hasContextWeb(env)) return null
	try {
		const response = await contextSearch(env, {
			query: input.query,
			timeoutMS: RESEARCH_SEARCH_TIMEOUT_MS,
			...(input.freshness ? { freshness: input.freshness } : {}),
		})
		costLedger?.recordVendorUsd("context.dev", creditsUsd(response))
		const results = (response.results ?? []).slice(0, RESEARCH_RESULTS)
		if (!results.length) return null
		const evidence = results
			.map((r) => `- ${r.title}\n  ${r.url}\n  ${r.description}`)
			.join("\n")
		const site = input.page
			? `\n\nThe company's own website (${input.page.url}):\n${input.page.markdown}`
			: ""
		const result = await generateText({
			model: fastModel(),
			prompt: `${input.instruction}\n\nUse only the sources below and do not invent facts. If they do not answer the question, reply with exactly ${NO_INFO}.${site}\n\nWeb search results:\n${evidence}`,
		})
		if (costLedger) {
			recordFinishEvent(costLedger, result, FAST_MODEL_BILLING_NAME)
		}
		const clean = result.text.trim()
		if (!clean || clean.includes(NO_INFO)) return null
		const sources = Array.from(
			new Set([
				...(input.page ? [input.page.url] : []),
				...results.map((r) => r.url),
			]),
		).slice(0, 6)
		return { summary: clean, sources }
	} catch (err) {
		console.warn("[company-brain] research web error:", err)
		return null
	}
}

const HighlightsSchema = z.object({
	stats: z
		.array(z.object({ label: z.string(), value: z.string() }))
		.describe(
			"0-4 headline factual stats as short label/value pairs, e.g. {label:'Founded', value:'2011'}, {label:'Employees', value:'~900'}, {label:'MAU', value:'100M'}. Empty if none are clearly stated.",
		),
	highlights: z
		.array(z.string())
		.describe(
			"0-5 SHORT chips, max ~4 words each: proper nouns only — people with role (e.g. 'Luis von Ahn — CEO'), product names, or project names. NO sentences, NO descriptions, NO mission statements.",
		),
})

// Best-effort structured enrichment on top of the grounded summary. Never throws.
async function extractHighlights(
	summary: string,
	costLedger?: BrainCostLedger,
): Promise<{ stats: ResearchStat[]; highlights: string[] }> {
	try {
		const result = await generateText({
			model: fastModel(),
			prompt: `Extract structured highlights from this company research text. Only use facts present in the text; do not invent.\n\nText: ${summary}`,
			output: Output.object({ schema: HighlightsSchema }),
		})
		if (costLedger) {
			recordFinishEvent(costLedger, result, FAST_MODEL_BILLING_NAME)
		}
		const out = getGenerateTextStructuredOutput(result, HighlightsSchema)
		return {
			stats: (out.stats ?? []).slice(0, 4),
			highlights: (out.highlights ?? []).slice(0, 6),
		}
	} catch (err) {
		console.warn("[company-brain] extractHighlights error:", err)
		return { stats: [], highlights: [] }
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

// The company to research is the domain, not the org's (possibly stale) name.
function companyNameFromDomain(domain: string): string {
	const host = domain
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/^www\./, "")
		.replace(/\/.*$/, "")
	const label = host.split(".")[0] || host
	return label.charAt(0).toUpperCase() + label.slice(1)
}

function researchAspectCustomId(
	orgId: string,
	aspect: string,
	resetEpoch: number,
): string {
	return `company-brain-research:${orgId}:${aspect}:epoch${resetEpoch}`
}

function ensureResearchTables(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_research (
			id INTEGER PRIMARY KEY,
			status TEXT NOT NULL,
			domain TEXT,
			findings INTEGER NOT NULL DEFAULT 0,
			run_id INTEGER NOT NULL DEFAULT 0,
			updated_at INTEGER NOT NULL
		)
	`
	// Add run_id to pre-existing tables (guards against overlapping runs).
	try {
		agent.sql`ALTER TABLE brain_research ADD COLUMN run_id INTEGER NOT NULL DEFAULT 0`
	} catch {}
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_research_phase (
			aspect TEXT PRIMARY KEY,
			ord INTEGER NOT NULL,
			label TEXT NOT NULL,
			status TEXT NOT NULL,
			detail TEXT,
			extra TEXT,
			created_at INTEGER NOT NULL
		)
	`
	// Add the extra (stats/highlights/sources JSON) column to pre-existing tables.
	try {
		agent.sql`ALTER TABLE brain_research_phase ADD COLUMN extra TEXT`
	} catch {}
}

function researchStatus(agent: CompanyBrainAgent): string | null {
	const rows = agent.sql<{ status: string }>`
		SELECT status FROM brain_research WHERE id = 1
	`
	return rows[0]?.status ?? null
}

function researchDomain(agent: CompanyBrainAgent): string | null {
	const rows = agent.sql<{ domain: string | null }>`
		SELECT domain FROM brain_research WHERE id = 1
	`
	return rows[0]?.domain ?? null
}

function getRunId(agent: CompanyBrainAgent): number {
	const rows = agent.sql<{ run_id: number }>`
		SELECT run_id FROM brain_research WHERE id = 1
	`
	return rows[0]?.run_id ?? 0
}

// Bump the run generation so any in-flight run detects it has been superseded.
function bumpRunId(agent: CompanyBrainAgent): number {
	const next = getRunId(agent) + 1
	const now = Date.now()
	agent.sql`
		INSERT INTO brain_research (id, status, run_id, updated_at)
		VALUES (1, 'queued', ${next}, ${now})
		ON CONFLICT(id) DO UPDATE SET run_id = ${next}, updated_at = ${now}
	`
	return next
}

function setResearchStatus(
	agent: CompanyBrainAgent,
	status: string,
	fields: { domain?: string; findings?: number } = {},
): void {
	const now = Date.now()
	agent.sql`
		INSERT INTO brain_research (id, status, domain, findings, updated_at)
		VALUES (1, ${status}, ${fields.domain ?? null}, ${fields.findings ?? 0}, ${now})
		ON CONFLICT(id) DO UPDATE SET
			status = ${status},
			domain = COALESCE(${fields.domain ?? null}, brain_research.domain),
			findings = ${fields.findings ?? 0},
			updated_at = ${now}
	`
}

// One row per research phase; upsert flips it from in_progress to complete/error
// in place, so the timeline reads as clean phases instead of repeated tool calls.
function ensureResearchCardTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_research_card (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			message_ts TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			block_id TEXT NOT NULL,
			team_id TEXT,
			run_id INTEGER NOT NULL DEFAULT 0
		)
	`
	// Pre-existing rows have no workspace or run, so they must not be reused.
	try {
		agent.sql`ALTER TABLE brain_research_card ADD COLUMN team_id TEXT`
	} catch {}
	try {
		agent.sql`ALTER TABLE brain_research_card ADD COLUMN run_id INTEGER NOT NULL DEFAULT 0`
	} catch {}
}

// The DO yields at the Slack await, so overlapping syncs would post twice.
const cardSyncTail = new WeakMap<CompanyBrainAgent, Promise<void>>()

function syncResearchCard(
	agent: CompanyBrainAgent,
	companyName: string,
	done: boolean,
): Promise<void> {
	const next = (cardSyncTail.get(agent) ?? Promise.resolve()).then(() =>
		syncResearchCardNow(agent, companyName, done),
	)
	cardSyncTail.set(agent, next)
	return next
}

// Renders live research progress as a Slack plan card in the home channel and
// edits it in place as each aspect lands. Best-effort: a failed post or update
// must never interrupt the research pass itself.
async function syncResearchCardNow(
	agent: CompanyBrainAgent,
	companyName: string,
	done: boolean,
): Promise<void> {
	try {
		const home = getHomeChannel(agent)
		if (!home) return
		ensureResearchCardTable(agent)
		const runId = getRunId(agent)
		const stored = agent.sql<{
			message_ts: string
			channel_id: string
			block_id: string
			team_id: string | null
			run_id: number
		}>`SELECT message_ts, channel_id, block_id, team_id, run_id FROM brain_research_card WHERE id = 1`[0]
		// Editing a row from another workspace or run would fail forever.
		const row =
			stored && stored.team_id === home.teamId && stored.run_id === runId
				? stored
				: undefined
		const blockId = row?.block_id ?? `research_${agent.name}_${runId}`
		const channelId = row?.channel_id ?? home.channelId
		const { upsertResearchCard } = await import("../slack/research-card")
		const ts = await upsertResearchCard(brainAgent(agent).env, {
			teamId: home.teamId,
			channelId,
			companyName,
			events: getResearchState(agent).events,
			done,
			blockId,
			messageTs: row?.message_ts,
		})
		if (!ts) return
		agent.sql`
			INSERT INTO brain_research_card (id, message_ts, channel_id, block_id, team_id, run_id)
			VALUES (1, ${ts}, ${channelId}, ${blockId}, ${home.teamId}, ${runId})
			ON CONFLICT(id) DO UPDATE SET
				message_ts = excluded.message_ts,
				channel_id = excluded.channel_id,
				block_id = excluded.block_id,
				team_id = excluded.team_id,
				run_id = excluded.run_id
		`
	} catch (err) {
		console.warn("[company-brain] research card sync failed:", err)
	}
}

// Signup research predates the home channel, so install posts the card late.
export async function syncResearchCardIfDone(
	agent: CompanyBrainAgent,
): Promise<void> {
	ensureResearchTables(agent)
	const state = getResearchState(agent)
	if (state.status !== "done" || !state.domain) return
	await syncResearchCard(agent, companyNameFromDomain(state.domain), true)
}

function upsertResearchStep(
	agent: CompanyBrainAgent,
	aspect: string,
	ord: number,
	label: string,
	status: string,
	detail: string | null = null,
	extra: string | null = null,
): void {
	const now = Date.now()
	agent.sql`
		INSERT INTO brain_research_phase (aspect, ord, label, status, detail, extra, created_at)
		VALUES (${aspect}, ${ord}, ${label}, ${status}, ${detail}, ${extra}, ${now})
		ON CONFLICT(aspect) DO UPDATE SET
			label = ${label},
			status = ${status},
			detail = ${detail},
			extra = ${extra},
			created_at = ${now}
	`
}

export function getResearchState(agent: CompanyBrainAgent): ResearchState {
	ensureResearchTables(agent)
	const meta = agent.sql<{
		status: string
		domain: string | null
		findings: number
	}>`
		SELECT status, domain, findings FROM brain_research WHERE id = 1
	`[0]
	const events = agent.sql<{
		aspect: string
		label: string
		status: string
		detail: string | null
		extra: string | null
		created_at: number
	}>`
		SELECT aspect, label, status, detail, extra, created_at
		FROM brain_research_phase ORDER BY ord ASC LIMIT 50
	`
	return {
		status: meta?.status ?? null,
		domain: meta?.domain ?? null,
		findings: meta?.findings ?? 0,
		events: events.map((e) => {
			const parsed = parseExtra(e.extra)
			return {
				aspect: e.aspect,
				label: e.label,
				status: e.status,
				detail: e.detail ?? null,
				stats: parsed.stats,
				highlights: parsed.highlights,
				sources: parsed.sources,
				createdAt: e.created_at,
			}
		}),
	}
}

function parseExtra(raw: string | null): {
	stats: ResearchStat[]
	highlights: string[]
	sources: string[]
} {
	if (!raw) return { stats: [], highlights: [], sources: [] }
	try {
		const v = JSON.parse(raw) as {
			stats?: ResearchStat[]
			highlights?: string[]
			sources?: string[]
		}
		return {
			stats: Array.isArray(v.stats) ? v.stats : [],
			highlights: Array.isArray(v.highlights) ? v.highlights : [],
			sources: Array.isArray(v.sources) ? v.sources : [],
		}
	} catch {
		return { stats: [], highlights: [], sources: [] }
	}
}

export async function loadOrg(
	agent: CompanyBrainAgent,
): Promise<SlackOrg | null> {
	const [{ db, eq }, { organization }] = await Promise.all([
		import("@repo/db"),
		import("@repo/db/schema/auth"),
	])
	const [row] = await db(brainAgent(agent).env)
		.select({
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
			metadata: organization.metadata,
		})
		.from(organization)
		.where(eq(organization.id, agent.name))
		.limit(1)
	if (!row) return null
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		metadata: row.metadata as Record<string, unknown> | null,
	}
}

// Fast, non-blocking: schedule the research to run in the DO's own lifecycle so the
// org-create request returns immediately instead of awaiting minutes of web research.
export async function researchCompanyOnSignup(
	agent: CompanyBrainAgent,
	input: ResearchOnSignupInput,
): Promise<void> {
	ensureResearchTables(agent)
	const status = researchStatus(agent)
	console.log(
		`[company-brain] researchCompanyOnSignup org=${agent.name} domain=${input.domain} existingStatus=${status} force=${input.force ?? false}`,
	)
	// Treat queued like running — a scheduled task is already in flight; restarting
	// would bump run_id and strand the active task after the fast setup steps.
	if (
		!input.force &&
		(status === "queued" || status === "running" || status === "done")
	)
		return
	// New generation cancels any in-flight run; clear old phases so the UI resets.
	const runId = bumpRunId(agent)
	agent.sql`DELETE FROM brain_research_phase`
	ensureResearchCardTable(agent)
	agent.sql`DELETE FROM brain_research_card`
	const { clearResearchAnnounced } = await import("./research-announce")
	clearResearchAnnounced(agent)
	setResearchStatus(agent, "queued", { domain: input.domain })
	try {
		await agent.schedule(0, "runResearchTask", {
			...input,
			runId,
			resetEpoch: getBrainMemoryResetEpoch(agent),
		})
	} catch (err) {
		// Never leave status stuck at "queued" — a future start would refuse to run.
		setResearchStatus(agent, "error", { domain: input.domain })
		throw err
	}
	console.log(
		`[company-brain] research scheduled for org=${agent.name} runId=${runId}`,
	)
}

export async function runResearchTask(
	agent: CompanyBrainAgent,
	payload: ResearchOnSignupInput,
): Promise<void> {
	console.log(
		`[company-brain] runResearchTask START org=${agent.name} domain=${payload?.domain}`,
	)
	ensureResearchTables(agent)
	const { domain, ownerId, runId } = payload
	const resetEpoch = payload.resetEpoch ?? 0
	let findings = 0
	// A newer run supersedes this one; bail so their writes don't interleave.
	const isCurrent = () =>
		(runId == null || getRunId(agent) === runId) &&
		isBrainMemoryResetEpochCurrent(agent, resetEpoch)
	// A newer run bumps run_id and owns the status; a reset only advances the epoch
	// (run_id unchanged) and schedules nothing, so leave a terminal status here.
	const bailIfSuperseded = (): boolean => {
		if (isCurrent()) return false
		if (runId == null || getRunId(agent) === runId) {
			setResearchStatus(agent, "cancelled", { domain, findings })
		}
		return true
	}
	if (bailIfSuperseded()) {
		console.log(`[company-brain] runResearchTask superseded org=${agent.name}`)
		return
	}
	const org = await loadOrg(agent)
	if (!org) {
		console.error(
			`[company-brain] research: no org found for id "${agent.name}"`,
		)
		// No org row to research against — leave a terminal status, not "queued".
		if (isCurrent()) setResearchStatus(agent, "error", { domain, findings })
		return
	}
	const orgName = companyNameFromDomain(domain)
	// Must read before setResearchStatus overwrites it.
	const previousDomain = researchDomain(agent)
	const supersedesDomain = !!previousDomain && previousDomain !== domain
	setResearchStatus(agent, "running", { domain })

	const env = brainAgent(agent).env
	const { writeMemory } = await import("../memory")
	const { deleteBrainDocumentByCustomId } = await import("../memory/cleanup")
	const costLedger = new BrainCostLedger()

	try {
		// Fast setup beats to ramp the flow up before the slower research.
		for (let s = 0; s < SETUP_STEPS.length; s++) {
			const step = SETUP_STEPS[s]
			if (!step) continue
			upsertResearchStep(agent, step.key, s, step.title, "in_progress")
			await delay(step.delayMs)
			upsertResearchStep(agent, step.key, s, step.title, "complete")
		}

		const homepage = await researchHomepage(env, domain, costLedger)
		if (bailIfSuperseded()) return

		const base = SETUP_STEPS.length
		for (let i = 0; i < RESEARCH_ASPECTS.length; i++) {
			const aspect = RESEARCH_ASPECTS[i]
			if (!aspect) continue
			if (bailIfSuperseded()) return
			const ord = base + i
			const aspectDocId = researchAspectCustomId(org.id, aspect.key, resetEpoch)
			const retireStaleAspect = async () => {
				if (!supersedesDomain) return
				await deleteBrainDocumentByCustomId({
					env,
					orgId: org.id,
					customId: aspectDocId,
				})
			}
			upsertResearchStep(agent, aspect.key, ord, aspect.title, "in_progress")
			// Without this the card is absent for the whole first aspect.
			await syncResearchCard(agent, orgName, false)
			try {
				const res = await brainWebSearch(
					env,
					{
						query: aspect.query(domain, orgName),
						instruction: aspect.instruction(domain, orgName),
						freshness: aspect.freshness,
						page: homepage,
					},
					costLedger,
				)
				if (bailIfSuperseded()) return
				let written = false
				let extra: string | null = null
				if (res?.summary) {
					const hl = await extractHighlights(res.summary, costLedger)
					if (bailIfSuperseded()) return
					extra = JSON.stringify({
						stats: hl.stats,
						highlights: hl.highlights,
						sources: res.sources,
					})
					written = (
						await writeMemory(
							env,
							undefined,
							org,
							ownerId,
							{
								title: `${orgName}: ${aspect.title}`,
								content: res.summary,
								sources: res.sources,
								internalCustomIdOverride: aspectDocId,
								// Agent-backed writes reject empty tags; give each aspect a
								// stable topic-tree path so findings actually persist.
								tags: [
									{
										key: `company/${aspect.key}`,
										label: aspect.title,
										kind: "topic",
									},
								],
							},
							undefined,
							agent,
							{ expectedResetEpoch: resetEpoch },
						)
					).written
					if (written) findings += 1
				}
				if (!written) await retireStaleAspect()
				upsertResearchStep(
					agent,
					aspect.key,
					ord,
					aspect.title,
					"complete",
					res?.summary ??
						`No public info found on ${aspect.title.toLowerCase()}.`,
					extra,
				)
				await syncResearchCard(agent, orgName, false)
			} catch (err) {
				console.error(
					`[company-brain] research aspect "${aspect.key}" failed:`,
					err,
				)
				if (bailIfSuperseded()) return
				await retireStaleAspect()
				upsertResearchStep(
					agent,
					aspect.key,
					ord,
					aspect.title,
					"error",
					`Could not research ${aspect.title.toLowerCase()}.`,
				)
				await syncResearchCard(agent, orgName, false)
			}
		}
		if (isCurrent()) {
			setResearchStatus(agent, "done", { domain, findings })
			await syncResearchCard(agent, orgName, true)
			const { announceResearchDone } = await import("./research-announce")
			await announceResearchDone(agent)
		}
	} catch (err) {
		// Any failure outside the per-aspect catch must leave a terminal state, else
		// status stays "running" and /start refuses to retry (alreadyRunning) forever.
		console.error(
			`[company-brain] research task failed org=${agent.name}:`,
			err,
		)
		if (isCurrent()) setResearchStatus(agent, "error", { domain, findings })
	} finally {
		agent.waitUntil(
			scheduleChargeBrainLlmCost({
				orgId: org.id,
				ledger: costLedger,
				source: "research_onboarding",
				env,
			}),
		)
		await flushBrainTelemetry()
	}
}
