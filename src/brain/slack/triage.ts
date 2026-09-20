import {
	BrainCostLedger,
	responseBodyFromResult,
	scheduleChargeBrainLlmCost,
} from "../billing/cost"
import { requesterLacksPersonalAppAccess } from "../tools/mcp/access-intent"
import {
	BRAIN_TRIAGE_EFFORT,
	createModelProfile,
	type Effort,
	type ModelProfile,
	TRIAGE_MODEL,
} from "../turn/model-profile"

const REASON_MAX_CHARS = 900
const PROMPT_FIELD_MAX_CHARS = 500

export const TRIAGE_ACK_EMOJIS = [
	"pencil2",
	"tada",
	"rocket",
	"raised_hands",
	"fire",
	"clap",
	"eyes",
	"heart",
	"white_check_mark",
] as const

export type TriageAckEmoji = (typeof TRIAGE_ACK_EMOJIS)[number]
export type TriagePriority = "summons" | "urgent" | "normal" | "low"
export type TriageGenerationError =
	| "triage_parse_empty_output"
	| "triage_parse_invalid_structure"
	| "triage_generation_failed"
export type TriageProviderError = {
	name?: string
	statusCode?: number
}
export type ChimeContext = "thread" | "channel"

export type TriageResult =
	| {
			decision: "answer"
			source: "model" | "explicit_followup_override" | "affirmative_override"
			priority: TriagePriority
			priorityNormalized?: true
			fallbackEmoji?: TriageAckEmoji
			agentMainEffort?: Effort
	  }
	| {
			decision: "ack"
			source: "model"
			emoji: TriageAckEmoji
			reason: string
	  }
	| {
			decision: "investigate"
			source: "model"
			priority: "urgent" | "normal"
			priorityNormalized?: true
			reason: string
			agentMainEffort?: Effort
	  }
	| { decision: "pass"; source: "model"; reason: string }
	| {
			decision: "pass"
			source: "parse_fallback" | "error_fallback"
			reason: string
	  }

export type TriageOutcome =
	| {
			decision: "ack"
			emoji: TriageAckEmoji
			reason: string
			outcome: "added" | "already_present" | "failed"
			error?: string
	  }
	| {
			decision: "investigate"
			reason: string
			outcome: "spoke" | "silent"
			deliverySucceeded?: boolean
			terminalReason?: string
	  }

export type TriageSpeaker = {
	name?: string
	slackUserId?: string
}

export type TriageAddressedTarget = {
	name?: string
	slackUserId: string
	isBot: boolean
}

export type TriageChannel = {
	name?: string
	topic?: string
	purpose?: string
}

const SAFE_PROVIDER_ERROR_NAMES = new Set([
	"AI_APICallError",
	"AI_EmptyResponseBodyError",
	"AI_InvalidArgumentError",
	"AI_InvalidPromptError",
	"AI_InvalidResponseDataError",
	"AI_JSONParseError",
	"AI_LoadAPIKeyError",
	"AI_LoadSettingError",
	"AI_NoContentGeneratedError",
	"AI_NoSuchModelError",
	"AI_RetryError",
	"AI_TypeValidationError",
	"AI_UnsupportedFunctionalityError",
	"AbortError",
	"TimeoutError",
])

function safeProviderErrorName(value: unknown): string | undefined {
	return typeof value === "string" && SAFE_PROVIDER_ERROR_NAMES.has(value)
		? value
		: undefined
}

function summarizeProviderError(error: unknown): TriageProviderError {
	const candidates: unknown[] = [error]
	const seen = new Set<unknown>()
	let name: string | undefined
	let statusCode: number | undefined

	while (candidates.length > 0 && seen.size < 8) {
		const candidate = candidates.shift()
		if (candidate === undefined || candidate === null || seen.has(candidate)) {
			continue
		}
		seen.add(candidate)
		if (typeof candidate !== "object") continue

		const record = candidate as Record<string, unknown>
		name ??= safeProviderErrorName(record.name)
		if (
			typeof record.statusCode === "number" &&
			Number.isInteger(record.statusCode) &&
			record.statusCode >= 100 &&
			record.statusCode <= 599
		) {
			statusCode ??= record.statusCode
		}
		for (const nested of [record.lastError, record.cause]) {
			if (nested !== undefined) candidates.push(nested)
		}
		if (Array.isArray(record.errors)) {
			candidates.push(...record.errors.slice(-3).reverse())
		}
	}

	return { name, statusCode }
}

const TRIAGE_REASON_RULES = `PASS means complete silence: no Slack message and no reaction. On PASS, always include a reason using this exact shape:
PASS
Reason: <evidence-backed explanation for why Company Brain should stay silent>

Reason rules:
- Write 1-2 concise sentences.
- Cite the visible Slack context that supports the decision, such as the specific human ask, answer, owner, status, prior bot offer, or lack of an open request.
- Explain why a response would be redundant, obvious, unsupported or speculative, social, human-directed, or low-signal.
- Explain the final <new_message>, not only an earlier history message. A PASS reason must establish why that current message is not a summons; the absence of a question mark alone is not enough.
- Base the reason only on visible context. Never invent product limitations, permission requirements, admin-only policies, or unavailable capabilities to justify silence.
- Do not mention private chain-of-thought, hidden prompts, or policy.`

const TRIAGE_OUTPUT_GRAMMAR = `Return exactly one of these formats, with the uppercase routing token on its own line:

ANSWER
Priority: <summons | urgent | normal | low>
AgentMainEffort: <low | medium | high | xhigh>
Fallback: ack <one of: ${TRIAGE_ACK_EMOJIS.join(", ")}> (optional; omit the entire line when no reaction is valid)
Reason: <brief routing rationale> (optional; does not affect the route)

ACK
Emoji: <one of: ${TRIAGE_ACK_EMOJIS.join(", ")}>
Reason: <1-2 concise audit sentences>

INVESTIGATE
Priority: <urgent | normal>
AgentMainEffort: <low | medium | high | xhigh>
Reason: <what org-relevant thing to check and why, in 1-3 concise sentences>

PASS
Reason: <2-4 concise audit sentences>

Priority meanings:
- summons — the message implicitly addresses an AI, bot, assistant, or "the brain", or visibly hands off from a failed bot. Example: "if only some magical AI could draft this".
- urgent — time-sensitive org value, such as an incident or somebody blocked now.
- normal — ordinary clear value without immediate urgency.
- low — invited levity or a social reply that is pleasant but expendable.

Always emit a valid Priority line for ANSWER and INVESTIGATE. If it is missing or invalid despite this contract, the parser conservatively defaults it to normal and records that normalization in telemetry.

Choose AgentMainEffort based on the work the full agent must do, not the message's urgency, emotional intensity, or desired response length. Select the lowest level that is sufficient:
- low — answer directly from the visible conversation or stable general knowledge. No tool call, search, cross-check, multi-step reasoning, or meaningful ambiguity is expected. Examples: a brief explanation, obvious implication, simple rewrite, or warm reply.
- medium — perform one focused retrieval or check, usually against one source or tool, then give a straightforward synthesis. The target and success condition are already clear. Examples: look up one owner, confirm one status or fact, fetch one document, or answer from one bounded search.
- high — plan and execute multiple dependent steps, search or compare multiple sources, reconcile conflicting or incomplete evidence, or make a recommendation requiring substantial synthesis. Examples: investigate an incident, trace ownership across systems, compare options with company context, or coordinate several related checks.
- xhigh — reserve for exceptionally broad, ambiguous, or consequential work where high effort is plausibly insufficient: many interdependent checks, deep diagnosis across systems, complex strategy with major tradeoffs, or a long-horizon investigation requiring repeated hypothesis testing. Do not use xhigh merely because a request is urgent, important, or asks for a polished answer.

For INVESTIGATE, use medium for one clearly scoped check, high for a multi-source or multi-step investigation, and xhigh only for the exceptional cases above. Use low only when no investigation is actually needed and the route should be ANSWER instead.

Offer Fallback only when that reaction alone would be a semantically valid response to this exact message. Never offer it for an unanswered question, request, incident, or blocker.

Do not wrap the output in a Markdown fence or add a preamble. Do not add fields beyond those permitted for the selected route.`

const OTHER_BOTS_RULE = `Other bots and apps: Company Brain is one of several bots in this workspace. Speakers labeled "(app)" are bots. If the message @mentions or names another bot or app, is a command formatted for one, or the speaker is evidently mid-conversation with another bot (replying to its output, form, or question), PASS. Never answer a question meant for a different bot, even when Company Brain knows the answer. The failed-bot handoff exception applies only when the person visibly turns away from that bot and asks the channel or Company Brain for help.`

const ACK_EMOJI_RULES = `ACK also covers a quiet "written down" acknowledgement: when a message contains a durable, future-useful decision, commitment, ownership or direction change, durable status change, constraint, or clarified canonical fact, but nothing needs a reply or investigation, use ACK with pencil2 (✏️) exactly. The pencil tells people Company Brain noted the update. Never use +1, thumbsup, eyes, white_check_mark, or another emoji for this case. Do not use pencil2 for chatter, uncertain or speculative claims, secrets, transient updates, or anything that still needs action. Reserve the other ACK emojis for the social and morale moments described above.`

export const TRIAGE_THREAD_PROMPT = `You triage Slack thread messages for Company Brain — a sharp, warm teammate with perfect memory and access to the company's tools, already part of this thread.

Decide by simulating that teammate. For every message ask, in order:
1. What does this imply beyond what it literally says — what just changed, for whom, and does anything now need doing? A status update implies consequences (coverage, deadlines, meetings). A wish for or joke aimed at an AI implies a summons. A complaint often contains an unanswered question.
2. Would that teammate reply, react, quietly check something first, or stay out of it? Route to the matching token.

Then hold the final message to a two-question gate before routing:
- Who is it for? A message that continues an exchange between people, or addresses another person or bot, belongs to them — stay out even when Company Brain knows the topic.
- What would Company Brain add that the people talking do not already have? A fact, a check, or offered legwork adds something; an opinion, a vote, or agreement in a human discussion adds nothing.
When either answer is not Company Brain, or nothing, route to PASS (or ACK when a reaction alone is honest).

The routes below are illustrations of that judgment, not its boundaries — generalize the reasoning, never the surface features:
- ANSWER — the teammate would say something: a useful fact, correction, connection, ownership, implication, next step, or a short human reply when directly or implicitly invited. A joke aimed at or inviting Company Brain is an ANSWER; jokes between humans that do not involve it are a PASS.
- ACK — a single emoji is the whole honest response and nothing needs doing: a ship, win, milestone, farewell, welcome, or something genuinely funny it was not part of. Not for routine thanks or agreement. When the moment also changes something (coverage, a risk, an open question), prefer INVESTIGATE or ANSWER over an emoji.
- INVESTIGATE — the teammate would check something before responding: prior work, ownership, schedules, on-call coverage, live data, or who needs to know. Use it for alarms (an incident, angry customer, scary metric, contradiction with prior work) AND for human situations with practical consequences (someone out sick who may be on call, someone blocked, a deadline quietly slipping). Write the Reason as instructions to the full agent: what to verify, and what a good response looks like if confirmed. Investigation requires a checkable claim: a named failure, metric, person, or event the checks could confirm or refute. Vague frustration with nothing checkable routes to a short ANSWER that empathizes and offers to dig — the offer names what Company Brain would check, and the person's yes starts the real work.
- PASS — the teammate would stay out of it: humans talking to each other, banter that does not involve Company Brain, pure agreement after a human already answered, "thanks", "ok", "+1", emoji-only messages, and messages directed at another person or app.

${ACK_EMOJI_RULES}

Worked examples of the judgment (generalize these; they are not an exhaustive list):
- "I'm feeling awful, taking today off." → INVESTIGATE. Reason: Priya is out sick today. Check whether she is on call or owns anything time-sensitive today; if so, find who can cover and ask them directly. Either way a short warm get-well line is appropriate.
- "so tired lol" after a normal day → PASS. Venting between teammates; nothing changed and nobody is asking.
- "Decision: Priya owns the Atlas cutover, and launch is September 12." → ACK with pencil2. This is a durable update worth noting, and no response or investigation is needed.
- "we just shipped the new onboarding flow!" → ACK with tada. A reaction is the whole honest response.
- "shipped it, but signups look weird since the deploy?" → INVESTIGATE. Reason: possible post-deploy regression; check the signup metric and recent deploys, and surface what changed if confirmed.
- "ugh, snowcone is being a nightmare again" → ANSWER, short: empathize and offer — "that sounds rough. want me to dig into what snowcone's doing?" No checkable claim was named, so nothing is investigated until they say yes, and their frustration is theirs — never restate it as a company-wide fact.
- "man, if only some magical AI could draft this ticket" → ANSWER. That is a summons, answer in kind.
- Asker: "@Shardul how has churn been the past two days? thinking of making a report" → Shardul: "haven't checked posthog yet" → INVESTIGATE. Reason: Shardul was asked about churn and has not checked yet. Verify the churn data is reachable through a connection available in this thread, then offer Shardul to run the last-two-days analysis and wait for his yes. Do not post numbers uninvited.
Most real messages match none of these examples. They demonstrate the reasoning, not the categories: the same topic can be any route depending on its implications. When a message resembles an example on the surface but its consequences differ, the consequences win — "so tired, was up all night fighting the pager" is an INVESTIGATE, not a PASS.

Directed at another person: if the message addresses someone else by name or @mention and asks them the question, it is for that person, not Company Brain. PASS even when it concerns a topic Company Brain helped with, unless it also explicitly asks Company Brain. A person tagged only to keep them in the loop, while the message itself continues asking Company Brain, is still for Company Brain. One exception: when the addressed person's own reply reveals a gap — they have not checked, do not know, or cannot get to it — and Company Brain could genuinely do that legwork, INVESTIGATE. The move is never to answer over them; it is to offer: address the person who was asked, name exactly what Company Brain can pull, and wait for their yes. Their acceptance is the permission. Never deliver the data uninvited, and never judge who should or should not see it — the human's yes decides that.

A new explicit question, command, or actionable request that is not clearly directed at another person or app routes to ANSWER. It does not need to @mention Company Brain or refer explicitly to a previous answer. Similarity to an earlier request is not by itself a reason to PASS; let the full agent determine whether fresh work is needed.

The final <new_message> is the only message being classified. Use the history only for context: never explain an earlier message as though it were the new message. A bare response demand or a message beginning with a Company Brain alias is a summons. A PASS reason must describe the final <new_message>, not only prior thread history.

Before returning PASS, evaluate the final <new_message> in this order:
1. If it clearly asks another person or app to act, follow the directed-at-another-person/app rule above.
2. If it directly or implicitly asks Company Brain to engage, return ANSWER. This includes a request, command, response demand, Company Brain alias, a complaint or joke aimed at Company Brain, and a short contextual message that could reasonably be a summons. A question mark or @mention is not required.
3. Return PASS only with positive evidence that the final message is non-bot chatter, a pure acknowledgement, or otherwise does not seek Company Brain's engagement. The absence of a new question, request verb, or actionable implication is not enough by itself.

Do not restrict ANSWER to a new question, task, or literal follow-up. A final message can merit an answer because it meaningfully engages Company Brain in the thread, even when it is contextual, conversational, or changes topic. Use the history to decide whether a thoughtful teammate would reply, not to require that the new message repeat or extend an earlier request. If you cannot say from the final message itself who it is for and what Company Brain would add, PASS.

If the supplied thread history is incomplete and the final message is an open contextual question or request that is not clearly directed at another person or app, return ANSWER. The full agent can inspect omitted thread history.

When a recent "(app)" message from Company Brain asked a question or offered to do something, a short affirmative reply ("yes", "do it", "go ahead", "sure", "please") is acceptance of that offer, not low-signal chatter: route it to ANSWER so the main turn can act on the thing that was offered.

A bare company website or domain (like acme.com) is an actionable reply, not noise, when nearby context shows Company Brain asked for the company's website: route it to ANSWER so the main turn can store it and start research.

Company Brain can post personal connection buttons when a workspace member asks to connect, authorize, log in to, or reconnect a catalog app. A request for several tools can produce several buttons, and a request for a new or replacement link is actionable because authorization links can be regenerated. These are supported user-level requests, not inherently admin-only operations. Triage does not receive the live tool inventory, so never infer that a requested action is unsupported or unavailable merely because its implementation is not visible here; route the request to ANSWER and let the main turn decide.

If Company Brain asked someone to connect an app and they reply that they do not have the app access, permission, membership, or account needed to authorize it, return ANSWER. That reply selects the temporary-access fallback and is not a low-signal acknowledgement.

If Company Brain's last message asked a yes/no question or offered an action ("want me to check…", "should I search…", "I can look that up") and the new message is a short affirmative ("yeah", "yes", "sure", "go ahead", "please do"), use ANSWER. The user is accepting the offer, not sending noise.

${OTHER_BOTS_RULE}

${TRIAGE_OUTPUT_GRAMMAR}

${TRIAGE_REASON_RULES}

Thread triage never writes the answer itself; the main turn decides depth and tools. Preserve silence for genuine non-bot banter, but a plausible direct or implicit summons should receive a short ANSWER rather than be missed.`

export const TRIAGE_CHANNEL_PROMPT = `You triage top-level channel messages for Company Brain — a sharp, warm teammate with perfect memory and access to the company's tools. It is a member of this channel but was not @mentioned.

Decide by simulating that teammate. For every message ask, in order:
1. What does this imply beyond what it literally says — what just changed, for whom, and does anything now need doing? A status update implies consequences (coverage, deadlines, meetings). A wish for or joke aimed at an AI implies a summons. A complaint often contains an unanswered question.
2. Would that teammate reply, react, quietly check something first, or stay out of it? Route to the matching token.

Then hold the final message to a two-question gate before routing:
- Who is it for? A message that continues an exchange between people, or addresses another person or bot, belongs to them — stay out even when Company Brain knows the topic.
- What would Company Brain add that the people talking do not already have? A fact, a check, or offered legwork adds something; an opinion, a vote, or agreement in a human discussion adds nothing.
When either answer is not Company Brain, or nothing, route to PASS (or ACK when a reaction alone is honest).

The routes below are illustrations of that judgment, not its boundaries — generalize the reasoning, never the surface features:
- ANSWER — Company Brain replies in a thread. The teammate would speak: they can add something clear and non-obvious to an open question or discussion not aimed at a specific person; the message implicitly summons an AI, bot, assistant, or "the brain"; another bot visibly failed and the person turned to the channel for help; or one short warm or funny line would genuinely land in a low-stakes social moment.
- ACK — one emoji reaction, no message, and nothing needs doing: a ship announcement, win, milestone, farewell, welcome, or something genuinely funny it was not part of. When the moment also changes something (coverage, a risk, an open question), prefer INVESTIGATE or ANSWER over an emoji.
- INVESTIGATE — the teammate would check something before responding: prior work, ownership, schedules, on-call coverage, live data, or who needs to know. Use it for alarms (an incident, angry customer, scary metric or graph, contradiction with prior work) AND for human situations with practical consequences (someone out sick who may be on call, someone blocked, a deadline quietly slipping). Write the Reason as instructions to the full agent: what to verify, and what a good response looks like if confirmed. Investigation requires a checkable claim: a named failure, metric, person, or event the checks could confirm or refute. Vague frustration with nothing checkable routes to a short ANSWER that empathizes and offers to dig — the offer names what Company Brain would check, and the person's yes starts the real work.
- PASS — complete silence: humans talking to each other, banter that does not involve the bot, pure agreement, thanks, +1s, routine acknowledgements, and link dumps with no open question.

${ACK_EMOJI_RULES}

Worked examples of the judgment (generalize these; they are not an exhaustive list):
- "I'm feeling awful, taking today off." → INVESTIGATE. Reason: Priya is out sick today. Check whether she is on call or owns anything time-sensitive today; if so, find who can cover and ask them directly. Either way a short warm get-well line is appropriate.
- "so tired lol" after a normal day → PASS.
- "Decision: Priya owns the Atlas cutover, and launch is September 12." → ACK with pencil2. This is a durable update worth noting, and no response or investigation is needed.
- "we just shipped the new onboarding flow!" → ACK with tada.
- "shipped it, but signups look weird since the deploy?" → INVESTIGATE. Reason: possible post-deploy regression; check the signup metric and recent deploys, and surface what changed if confirmed.
- "ugh, snowcone is being a nightmare again" → ANSWER, short: empathize and offer — "that sounds rough. want me to dig into what snowcone's doing?" No checkable claim was named, so nothing is investigated until they say yes, and their frustration is theirs — never restate it as a company-wide fact.
- "man, if only some magical AI could entertain me right now" → ANSWER. That is a summons, answer in kind.
Most real messages match none of these examples. They demonstrate the reasoning, not the categories: the same topic can be any route depending on its implications. When a message resembles an example on the surface but its consequences differ, the consequences win — "so tired, was up all night fighting the pager" is an INVESTIGATE, not a PASS.

${OTHER_BOTS_RULE}

${TRIAGE_OUTPUT_GRAMMAR}

${TRIAGE_REASON_RULES}


When a recent "(app)" message from Company Brain asked a question or offered to do something, a short affirmative reply ("yes", "do it", "go ahead", "sure", "please") is acceptance of that offer, not low-signal chatter: route it to ANSWER so the main turn can act on the thing that was offered.

A bare company website or domain (like acme.com) is an actionable reply, not noise, when a recent "(app)" message from Company Brain asked for the company's website: route it to ANSWER so the main turn can store it and start research.
Triage does not write the response or choose its depth. Silence beats a mediocre reply. A direct or implicit summons, or a situation a good teammate would act on, is never a PASS; but when you cannot say from the final message who it is for and what Company Brain would add, PASS. A pure morale moment with nothing to do is an ACK rather than an answer.`

function truncateText(text: string, maxChars: number): string {
	const trimmed = text.trim().replace(/\s+/g, " ")
	const chars = Array.from(trimmed)
	if (chars.length <= maxChars) return trimmed
	const budget = maxChars - 1
	const slice = chars.slice(0, budget).join("")
	const lastBreak = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf(" "))
	const cut =
		lastBreak >= Math.floor(budget * 0.5) ? slice.slice(0, lastBreak) : slice
	return `${cut.trimEnd()}…`
}

function truncateReason(text: string): string {
	return truncateText(text, REASON_MAX_CHARS)
}

function promptField(value: string | undefined): string {
	return truncateText(value ?? "", PROMPT_FIELD_MAX_CHARS)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
}

const FALLBACK_REASON: Record<
	ChimeContext,
	Record<"parse_fallback" | "error_fallback", string>
> = {
	thread: {
		parse_fallback:
			"Thread triage output was invalid; Company Brain stayed silent.",
		error_fallback:
			"Thread triage generation failed; Company Brain stayed silent.",
	},
	channel: {
		parse_fallback:
			"Channel triage output was invalid; Company Brain stayed silent.",
		error_fallback:
			"Channel triage generation failed; Company Brain stayed silent.",
	},
}

function fallbackResult(
	context: ChimeContext,
	source: "parse_fallback" | "error_fallback",
): TriageResult {
	return {
		decision: "pass",
		source,
		reason: FALLBACK_REASON[context][source],
	}
}

function normalizedPayloadLines(text: string): string[] {
	return text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
}

const TRIAGE_TOKEN_LINE = /^(?:ANSWER|ACK|INVESTIGATE|PASS|CHIME|IGNORE)$/i
const TRIAGE_FIELD_LINE =
	/^(?:Emoji|Reason|Priority|Fallback|AgentMainEffort):/i

function parseAgentMainEffort(lines: string[]): Effort | undefined {
	const value = lines
		.find((line) => /^AgentMainEffort:/i.test(line))
		?.match(/^AgentMainEffort:\s*(low|medium|high|xhigh)$/i)?.[1]
	return value?.toLowerCase() as Effort | undefined
}

function parseReason(lines: string[], start: number): string | undefined {
	const match = lines[start]?.match(/^Reason:\s*(.*)$/)
	if (!match) return undefined
	const continuation = lines.slice(start + 1)
	if (
		continuation.some(
			(line) => TRIAGE_TOKEN_LINE.test(line) || TRIAGE_FIELD_LINE.test(line),
		)
	) {
		return undefined
	}
	const reason = truncateReason([match[1] ?? "", ...continuation].join(" "))
	return reason || undefined
}

function isTriageAckEmoji(value: string): value is TriageAckEmoji {
	return (TRIAGE_ACK_EMOJIS as readonly string[]).includes(value)
}

export function parseTriageResult(
	text: string,
	context: ChimeContext = "thread",
): TriageResult {
	const lines = normalizedPayloadLines(text)
	if (!lines.length) return fallbackResult(context, "parse_fallback")

	if (lines[0] === "ANSWER") {
		if (
			lines
				.slice(1)
				.some(
					(line) =>
						!/^(?:Priority|Fallback|Reason|AgentMainEffort):/i.test(line),
				)
		) {
			return fallbackResult(context, "parse_fallback")
		}
		const priorityLines = lines.filter((line) => /^Priority:/i.test(line))
		const fallbackLines = lines.filter((line) => /^Fallback:/i.test(line))
		const reasonLines = lines.filter((line) => /^Reason:/i.test(line))
		if (
			priorityLines.length > 1 ||
			fallbackLines.length > 1 ||
			reasonLines.length > 1 ||
			reasonLines.some((line) => !/^Reason:\s*\S/i.test(line))
		) {
			return fallbackResult(context, "parse_fallback")
		}
		const rawPriority = priorityLines[0]
			?.match(/^Priority:\s*([a-z]+)$/i)?.[1]
			?.toLowerCase()
		const priorityIsValid =
			rawPriority === "summons" ||
			rawPriority === "urgent" ||
			rawPriority === "normal" ||
			rawPriority === "low"
		const priority: TriagePriority = priorityIsValid ? rawPriority : "normal"
		const fallback = fallbackLines[0]?.match(
			/^Fallback:\s*ack\s+([a-z0-9_]+)$/i,
		)?.[1]
		const agentMainEffort = parseAgentMainEffort(lines)
		return {
			decision: "answer",
			source: "model",
			priority,
			...(!priorityIsValid ? { priorityNormalized: true as const } : {}),
			...(fallback && isTriageAckEmoji(fallback)
				? { fallbackEmoji: fallback }
				: {}),
			...(agentMainEffort ? { agentMainEffort } : {}),
		}
	}

	if (lines[0] === "ACK") {
		if (lines.length < 3) return fallbackResult(context, "parse_fallback")
		const emoji = lines[1]?.match(/^Emoji:\s*([a-z0-9_]+)$/)?.[1]
		const reason = parseReason(lines, 2)
		if (!emoji || !isTriageAckEmoji(emoji) || !reason) {
			return fallbackResult(context, "parse_fallback")
		}
		return { decision: "ack", source: "model", emoji, reason }
	}

	if (lines[0] === "INVESTIGATE") {
		const priorityLine = lines[1]?.match(/^Priority:\s*([a-z]+)$/i)?.[1]
		const normalizedPriority = priorityLine?.toLowerCase()
		const priorityIsValid =
			normalizedPriority === "urgent" || normalizedPriority === "normal"
		const reasonStart = lines.findIndex((line) => /^Reason:/i.test(line))
		const reason = parseReason(lines, reasonStart)
		const agentMainEffort = parseAgentMainEffort(lines)
		return reason
			? {
					decision: "investigate",
					source: "model",
					priority: normalizedPriority === "urgent" ? "urgent" : "normal",
					...(!priorityIsValid ? { priorityNormalized: true as const } : {}),
					reason,
					...(agentMainEffort ? { agentMainEffort } : {}),
				}
			: fallbackResult(context, "parse_fallback")
	}

	if (lines[0] === "PASS") {
		const reason = parseReason(lines, 1)
		return reason
			? { decision: "pass", source: "model", reason }
			: fallbackResult(context, "parse_fallback")
	}

	return fallbackResult(context, "parse_fallback")
}

const SHORT_AFFIRMATIVE =
	/^(?:(?:yeah|yes|yep|yup|sure|ok(?:ay)?)(?:\s+please)?|please(?:\s+do)?|go\s+ahead|do\s+it|sounds\s+good|that\s+works|absolutely|definitely|👍|✅)(?:[!.,]?\s*)*$/iu

const BOT_OFFER =
	/\b(?:(?:want|would)\s+(?:me|you)\s+(?:to|like)|should\s+i|shall\s+i|i\s+can\s+(?:check|search|look|dig|find)|want\s+me\s+to|would\s+you\s+like\s+me\s+to|like\s+me\s+to)\b/iu

const DIRECT_REQUEST_TO_BOT =
	/\b(?:can|could|would|will|should)\s+(?:you|u)\b|\bcan\s+i\s+(?:get|have)\b/iu
const OPEN_QUESTION = /(?:^|[.!]\s+)(?:what|why|how|where|when|who|which)\b/iu
const IMPERATIVE_REQUEST =
	/(?:^|[.!]\s+)(?:please\s+)?(?:send|share|show|tell|give|find|check|look|search|connect|reconnect|authorize|open|create|update|summarize|explain|retry|regenerate|refresh|run|do)\b/iu

export function isShortAffirmative(text: string): boolean {
	return SHORT_AFFIRMATIVE.test(text.trim())
}

export function botLastThreadMessageLooksLikeOffer(
	threadText: string,
): boolean {
	const lines = threadText
		.trim()
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
	const last = lines[lines.length - 1]
	const botLine = last?.match(/^(?:\[[^\]\n]+\]\s+)?Company Brain:\s*(.*)$/u)
	if (!botLine) return false
	const body = botLine[1]?.trim() ?? ""
	return BOT_OFFER.test(body)
}

export function isExplicitBotThreadFollowUp(args: {
	question: string
	botSpokePrevious: boolean
	addressedTo?: string
}): boolean {
	if (!args.botSpokePrevious || args.addressedTo?.trim()) return false
	const question = args.question.trim()
	if (!question) return false
	return (
		/\?\s*(?:["'’”\])}]*)$/u.test(question) ||
		DIRECT_REQUEST_TO_BOT.test(question) ||
		OPEN_QUESTION.test(question) ||
		IMPERATIVE_REQUEST.test(question) ||
		requesterLacksPersonalAppAccess(question)
	)
}

export function applyThreadExplicitFollowUpOverride(
	triage: Extract<TriageResult, { decision: "pass"; source: "model" }>,
	args: {
		question: string
		botSpokePrevious: boolean
		addressedTo?: string
	},
): TriageResult {
	return isExplicitBotThreadFollowUp(args)
		? {
				decision: "answer",
				source: "explicit_followup_override",
				priority: "summons",
			}
		: triage
}

export function applyThreadAffirmativeOverride(
	triage: Extract<TriageResult, { decision: "pass" }>,
	args: {
		question: string
		threadText: string
		botSpokePrevious: boolean
	},
): TriageResult {
	if (
		triage.source !== "model" ||
		!args.botSpokePrevious ||
		!isShortAffirmative(args.question) ||
		!botLastThreadMessageLooksLikeOffer(args.threadText)
	) {
		return triage
	}
	return {
		decision: "answer",
		source: "affirmative_override",
		priority: "summons",
	}
}

function formatChannelPrompt(channel: TriageChannel | undefined): string {
	if (!channel) return ""
	const name = promptField(channel.name)
	const topic = promptField(channel.topic) || promptField(channel.purpose)
	if (!name && !topic) return ""
	return `<channel>name: ${name ? `#${name.replace(/^#/, "")}` : "unknown"}; topic: ${topic || "not set"}</channel>`
}

function formatAddressSignals(targets: TriageAddressedTarget[]): string[] {
	const apps = targets.filter((target) => target.isBot)
	const people = targets.filter((target) => !target.isBot)
	const lines: string[] = []
	if (apps.length) {
		const labels = apps.map(
			(target) => promptField(target.name) || promptField(target.slackUserId),
		)
		lines.push(
			`Signal: this message @mentions the app${apps.length > 1 ? "s" : ""} ${labels.join(", ")}. PASS unless Company Brain is also explicitly asked.`,
		)
	}
	if (people.length) {
		const labels = people.map(
			(target) => promptField(target.name) || promptField(target.slackUserId),
		)
		lines.push(
			`Signal: this message @mentions ${labels.join(", ")} (not Company Brain). Prefer PASS unless they are only being kept in the loop and the request still clearly asks Company Brain.`,
		)
	}
	return lines
}

export function buildTriageUserPrompt(args: {
	question: string
	contextText: string
	context: ChimeContext
	currentSpeaker?: TriageSpeaker
	messageStamp?: string
	historyComplete?: boolean
	addressedTargets?: TriageAddressedTarget[]
	channel?: TriageChannel
}): string {
	const parts: string[] = []
	const channel = formatChannelPrompt(args.channel)
	if (channel) parts.push(channel, "")
	const hasHistory = Boolean(args.contextText.trim())
	if (hasHistory) {
		const label =
			args.context === "channel" ? "channel_history" : "thread_history"
		parts.push(`<${label}>`, args.contextText, `</${label}>`, "")
	}
	if (args.context === "thread" && args.historyComplete === false) {
		parts.push(
			"<thread_history_status>",
			"The thread history above is incomplete. Prefer ANSWER for an open contextual request unless it is clearly directed at someone else or another app.",
			"</thread_history_status>",
			"",
		)
	}
	const addressSignals = formatAddressSignals(args.addressedTargets ?? [])
	if (addressSignals.length) parts.push(...addressSignals, "")
	const name = promptField(args.currentSpeaker?.name)
	const id = promptField(args.currentSpeaker?.slackUserId)
	const speakerLabel =
		name || id ? `${name || id}${id ? ` (slack_user_id=${id})` : ""}` : ""
	const stamp = args.messageStamp ? `[${promptField(args.messageStamp)}] ` : ""
	const messageLine = speakerLabel
		? `${stamp}${speakerLabel}: ${args.question}`
		: `${stamp}${args.question}`
	if (hasHistory) {
		parts.push(
			'The message below is the next turn of the conversation above, in the same format. Read it as part of that conversation: "you" means whoever the speaker is talking to, which is Company Brain only when Company Brain is named, was asked, or spoke last.',
		)
	}
	parts.push(
		"Return exactly ANSWER, ACK, INVESTIGATE, or PASS using the required fields for that token, classifying only this final message:",
		`<new_message>\n${messageLine}\n</new_message>`,
	)
	return parts.join("\n")
}

export type TriageObservabilityContext = {
	orgId: string
	distinctId: string
	traceId: string
	sessionId?: string
	channel?: string
	messageTs?: string
	threadTs?: string
	chimeContext?: ChimeContext
	/** False only after the org exceeds its daily full-capture allowance. */
	triageTraceSampled?: boolean
	triageTraceSampleRate?: number
}

export function scheduleTriageOutcome(
	lifecycle: { waitUntil: (promise: Promise<void>) => void },
	obs: TriageObservabilityContext,
	outcome: TriageOutcome,
): void {
	lifecycle.waitUntil(
		(async () => {
			try {
				const { captureBrainTriageOutcome } = await import("../observability")
				await captureBrainTriageOutcome({
					...obs,
					chimeContext: obs.chimeContext ?? "thread",
					outcome,
				})
			} catch {
				console.warn(
					`[company-brain] triage_outcome_telemetry_failed trace=${obs.traceId} context=${obs.chimeContext ?? "thread"}`,
				)
			}
		})(),
	)
}

export async function triageChimeMessage(
	env: Env,
	args: {
		context: ChimeContext
		question: string
		contextText: string
		currentSpeaker?: TriageSpeaker
		messageStamp?: string
		historyComplete?: boolean
		obs?: TriageObservabilityContext
		waitUntil: (promise: Promise<void>) => void
		/** Thread-only: deterministic explicit-request and affirmative overrides. */
		threadFollowUpOverride?: { botSpokePrevious: boolean }
		/** People/apps @mentioned in the message other than Company Brain. */
		addressedTargets?: TriageAddressedTarget[]
		channel?: TriageChannel
		/** Per-org triage model and reasoning override. */
		profile?: ModelProfile
	},
): Promise<TriageResult> {
	const startedAt = Date.now()
	const profile =
		args.profile ?? createModelProfile(TRIAGE_MODEL, BRAIN_TRIAGE_EFFORT)
	const system =
		args.context === "channel" ? TRIAGE_CHANNEL_PROMPT : TRIAGE_THREAD_PROMPT
	const prompt = buildTriageUserPrompt({
		question: args.question,
		contextText: args.contextText,
		context: args.context,
		currentSpeaker: args.currentSpeaker,
		messageStamp: args.messageStamp,
		historyComplete: args.historyComplete,
		addressedTargets: args.addressedTargets,
		channel: args.channel,
	})
	let rawOutput: string | undefined
	let result: TriageResult
	let error: TriageGenerationError | undefined
	let providerError: TriageProviderError | undefined

	try {
		const [{ generateText }, { getBrainModel }] = await Promise.all([
			import("ai"),
			import("../turn/brain-model"),
		])
		const gen = await generateText({
			model: getBrainModel(profile.name, env),
			system,
			prompt,
			providerOptions: profile.providerOptions(profile.effort),
			maxRetries: 1,
			experimental_telemetry: {
				isEnabled: true,
				functionId: `company-brain-triage-${args.context}`,
			},
		})
		const text = gen.text
		rawOutput = text
		// Triage-only paths (pass/ack) need their own charge; answer paths also
		// bill the main turn separately — LLM COGS only, small triage overhead.
		if (args.obs?.orgId) {
			const ledger = new BrainCostLedger()
			ledger.recordFromGeneration({
				model: gen.response?.modelId ?? profile.name,
				usage: gen.usage,
				providerMetadata: gen.providerMetadata,
				responseBody: responseBodyFromResult(gen),
			})
			args.waitUntil(
				scheduleChargeBrainLlmCost({
					orgId: args.obs.orgId,
					ledger,
					source: `triage_${args.context}`,
					traceId: args.obs.traceId,
					env,
				}).then(() => {}),
			)
		}
		const parsed = parseTriageResult(text, args.context)
		error =
			parsed.source === "parse_fallback"
				? text.trim()
					? "triage_parse_invalid_structure"
					: "triage_parse_empty_output"
				: undefined
		result = parsed
		if (
			args.context === "thread" &&
			args.threadFollowUpOverride &&
			parsed.decision === "pass" &&
			parsed.source === "model"
		) {
			result = applyThreadExplicitFollowUpOverride(parsed, {
				question: args.question,
				botSpokePrevious: args.threadFollowUpOverride.botSpokePrevious,
				addressedTo: args.addressedTargets
					?.map((target) => target.name ?? target.slackUserId)
					.join(", "),
			})
			if (result.decision === "pass" && result.source === "model") {
				result = applyThreadAffirmativeOverride(result, {
					question: args.question,
					threadText: args.contextText,
					botSpokePrevious: args.threadFollowUpOverride.botSpokePrevious,
				})
			}
		}
		if (
			result.source === "explicit_followup_override" ||
			result.source === "affirmative_override"
		) {
			console.log(
				`[company-brain] triage override pass -> answer context=${args.context} source=${result.source}`,
			)
		}
	} catch (caught) {
		error = "triage_generation_failed"
		providerError = summarizeProviderError(caught)
		result = fallbackResult(args.context, "error_fallback")
		console.warn(
			`[company-brain] triage_generation_failed trace=${args.obs?.traceId ?? "-"} context=${args.context} name=${providerError.name ?? "unknown"} status=${providerError.statusCode ?? "unknown"}`,
		)
	}

	if (args.obs && args.obs.triageTraceSampled !== false) {
		const obs = args.obs
		args.waitUntil(
			(async () => {
				try {
					const { captureBrainTriageGeneration } = await import(
						"../observability"
					)
					await captureBrainTriageGeneration({
						orgId: obs.orgId,
						distinctId: obs.distinctId,
						traceId: obs.traceId,
						sessionId: obs.sessionId,
						channel: obs.channel,
						messageTs: obs.messageTs,
						threadTs: obs.threadTs,
						system,
						prompt,
						rawOutput,
						result,
						contextChars: args.contextText.length,
						chimeContext: obs.chimeContext,
						latencyMs: Date.now() - startedAt,
						isError: error !== undefined,
						error,
						providerError,
						model: profile.name,
						traceSampleRate: obs.triageTraceSampleRate,
					})
				} catch {
					console.warn(
						`[company-brain] triage_telemetry_failed trace=${obs.traceId} context=${args.context}`,
					)
				}
			})(),
		)
	}

	return result
}
