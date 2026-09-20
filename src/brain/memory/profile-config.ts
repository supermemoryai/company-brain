import type { ProfileBucketDef } from "@repo/db/schema/common"

// Company Brain memory-model config: the memory buckets offered to ingestion
// plus the per-scope entity context that steers tagged Slack memory ingestion.

// Capture policy woven into every tag's entity context: infer from behaviour,
// decay-unless-reinforced, durable-vs-transient. Lives here, not org filterPrompt.
export const BRAIN_CAPTURE_POLICY = [
	"Capture durable, future-useful knowledge — decisions and the reasoning behind them, ownership and who is responsible for what, commitments and their status/blockers, status changes, resolved canonical answers to recurring questions, and constraints. Keep these permanent (no forget horizon).",
	"Infer freely from behavior and repeated patterns — you do NOT need someone to state something explicitly. An observed pattern is a valid memory.",
	"Because memory decays, give transient or low-confidence facts a forget horizon so they fade on their own: current status, 'today/this week', live counts, and single-observation inferences that may not recur. When the same thing shows up again, reinforce/update the existing memory instead of adding a duplicate — that renews it and firms it up.",
	"When new information supersedes an old fact (moved from X to Y, no longer, now), update the existing memory rather than creating a parallel one.",
	"Capture temporal context: when a fact is tied to a date, event, deadline, incident, or status change, state the date in the memory as YYYY-MM-DD so it can be ordered and staleness resolved.",
	"Do NOT capture casual chatter and social banter, secrets/credentials, or unverified speculation.",
	"NEVER store anything a connected tool owns as the live source of truth — PR or review status, issue/ticket state, assignees, deploy or build status, current metrics or counts, calendar or roster state, document contents. Fetch these live from the tool every time; storing them only plants data that goes stale fast and then reads as fact when it is wrong. The ONLY exception is a fact whose tool is not connected for this workspace — and even then, prefer getting it connected.",
].join("\n")

export const BRAIN_MEMORY_BUCKETS: ProfileBucketDef[] = [
	{
		key: "preferences",
		description:
			"How someone likes to work and what they prefer — captured whether stated outright OR shown as a clear, repeated pattern in their work (e.g. consistently ships small PRs, wants designs before building, prefers async over meetings, reaches for tool X, likes terse updates). Infer freely from observed work when the pattern recurs — you do not need it stated; note when a preference is inferred rather than stated. Exclude one-off actions and single-instance guesses, momentary reactions, and gossip about other people.",
	},
	{
		key: "patterns",
		description:
			"Recurring ways this team or person operates — how work actually flows here: cadences and rituals, recurring processes, who tends to own or drive what, common workflows and handoffs. Capture a pattern once it shows up across multiple instances, not from a single occurrence. Exclude single-observation guesses (let them recur first) and transient blips.",
	},
	{
		key: "tasks",
		description:
			"Concrete work someone is doing, plans to do, or needs to do — active items, next steps, commitments, and their status or blockers (e.g. 'I'm on X', 'Y is blocked on Z', 'still need to finish W'). Exclude things merely mentioned in passing, long-closed items with no ongoing relevance, and vague aspirations.",
	},
]

export const BRAIN_SELF_BUCKETS: ProfileBucketDef[] = [
	{
		key: "voice",
		description:
			"How the agent should talk here: tone, register, formality, verbosity, warmth. The always-on baseline voice.",
	},
	{
		key: "social",
		description:
			"Humor register and playfulness that lands, and how opinionated to be. Capture the STYLE (e.g. dry deadpan about deploys), never a specific joke to replay.",
	},
	{
		key: "culture",
		description:
			"Team-level references, in-house vocabulary, running themes, and channel/thread etiquette that shape tone. Generalized across the team, never one person's habit.",
	},
	{
		key: "do_not",
		description:
			"Explicit style vetoes the team has stated or clearly signalled (e.g. 'no emoji', 'keep it short', 'stop summarizing my question').",
	},
	{
		key: "self_concept",
		description:
			"How the agent consistently describes itself and its role/boundaries here (e.g. 'the company brain; doesn't invent facts'). Keeps identity stable across turns.",
	},
	{
		key: "operating",
		description:
			"How the agent should OPERATE in this workspace given how the team works — durable workspace-level workflow facts that smooth the agent's trajectory (e.g. 'the team tracks work in Linear — check there for status/tasks', 'design lives in Figma', 'PRs go through GitHub'). Team-level operating context, not one person's habit and not company facts.",
	},
]

export function buildBrainSelfEntityContext(): string {
	return [
		"This tag is the agent's own profile: how the company brain should talk AND operate in THIS workspace. It is about the AGENT, not the company or any person.",
		"Actively capture every durable style or operating fact you observe and classify it into exactly one of these buckets: voice, social, culture, do_not, self_concept, operating. Use ONLY those six — never the preferences bucket or any other; those do not apply to this tag. Do not skip style, instructional, or workflow content — recording how the agent should talk and operate is the entire purpose of this tag.",
		"Keep it a small, bounded profile, not a corpus: when new information refines or contradicts an existing style fact, update the existing memory rather than adding a parallel one.",
		"Only generalize to team-level style. Never store one person's individual preference here, company facts, anyone's personal information, or specific jokes — capture the humor STYLE, not the joke.",
	].join("\n")
}

/** Shared Team Brain (`sm_org_shared`) entity context. */
export function buildBrainSharedEntityContext(params: {
	orgName: string
	domain?: string | null
	about?: string | null
}): string {
	const header = `Organization: ${params.orgName}${params.domain ? ` (${params.domain})` : ""}. This is the shared Company Brain for everyone in this org — the team's collective memory, fed continuously from Slack.`
	const aboutLine = params.about?.trim() ? `About: ${params.about.trim()}` : ""
	return [
		header,
		aboutLine,
		"Scope every memory to this organization — its people, teams, projects, customers, decisions, and product/domain terms.",
		"When a fact is clearly and primarily about one teammate, save it with that teammate's stable person_<slack_user_id> memory tag.",
		"A full profile isn't provided yet: infer the org's products, structure, and vocabulary from ingested content, and treat recurring names (people, repos, products, customers, projects) as this org's entities.",
		"Hold exactly ONE current answer per subject. When a new fact changes who owns or is responsible for something, or updates a subject's status/role/decision already in memory (a new owner, a handoff, 'now', 'no longer', 'moved to'), UPDATE that subject's existing memory (emit an updates relation) instead of storing a parallel fact — the related memories are provided for exactly this.",
		BRAIN_CAPTURE_POLICY,
	]
		.filter(Boolean)
		.join("\n")
}

/** Personal-DM tag (`user_{userId}`) entity context. */
export function buildBrainPersonalEntityContext(params: {
	memberName?: string | null
}): string {
	const who = params.memberName?.trim() || "this teammate"
	return [
		`This is ${who}'s private memory, formed only from their direct messages with Company Brain.`,
		`Capture what helps serve ${who} personally: their preferences and working patterns, their tasks and next steps, and their working context.`,
		"Infer preferences and patterns from their behavior generously — you do not need them stated. Single-observation or low-confidence inferences should carry a short forget horizon so they fade unless they recur; when the same pattern shows up again, reinforce the existing memory. Real patterns survive, one-offs fade.",
		"Do NOT capture company-wide facts (those belong in the shared brain) or other people's private information. This memory is private to this person.",
	].join("\n")
}

/** Private Slack channel tag (`slack_channel_{channelId}`) entity context. */
export function buildBrainPrivateChannelEntityContext(params: {
	channelName?: string | null
	purpose?: string | null
}): string {
	const label = params.channelName?.trim()
		? `the private channel #${params.channelName.trim()}`
		: "this private channel"
	const purposeLine = params.purpose?.trim()
		? `Purpose: ${params.purpose.trim()}`
		: ""
	return [
		`This is ${label}.`,
		purposeLine,
		"Capture company-relevant knowledge scoped to this channel's members and topics. When a fact is clearly about one teammate, save it with that teammate's stable person_<slack_user_id> memory tag.",
		"Do NOT leak this into the shared brain.",
		BRAIN_CAPTURE_POLICY,
	]
		.filter(Boolean)
		.join("\n")
}
