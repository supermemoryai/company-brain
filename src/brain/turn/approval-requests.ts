import type { ModelMessage } from "ai"
import { humanizeToolAction } from "../slack/format"
import type { TurnApprovalRequest } from "./types"
import {
	compactText,
	firstString,
	isRecord,
	toolInputArguments,
	toolInputSlug,
} from "./util"

const RECIPIENT_KEYS = [
	"to",
	"toEmail",
	"to_email",
	"toEmailAddress",
	"to_email_address",
	"recipient",
	"recipients",
	"recipientEmail",
	"recipient_email",
	"recipientEmailAddress",
	"recipient_email_address",
	"receiver",
	"receivers",
	"receiverEmail",
	"receiver_email",
	"email",
	"emails",
]

const EXTRA_RECIPIENT_KEYS = [
	"extraRecipients",
	"extra_recipients",
	"additionalTo",
	"additional_to",
]

const CC_KEYS = [
	"cc",
	"ccEmail",
	"cc_email",
	"ccEmails",
	"cc_emails",
	"additionalRecipients",
	"additional_recipients",
]

const BCC_KEYS = ["bcc", "bccEmail", "bcc_email", "bccEmails", "bcc_emails"]
const HIDDEN_RECIPIENT_KEYS = [
	"hiddenRecipients",
	"hidden_recipients",
	"hiddenRecipient",
	"hidden_recipient",
]

const ASSIGNEE_KEYS = [
	"assignee",
	"assigneeId",
	"assignee_id",
	"assigneeEmail",
	"assignee_email",
	"assignees",
	"owner",
	"ownerId",
	"owner_id",
	"ownerEmail",
	"owner_email",
]

const RECIPIENT_EMAIL_KEYS = [
	"email",
	"emailAddress",
	"email_address",
	"address",
]
const RECIPIENT_NAME_KEYS = ["name", "fullName", "full_name", "displayName"]

const TARGET_KEYS: Array<[string, string]> = [
	["threadId", "Thread"],
	["thread_id", "Thread"],
	["id", "ID"],
	["channel", "Channel"],
	["channelId", "Channel"],
	["issueId", "Issue"],
	["customerId", "Customer"],
	["repository", "Repository"],
	["repo", "Repository"],
	["url", "URL"],
]

const CODE_TARGET_KEYS = new Set([
	"threadId",
	"thread_id",
	"id",
	"issueId",
	"customerId",
	"repository",
	"repo",
])

const MESSAGE_CONTENT_KEYS = [
	"textContent",
	"markdownContent",
	"markdown",
	"body",
	"message",
	"messageBody",
	"message_body",
	"content",
	"emailBody",
	"email_body",
	"htmlContent",
	"html_content",
	"comment",
	"description",
]

const SUBJECT_KEYS = ["subject", "title"]

const FALLBACK_OMIT_KEYS = new Set([
	"arguments",
	"slug",
	...TARGET_KEYS.map(([key]) => key),
	...RECIPIENT_KEYS,
	...EXTRA_RECIPIENT_KEYS,
	...CC_KEYS,
	...BCC_KEYS,
	...HIDDEN_RECIPIENT_KEYS,
	...ASSIGNEE_KEYS,
	...SUBJECT_KEYS,
	...MESSAGE_CONTENT_KEYS,
])

function firstDefined(
	record: Record<string, unknown>,
	keys: string[],
): unknown {
	for (const key of keys) {
		if (record[key] !== undefined && record[key] !== null) return record[key]
	}
}

function recipientText(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) return value.trim()
	if (Array.isArray(value)) {
		const parts = value
			.map((item) => {
				if (typeof item === "string") return item.trim()
				if (!isRecord(item)) return ""
				const email = firstString(item, RECIPIENT_EMAIL_KEYS)
				const name = firstString(item, RECIPIENT_NAME_KEYS)
				if (email && name) return `${name} <${email}>`
				return email ?? name ?? ""
			})
			.filter(Boolean)
		return parts.length ? parts.join(", ") : undefined
	}
	if (isRecord(value)) {
		const email = firstString(value, RECIPIENT_EMAIL_KEYS)
		const name = firstString(value, RECIPIENT_NAME_KEYS)
		if (email && name) return `${name} <${email}>`
		return email ?? name
	}
}

function mergeRecipientText(...values: unknown[]): string | undefined {
	const parts = values
		.map(recipientText)
		.filter((part): part is string => Boolean(part))
		.flatMap((part) => part.split(/\s*,\s*/))
		.filter(Boolean)
	const unique = [...new Set(parts)]
	return unique.length ? unique.join(", ") : undefined
}

function approvalTargets(
	args: Record<string, unknown>,
	options?: { skipThreadTarget?: boolean },
): string[] {
	const targets: string[] = []
	for (const [key, label] of TARGET_KEYS) {
		if (
			options?.skipThreadTarget &&
			(key === "threadId" || key === "thread_id")
		) {
			continue
		}
		const value = args[key]
		if (typeof value === "string" && value.trim()) {
			targets.push(`${label}: ${formatTargetValue(key, value.trim())}`)
		}
	}
	return targets
}

function formatTargetValue(key: string, value: string): string {
	if (!CODE_TARGET_KEYS.has(key)) return value
	return `\`${value.replace(/`/g, "'")}\``
}

function approvalMainContent(
	args: Record<string, unknown>,
): string | undefined {
	return firstString(args, MESSAGE_CONTENT_KEYS)
}

function recipientCount(...values: unknown[]): number {
	return values.reduce<number>((count, value) => {
		if (Array.isArray(value)) return count + value.length
		return count + (recipientText(value) ? 1 : 0)
	}, 0)
}

function isGmailSendAction(action: string): boolean {
	const normalized = normalizedToolId(action)
	return /\bgmail\b/.test(normalized) && /\bsend\b/.test(normalized)
}

function gmailSendApprovalSummary(
	args: Record<string, unknown>,
	actionLabel: string,
): string {
	const lines: string[] = []
	const to = mergeRecipientText(
		firstDefined(args, RECIPIENT_KEYS),
		firstDefined(args, EXTRA_RECIPIENT_KEYS),
	)
	if (to) lines.push(compactText(`To: ${to}`, 500))
	const cc = recipientText(firstDefined(args, CC_KEYS))
	if (cc) lines.push(compactText(`Cc: ${cc}`, 500))
	const bccCount = recipientCount(
		firstDefined(args, BCC_KEYS),
		firstDefined(args, HIDDEN_RECIPIENT_KEYS),
	)
	if (bccCount)
		lines.push(`Bcc: ${bccCount} hidden recipient${bccCount === 1 ? "" : "s"}`)
	const subject = firstString(args, SUBJECT_KEYS)
	if (subject) lines.push(compactText(`Subject: ${subject}`, 300))
	const textBody =
		typeof args.text === "string"
			? args.text
			: typeof args.body === "string"
				? args.body
				: undefined
	const htmlBody = typeof args.html === "string" ? args.html : undefined
	const body = textBody ?? htmlBody
	lines.push(
		body?.trim()
			? compactText(`Body${htmlBody ? " (HTML)" : ""}:\n${body}`, 1_800)
			: "Body: (empty)",
	)
	lines.push(`Action: ${actionLabel}`)
	return lines.join("\n")
}

function sendToApprovalSummary(args: Record<string, unknown>): string {
	const lines: string[] = []
	const channel =
		typeof args.channel === "string" && args.channel.trim()
			? args.channel.trim()
			: undefined
	const user =
		typeof args.slackUserId === "string" && args.slackUserId.trim()
			? args.slackUserId.trim()
			: undefined
	if (channel) {
		const label = /^[CG][A-Z0-9]{6,}$/i.test(channel)
			? `<#${channel}>`
			: channel.startsWith("#") || channel.startsWith("<#")
				? channel
				: `#${channel}`
		lines.push(`To: ${label}`)
	} else if (user) {
		lines.push(`To: DM <@${user}>`)
	}
	const message = typeof args.message === "string" ? args.message : ""
	lines.push(
		message.trim()
			? compactText(`Message:\n${message}`, 1_800)
			: "Message: (empty)",
	)
	lines.push("Action: Deliver with your name attributed")
	return lines.join("\n")
}

function forgetMemoriesApprovalSummary(args: Record<string, unknown>): string {
	const count = Array.isArray(args.ids) ? args.ids.length : 0
	const lines: string[] = [
		`Forget: ${count} memor${count === 1 ? "y" : "ies"} previewed above`,
	]
	const query = firstString(args, ["query"])
	if (query) lines.push(compactText(`Match: ${query}`, 300))
	const reason = firstString(args, ["reason"])
	if (reason) lines.push(compactText(`Reason: ${reason}`, 300))
	lines.push("Action: Forget after requester approval")
	return lines.join("\n")
}

function approvalSummary(toolName: string, input: unknown): string {
	const slug = toolInputSlug(input)
	const action = slug ?? toolName
	const args = toolInputArguments(input)
	if (toolName === "send_to") return sendToApprovalSummary(args)
	if (toolName === "forget_memories") return forgetMemoriesApprovalSummary(args)
	if (isGmailSendAction(action)) {
		return gmailSendApprovalSummary(args, "Send email after requester approval")
	}
	const lines: string[] = []
	const to = mergeRecipientText(
		firstDefined(args, RECIPIENT_KEYS),
		firstDefined(args, EXTRA_RECIPIENT_KEYS),
	)
	const skipThreadTarget = Boolean(to) || /\b(email|gmail|mail)\b/i.test(action)
	lines.push(...approvalTargets(args, { skipThreadTarget }))

	if (to) lines.push(`To: ${to}`)
	const cc = recipientText(firstDefined(args, CC_KEYS))
	if (cc) lines.push(`Cc: ${cc}`)
	const bcc = mergeRecipientText(
		firstDefined(args, BCC_KEYS),
		firstDefined(args, HIDDEN_RECIPIENT_KEYS),
	)
	if (bcc) lines.push(`Bcc: ${bcc}`)
	const subject = firstString(args, SUBJECT_KEYS)
	if (subject) lines.push(`Subject: ${subject}`)
	const assignee = mergeRecipientText(firstDefined(args, ASSIGNEE_KEYS))
	if (assignee) lines.push(`Assignee: ${assignee}`)

	const main = approvalMainContent(args)
	if (main) {
		const prefix = lines.length ? `${lines.join("\n")}\n\n` : ""
		return compactText(`${prefix}${main}`)
	}

	const details = Object.entries(args)
		.filter(([key, value]) => {
			if (FALLBACK_OMIT_KEYS.has(key)) return false
			return (
				typeof value === "string" ||
				typeof value === "number" ||
				typeof value === "boolean"
			)
		})
		.slice(0, 6)
		.map(([key, value]) => `${key}: ${String(value)}`)
	if (details.length) lines.push(details.join("\n"))
	return lines.length ? lines.join("\n") : `Run ${humanizeToolAction(action)}`
}

function messageParts(message: ModelMessage): unknown[] {
	return Array.isArray(message.content) ? message.content : []
}

function isDraftKey(key: string): boolean {
	return /draft/i.test(key)
}

function normalizedToolId(value: string | undefined): string {
	return (value ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
}

function isGmailDraftCreateTool(toolId: string | undefined): boolean {
	const normalized = normalizedToolId(toolId)
	return (
		/\bgmail\b/.test(normalized) &&
		/\bdraft\b/.test(normalized) &&
		/\bcreate\b/.test(normalized)
	)
}

function isGmailDraftSendTool(toolId: string | undefined): boolean {
	const normalized = normalizedToolId(toolId)
	return (
		/\bgmail\b/.test(normalized) &&
		/\bdraft\b/.test(normalized) &&
		/\bsend\b/.test(normalized)
	)
}

function collectDraftIds(value: unknown, draftScoped = false): string[] {
	if (!value || typeof value !== "object") return []
	if (Array.isArray(value)) {
		return value.flatMap((item) => collectDraftIds(item, draftScoped))
	}
	const ids: string[] = []
	for (const [key, child] of Object.entries(value)) {
		const nextDraftScoped = draftScoped || isDraftKey(key)
		if (
			(key === "draft_id" ||
				key === "draftId" ||
				(key === "id" && draftScoped)) &&
			typeof child === "string" &&
			child.trim()
		) {
			ids.push(child.trim())
		}
		ids.push(...collectDraftIds(child, nextDraftScoped))
	}
	return ids
}

function firstDraftId(value: unknown): string | undefined {
	return collectDraftIds(value)[0]
}

function hasUnscopedId(value: unknown, draftScoped = false): boolean {
	if (!value || typeof value !== "object") return false
	if (Array.isArray(value)) {
		return value.some((item) => hasUnscopedId(item, draftScoped))
	}
	for (const [key, child] of Object.entries(value)) {
		const nextDraftScoped = draftScoped || isDraftKey(key)
		if (
			key === "id" &&
			!nextDraftScoped &&
			typeof child === "string" &&
			child.trim()
		) {
			return true
		}
		if (hasUnscopedId(child, nextDraftScoped)) return true
	}
	return false
}

function priorGmailDraftArgs(
	messages: ModelMessage[],
	draftId: string | undefined,
	allowSingleDraftFallback: boolean,
): Record<string, unknown> | undefined {
	const draftArgsByCallId = new Map<string, Record<string, unknown>>()
	for (const message of messages) {
		for (const part of messageParts(message)) {
			if (!isRecord(part) || part.type !== "tool-call") continue
			const toolCallId =
				typeof part.toolCallId === "string" ? part.toolCallId : undefined
			const input = "input" in part ? part.input : undefined
			if (!isGmailDraftCreateTool(toolInputSlug(input))) continue
			const args = toolInputArguments(input)
			if (toolCallId) draftArgsByCallId.set(toolCallId, args)
		}
	}
	if (draftId) {
		for (const message of messages) {
			for (const part of messageParts(message)) {
				if (!isRecord(part) || part.type !== "tool-result") continue
				const toolCallId =
					typeof part.toolCallId === "string" ? part.toolCallId : undefined
				if (!toolCallId) continue
				const args = draftArgsByCallId.get(toolCallId)
				if (!args) continue
				const output = "output" in part ? part.output : undefined
				if (collectDraftIds(output).includes(draftId)) return args
			}
		}
		return undefined
	}
	return allowSingleDraftFallback && draftArgsByCallId.size === 1
		? [...draftArgsByCallId.values()][0]
		: undefined
}

export function enrichApprovalRequestFromMessages(
	approval: TurnApprovalRequest,
	messages: ModelMessage[],
): TurnApprovalRequest {
	if (!isGmailDraftSendTool(approval.slug)) return approval
	const args = toolInputArguments(approval.input)
	const draftId = firstDraftId(args)
	const draftArgs = priorGmailDraftArgs(
		messages,
		draftId,
		!draftId && !hasUnscopedId(args),
	)
	if (!draftArgs) return approval
	const summary = approvalSummary(approval.toolName, {
		tool: "gmail.create_draft",
		arguments: draftArgs,
	})
	return {
		...approval,
		summary: compactText(`${summary}\n\nAction: Send Gmail draft`),
	}
}

export async function findApprovalRequests(result: {
	readonly content: PromiseLike<unknown[]>
}): Promise<TurnApprovalRequest[]> {
	let content: unknown[]
	try {
		content = await result.content
	} catch (err) {
		// A zero-step generation failure (transient LLM/stream error) rejects
		// result.content the same way it rejects result.output. Swallow it here and
		// report "no approval" so the caller falls through to deterministic reply
		// selection instead of throwing past it.
		console.warn(
			"[company-brain] approval detection skipped (stream error):",
			err,
		)
		return []
	}
	const approvals: TurnApprovalRequest[] = []
	for (const part of content) {
		if (!isRecord(part) || part.type !== "tool-approval-request") continue
		const approvalId =
			typeof part.approvalId === "string" ? part.approvalId : undefined
		const toolCall = isRecord(part.toolCall) ? part.toolCall : undefined
		const toolCallId =
			typeof toolCall?.toolCallId === "string" ? toolCall.toolCallId : undefined
		const toolName =
			typeof toolCall?.toolName === "string" ? toolCall.toolName : undefined
		if (!approvalId || !toolCallId || !toolName || !toolCall) continue
		const input = "input" in toolCall ? toolCall.input : undefined
		approvals.push({
			approvalId,
			toolCallId,
			toolName,
			slug: toolInputSlug(input),
			input,
			summary: approvalSummary(toolName, input),
		})
	}
	return approvals
}

export function batchApproval(
	approvals: TurnApprovalRequest[],
): TurnApprovalRequest | null {
	const [primary] = approvals
	if (!primary) return null
	if (approvals.length === 1) return primary
	const items = approvals.map(
		(a, i) => `*${i + 1}. ${a.slug ?? a.toolName}*\n${a.summary}`,
	)
	const summary = [
		`I want to run ${approvals.length} actions — approve to run all of them, deny to skip all:`,
		...items,
	].join("\n\n")
	return { ...primary, summary }
}

export function buildApprovalResponseMessage(
	approvalIds: string[],
	approved: boolean,
): ModelMessage {
	const reason = approved
		? "The Slack requester approved this action."
		: "The Slack requester denied this action. Do not retry it."
	return {
		role: "tool",
		content: approvalIds.map((approvalId) => ({
			type: "tool-approval-response" as const,
			approvalId,
			approved,
			reason,
		})),
	}
}
