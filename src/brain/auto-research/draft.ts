import { generateId } from "@repo/lib/generate-id"
import { toolProducesEvidence } from "../observability"
import type { SlackLookupContext } from "../slack/channel-lookup"
import { normalizeTextPreservingCodeFences } from "../slack/format"
import { getCachedSlackChannelInfo } from "../slack/profile-cache"
import type { SlackOrg } from "../slack/workspace"
import type { CompanyBrainAgent } from "../turn/agent"
import { computeTurn, EMPTY_REPLY } from "../turn/compute"
import type { TurnToolTraceEntry } from "../turn/types"
import type { PlanPerson, PlanTarget } from "./plan"
import type { DraftSources, NewAutoResearchDraft } from "./store"

// One draft = one full agent turn, so a draft can use everything the brain can:
// memory, connected apps, Slack, the web. Nothing is delivered here.

// Reply the model uses when a target turned up nothing worth sending.
const NOTHING = "NOTHING_NEW"
// The prompt asks for under 80 words. Well past that is a report, and the
// reviewer is told so on the card rather than losing the draft.
const WORD_CEILING = 140
// The draft cites itself below this line; we split it off so it can never be sent.
const SOURCES_MARKER = "SOURCES:"

// Shape matters as much as wording: one wall of prose doesn't get read, so the
// note is two beats with a blank line between them.
export const VOICE = `Write what you'd actually type to a colleague you like: why you're reaching out, then the one thing you found.

Length is the hard part and it is not optional. The whole message is UNDER 80 WORDS. One opening sentence, then at most three sentences of substance. Two short beats with a blank line between them. If it runs to a third paragraph, you have written a report and it will not get read, so cut it back before answering.

ONE finding per message. If your investigation turned up two interesting things, send the better one and drop the other completely. Do not append the second as another paragraph, and do not fold it in as an aside.

The link is mandatory and it is not the same thing as an implication. One clause has to say the concrete point of contact: the specific reason this lands for THEM and not for anyone else on the team. Naming their work, then naming the outside thing, and leaving them to guess how the two touch is a failed note even when both halves are true.

What you still don't do is go past that link: no proposal about what we should do, no reasoning through what it would mean if true, no second-order consequences. State their thing, state your finding, state the one place they meet, stop.

Be concrete about their work. "The scheduled-runs durability work" or "the hardening sprint" is an area, not a thing. Name the actual PR, issue, behaviour, bug, or decision, because a vague area is what makes a note feel generic and unrelated to them.

How it should feel: easy on the first pass, not polished prose, not a report, not trying to sound smart. Every sentence earns its place.

Shape:
- Vary the shape. If your note has the same skeleton as another note in this round, the same opening move, the same bridge, the same closing turn, rewrite it. Sameness across notes is what makes them read as machine output.
- Never open with the same construction twice. "Saw you shipping X", "caught your X", "been watching X" are one construction, not three.
- Say what you found and stop. The reader is smart and works here.
- Never close with a rhetorical question, a "the question is whether", or an open musing about what someone should decide. If you have a real point, state it. If you don't, stop at the finding.

Never write these. They are the specific things that make this read as AI:
- "That's basically X", "that's the X version of Y", "the same bet", "the same story", "the same rot", or any sentence whose job is to assert that two things are secretly the same. If the connection is real, it survives being stated plainly.
- The contrastive tail: "..., instead of hoping the chat stream remembers", "..., rather than stacking forever". One clause, then a swipe at the alternative. Cut the swipe.
- "It's not just X, it's Y" and "this isn't about X, it's about Y".
- A metaphor doing the work of an explanation. Say the mechanism.
- Cramming a spec into one breath with nested clauses and parentheses. Break it into two sentences or leave detail out.
- Em dashes and en dashes anywhere. For a pause use a comma or a new sentence, and write ranges with a plain hyphen like 30-48%.
- Asterisks or bold for emphasis on a word or phrase. If a fact matters, put it in the sentence that matters.
- Signposting ("when it comes to", "at its core") and filler ("the signal", "leverage", "delve", "game-changer", "move the needle", "worth keeping an eye on").
- No bullet lists, headers, emoji, sign-off, or summary line.

Plain words a smart teammate who doesn't work on this exact thing would get. Translate jargon into what it actually means. Never manufacture relevance: if you can't name the specific thing that prompted you, you don't have a note, so reply ${NOTHING}.

Last pass before you answer: read it back as if you received it. If a sentence sounds like it was built to sound clever rather than to tell them something, cut it.`

const INVESTIGATE = `Investigate before you write. Use our connected apps (GitHub, Linear, Notion, Sentry, PostHog, Drive, Plain, and whatever else is wired up) AND the web, and cross-reference them, because the notes worth sending connect something outside to what our own systems show we're actually doing. Never answer from memory alone. Be economical rather than exhaustive: pick the two or three sources most likely to pay off and follow one thread properly. Never repeat a call you have already made or re-ask a question you already answered, and if a source comes back empty move on instead of rephrasing it. Stop and write the moment you have one concrete thing worth sending. You have room to investigate properly, so spend it on new ground, never on circling. This is read-only: do not create, modify, comment, post, send, schedule, or connect anything.`

// Operator steering and what we've already sent bound every draft, not just the
// plan: the run picked this target, but the note itself can still drift or repeat.
type FrameContext = {
	focus: string
	steer?: string
	alreadySent: string[]
	alreadyDrafted: string[]
}

function constraints(ctx: FrameContext): string {
	const steer = ctx.steer?.trim()
	return [
		steer
			? `Direction from the person who triggered this run, follow it: ${steer}`
			: null,
		ctx.alreadySent.length
			? `We already sent these, so anything that repeats one, even reworded, is not worth drafting:\n${ctx.alreadySent
					.map((body) => `- ${body.replace(/\s+/g, " ").slice(0, 200)}`)
					.join("\n")}`
			: null,
		ctx.alreadyDrafted.length
			? `These are already drafted and waiting for review. Same rule: covering this ground again, even from another angle, is not worth drafting:\n${ctx.alreadyDrafted
					.map((body) => `- ${body.replace(/\s+/g, " ").slice(0, 200)}`)
					.join("\n")}`
			: null,
		`Your entire reply IS the message, exactly as it would appear in Slack. Do not introduce it, label it, say "here's the draft", or wrap it in dividers or code fences. Start with the first word of the message itself.
${VOICE}

After the message, on its own line, write "${SOURCES_MARKER}" and then one line per source that actually backs what you wrote, either a URL or "app: what you found there". Only what you genuinely relied on. A reviewer uses this to check you, so a source that doesn't support the claim is worse than none. This section is stripped before anyone reads the message.

If nothing genuinely new and relevant turned up, reply with exactly ${NOTHING} and nothing else.`,
	]
		.filter(Boolean)
		.join("\n\n")
}

function channelFrame(target: PlanTarget, ctx: FrameContext): string {
	return `Draft a short note for our team channel about ONE outside thing that's relevant to what we're building. A human reviews it before anyone sees it, so investigate properly, then write it.

What to look into: ${target.label}
The angle: ${target.angle}
What we're focused on right now: ${ctx.focus}

${INVESTIGATE} Ignore our own company and product news, this is about the outside world.

This goes to a shared channel, so write to the room rather than to one person, and don't build the note around what a single teammate shipped. If the only thing making this interesting is one person's current work, it belongs in their DM and not here, so reply ${NOTHING} instead. Style, including how you open, is the operator's call if they asked for something specific.

If there is a real connection to something we're doing, open with it. If there isn't, open with the outside thing plainly. Never invent the link: tying this to a PR, issue, or thread that isn't actually about it is worse than sending nothing, and a note that only sounds connected is exactly what makes these unreadable.

${constraints(ctx)}`
}

function personFrame(person: PlanPerson, ctx: FrameContext): string {
	return `Draft a short note addressed to ${person.recipient.name} alone, a direct message from you to them rather than something for the whole team. A human reviews it before it's sent, so investigate properly, then write it.

Why them, and the angle: ${person.angle}
What the company is focused on right now: ${ctx.focus}

${INVESTIGATE} This run has ${person.recipient.name}'s own connected apps and private context available, so an idea that only makes sense for them is exactly right. You are still you writing to them, so address them directly ("you"), never speak as them, and never mention that this was reviewed or drafted for approval.

First find what ${person.recipient.name} is actually in the middle of right now, meaning their recent issues, PRs, docs and messages, because a note to one person that doesn't name what THEY specifically are working on is just a channel post sent to a DM. If you can't find that, reply ${NOTHING}. Name their work early so they know why this reached them, but find your own way in rather than reusing a set phrase.

${constraints(ctx)}`
}

// Social/video/aggregator hosts that never belong in a source list.
const JUNK_SOURCE_HOSTS = [
	"instagram.com",
	"tiktok.com",
	"youtube.com",
	"youtu.be",
	"facebook.com",
	"pinterest.com",
]

function isReputableSource(url: string): boolean {
	try {
		const u = new URL(url)
		const host = u.hostname.replace(/^www\./, "").toLowerCase()
		if (JUNK_SOURCE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)))
			return false
		// Spam injection lives in the query string; allow non-ASCII in paths (intl).
		const query = decodeURIComponent(u.search)
		for (let i = 0; i < query.length; i++)
			if (query.charCodeAt(i) > 127) return false
		if (/t\.me\/|@[A-Za-z0-9_]{4,}/.test(url)) return false
		return true
	} catch {
		return false
	}
}

function extractUrls(text: string): string[] {
	return (text.match(/https?:\/\/[^\s)\]}"'<>]+/g) ?? []).map((u) =>
		u.replace(/[.,;]+$/, ""),
	)
}

// What we asked a tool, never what it returned — safe to show a reviewer even
// when the turn ran with someone's personal access.
function inputLabel(input: unknown): string {
	if (typeof input === "string") return input.slice(0, 120)
	if (!input || typeof input !== "object") return ""
	const parts: string[] = []
	for (const value of Object.values(input as Record<string, unknown>)) {
		if (typeof value === "string" && value.trim()) parts.push(value.trim())
		else if (typeof value === "number") parts.push(String(value))
		else if (value && typeof value === "object") {
			const nested = inputLabel(value)
			if (nested) parts.push(nested)
		}
		if (parts.join(" · ").length > 120) break
	}
	return parts.join(" · ").slice(0, 120)
}

// The model hands the draft over fenced and labelled; none of that is the message.
const PREAMBLE_RE =
	/^\s*(?:(?:here'?s|this is|below is)\s+)?(?:my\s+|the\s+)?(?:draft|note|message|dm)\s*(?:for\s+\w+\s*)?:\s*$/i
const DIVIDER_RE = /^\s*(?:-{3,}|\*{3,}|_{3,}|`{3,}\w*)\s*$/
// A note is one message, so a leading "1)" is the model numbering its own output.
const ENUMERATOR_RE = /^\s*(?:\(?\d{1,2}[).:]|draft\s+\d+\s*[:.)])\s+/i

export function stripScaffolding(text: string): string {
	const lines = text.split("\n").filter((line) => !DIVIDER_RE.test(line))
	while (
		lines.length &&
		(!lines[0]?.trim() || PREAMBLE_RE.test(lines[0] ?? ""))
	)
		lines.shift()
	return lines.join("\n").trim().replace(ENUMERATOR_RE, "")
}

// The prompt bans em dashes and the model still reaches for them. Reuses Slack's
// normaliser with a comma, since prose wants a comma where Slack wants a hyphen.
export function houseStyle(text: string): string {
	return normalizeTextPreservingCodeFences(text, ", ")
		.replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
		.replace(/,\s*,/g, ",")
		.replace(/\s+([,.])/g, "$1")
		.replace(/,\s*$/gm, "")
		.trim()
}

// The draft's own citations, split off the end of the reply so they can't be sent.
function splitCitedSources(reply: string): { body: string; cited: string[] } {
	const at = reply.search(new RegExp(`^\\s*\\**${SOURCES_MARKER}`, "im"))
	if (at < 0) return { body: reply.trim(), cited: [] }
	const cited = reply
		.slice(at)
		.replace(new RegExp(`^\\s*\\**${SOURCES_MARKER}\\**`, "i"), "")
		.split("\n")
		.map((line) => line.replace(/^[-•*\d.\s]+/, "").trim())
		.filter(Boolean)
		.slice(0, 8)
	return { body: reply.slice(0, at).trim(), cited }
}

// Review trail. Web results are public and shown in full; internal tool calls are
// named with what we looked up, and carry an excerpt only for org-shared reads.
function collectSources(
	trace: TurnToolTraceEntry[],
	opts: { includeExcerpts: boolean; cited: string[] },
): DraftSources {
	const web = new Set<string>()
	const internal: DraftSources["internal"] = []
	const seen = new Set<string>()
	for (const entry of trace) {
		if (entry.tool === "search_web") {
			for (const url of extractUrls(entry.output ?? ""))
				if (isReputableSource(url)) web.add(url)
			continue
		}
		const label = inputLabel(entry.input)
		const key = `${entry.tool}:${label}`
		if (seen.has(key)) continue
		seen.add(key)
		internal.push({
			tool: entry.tool,
			label,
			...(opts.includeExcerpts && entry.output
				? { excerpt: entry.output.replace(/\s+/g, " ").slice(0, 240) }
				: {}),
		})
	}
	return {
		cited: opts.cited,
		web: [...web].slice(0, 8),
		internal: internal.slice(0, 12),
	}
}

// A reviewer has to know where a draft lands before approving it, so resolve the
// channel's real name rather than showing a raw id.
async function channelDestination(
	agent: CompanyBrainAgent,
	slack: { botToken: string; teamId: string; channelId: string } | null,
): Promise<string | undefined> {
	if (!slack?.channelId) return "no home channel set"
	const info = await getCachedSlackChannelInfo(agent, {
		teamId: slack.teamId,
		botToken: slack.botToken,
		channelId: slack.channelId,
	}).catch(() => undefined)
	return info?.name ? `#${info.name}` : slack.channelId
}

export type DraftJob =
	| { kind: "channel"; target: PlanTarget }
	| { kind: "dm"; person: PlanPerson; dmChannelId: string }

export type RunDraftArgs = {
	agent: CompanyBrainAgent
	org: SlackOrg
	focus: string
	steer?: string
	alreadySent: string[]
	alreadyDrafted: string[]
	job: DraftJob
	/** Home channel + bot token, when the org has Slack installed. */
	slack: { botToken: string; teamId: string; channelId: string } | null
	fallbackUserId: string
	env: Env
}

// The console has to explain a round that kept nothing, so a skipped draft
// reports its reason instead of vanishing into a null.
export type DraftResult =
	| { draft: NewAutoResearchDraft }
	| { draft: null; reason: string }

export async function runDraft(args: RunDraftArgs): Promise<DraftResult> {
	const { agent, org, job, slack } = args
	const traceId = generateId()
	const dm = job.kind === "dm"
	const ctx = {
		focus: args.focus,
		steer: args.steer,
		alreadySent: args.alreadySent,
		alreadyDrafted: args.alreadyDrafted,
	}

	// A person-scoped draft runs as that person: their personal connections, their
	// memory scope. Channel drafts see only org-shared connections. Both read-only.
	const actor = dm
		? {
				orgId: org.id,
				userId: job.person.recipient.userId,
				personalConnectionsOnly: true,
				readOnly: true,
				memberLookup: "found" as const,
			}
		: {
				orgId: org.id,
				orgSharedOnly: true,
				readOnly: true,
				memberLookup: "found" as const,
			}

	const slackLookup: SlackLookupContext | undefined = slack
		? dm
			? {
					botToken: slack.botToken,
					channel: job.dmChannelId,
					teamId: slack.teamId,
					memoryScope: {
						kind: "dm",
						channelId: job.dmChannelId,
						userId: job.person.recipient.userId,
						slackUserId: job.person.recipient.slackUserId,
					},
				}
			: {
					botToken: slack.botToken,
					channel: slack.channelId,
					teamId: slack.teamId,
					memoryScope: { kind: "shared", channelId: slack.channelId },
				}
		: undefined

	const startedAt = Date.now()
	const out = await computeTurn({
		agent,
		org,
		userId: dm ? job.person.recipient.userId : args.fallbackUserId,
		actor,
		question: dm ? personFrame(job.person, ctx) : channelFrame(job.target, ctx),
		threadText: "",
		slackLookup,
		asker: dm ? { slackUserId: job.person.recipient.slackUserId } : undefined,
		// Same posture as a scheduled automation: no writes, no scheduling, no leases.
		scheduledRun: true,
		skipBilling: true,
		// Nobody is waiting in a thread on these, but a round of them is serial-ish,
		// so drop a notch of reasoning effort rather than sit at main-turn latency.
		effortOverride: "medium",
		// Borrowed context: leave nothing behind in the workspace's own threads.
		ephemeral: true,
		obs: { traceId, source: "auto_research", runTrigger: "run_now" },
		env: args.env,
	})
	const elapsedMs = Date.now() - startedAt
	// Where a round's wall time actually goes, per draft.
	console.log(
		`[company-brain] auto-research turn org=${org.id} kind=${job.kind} status=${out.status} ms=${elapsedMs}`,
	)
	// Silent drops made an empty round indistinguishable from a slow one.
	const drop = (reason: string): DraftResult => {
		console.log(
			`[company-brain] auto-research draft dropped org=${org.id} kind=${job.kind} reason=${reason}`,
		)
		return { draft: null, reason }
	}
	if (out.status !== "completed") return drop(`turn_${out.status}`)
	if (out.reply.toUpperCase().includes(NOTHING)) return drop("nothing_to_say")
	const { body: rawBody, cited } = splitCitedSources(out.reply)
	const body = houseStyle(stripScaffolding(rawBody))
	if (!body || rawBody === EMPTY_REPLY) return drop("empty_body")
	const words = body.split(/\s+/).filter(Boolean).length
	const flags: string[] = []
	// Over budget and unevidenced are quality problems, not reasons to bin a real
	// draft: the reviewer can read it and decide. Only an empty or absent note goes.
	if (words > WORD_CEILING)
		flags.push(`${words} words, well over the 80-word target`)
	const trace = out.toolTrace ?? []
	// Discovery and directory calls are not evidence: a draft written off only
	// those is the model riffing from memory rather than investigating.
	if (!trace.some((entry) => toolProducesEvidence(entry.tool)))
		flags.push("no tool evidence behind this, it may be riffing from memory")

	console.log(
		`[company-brain] auto-research draft ready org=${org.id} kind=${job.kind} words=${words} tools=${trace.length} flags=${flags.length} ms=${elapsedMs}`,
	)
	const sources = collectSources(trace, { includeExcerpts: !dm, cited })
	const draft: NewAutoResearchDraft = dm
		? {
				kind: "dm",
				recipientUserId: job.person.recipient.userId,
				recipientSlackUserId: job.person.recipient.slackUserId,
				recipientLabel: job.person.recipient.name,
				channelId: job.dmChannelId,
				teamId: slack?.teamId,
				destination: `DM to ${job.person.recipient.name}`,
				body,
				sources,
				traceId,
				flags,
			}
		: {
				kind: "channel",
				targetKind: job.target.kind,
				targetLabel: job.target.label,
				channelId: slack?.channelId,
				teamId: slack?.teamId,
				destination: await channelDestination(agent, slack),
				body,
				sources,
				traceId,
				flags,
			}
	return { draft }
}
