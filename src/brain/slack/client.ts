import { slackCredentials } from "../../setup/config-store"
import { getCatalogIconUrlForToolLabel } from "../tools/mcp/catalog"
import {
	humanizeToolAction,
	markdownReplyBlocks,
	mrkdwnReplyBlocks,
	plainTextFallback,
	splitSlackMarkdown,
	toSlackMrkdwn,
} from "./format"

const SLACK_API = "https://slack.com/api"
const SLACK_FILE_UPLOAD_TIMEOUT_MS = 30_000

type SlackOkResponse = { ok: boolean; error?: string }
type SlackFileUploadBody = ArrayBuffer | ReadableStream<Uint8Array>

export type SlackFileUploadResult =
	| { ok: true; fileId: string }
	| {
			ok: false
			stage: "request_upload_url" | "upload_bytes" | "complete_upload"
			error: string
	  }

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function slackOkResponse(value: unknown): SlackOkResponse {
	if (!isRecord(value)) return { ok: false, error: "invalid_response" }
	return {
		ok: value.ok === true,
		...(typeof value.error === "string" ? { error: value.error } : {}),
	}
}

function uploadFailure(
	stage: Extract<SlackFileUploadResult, { ok: false }>["stage"],
	error: unknown,
): SlackFileUploadResult {
	return {
		ok: false,
		stage,
		error: error instanceof Error ? error.message : String(error),
	}
}

async function cancelSlackFileUploadBody(
	content: SlackFileUploadBody,
): Promise<void> {
	if (!(content instanceof ReadableStream)) return
	await content.cancel().catch(() => {})
}

/**
 * Upload a generated artifact directly to Slack and share it in the active
 * thread. Slack owns the final file; no temporary public object storage is
 * needed (or used) for sandbox artifacts.
 */
export async function uploadSlackFile(
	botToken: string,
	args: {
		channel: string
		threadTs?: string
		filename: string
		sizeBytes: number
		content: SlackFileUploadBody
		altText?: string
		signal?: AbortSignal
		canShare?: () => boolean
	},
): Promise<SlackFileUploadResult> {
	const length = args.sizeBytes
	const requestSignal = () => {
		const timeout = AbortSignal.timeout(SLACK_FILE_UPLOAD_TIMEOUT_MS)
		return args.signal ? AbortSignal.any([args.signal, timeout]) : timeout
	}
	if (args.signal?.aborted || args.canShare?.() === false) {
		await cancelSlackFileUploadBody(args.content)
		return uploadFailure("request_upload_url", "stale_turn")
	}
	if (!args.channel.trim()) {
		await cancelSlackFileUploadBody(args.content)
		return uploadFailure("request_upload_url", "missing_channel")
	}
	if (!args.filename.trim()) {
		await cancelSlackFileUploadBody(args.content)
		return uploadFailure("request_upload_url", "missing_filename")
	}
	if (!Number.isSafeInteger(length) || length <= 0) {
		await cancelSlackFileUploadBody(args.content)
		return uploadFailure("request_upload_url", "empty_file")
	}

	let ticket: {
		ok?: boolean
		error?: string
		upload_url?: string
		file_id?: string
	}
	try {
		// Slack documents JSON for this endpoint, but its production API currently
		// ignores JSON fields for this route and responds that `filename` and
		// `length` are missing. URL-encoded form data is supported and parsed
		// consistently by both external-upload endpoints.
		const requestUploadBody = new URLSearchParams({
			filename: args.filename,
			length: String(length),
			...(args.altText ? { alt_txt: args.altText.slice(0, 1000) } : {}),
		})
		const response = await fetch(`${SLACK_API}/files.getUploadURLExternal`, {
			method: "POST",
			signal: requestSignal(),
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				authorization: `Bearer ${botToken}`,
			},
			body: requestUploadBody,
		})
		if (!response.ok) {
			const failure = (await response.json().catch(() => ({}))) as typeof ticket
			await cancelSlackFileUploadBody(args.content)
			return uploadFailure(
				"request_upload_url",
				failure.error ?? `http_${response.status}`,
			)
		}
		ticket = (await response.json().catch(() => ({}))) as typeof ticket
		if (ticket.ok !== true || !ticket.upload_url || !ticket.file_id) {
			await cancelSlackFileUploadBody(args.content)
			return uploadFailure(
				"request_upload_url",
				ticket.error ?? "invalid_response",
			)
		}
	} catch (error) {
		await cancelSlackFileUploadBody(args.content)
		return uploadFailure("request_upload_url", error)
	}

	try {
		const response = await fetch(ticket.upload_url, {
			method: "POST",
			signal: requestSignal(),
			headers: { "content-type": "application/octet-stream" },
			body: args.content,
		})
		if (!response.ok) {
			await cancelSlackFileUploadBody(args.content)
			return uploadFailure("upload_bytes", `http_${response.status}`)
		}
	} catch (error) {
		await cancelSlackFileUploadBody(args.content)
		return uploadFailure("upload_bytes", error)
	}

	try {
		// Uploading bytes does not publish the file. Recheck the durable turn
		// immediately before Slack's completion call, which is the sharing step.
		if (args.signal?.aborted || args.canShare?.() === false) {
			return uploadFailure("complete_upload", "stale_turn")
		}
		const completeUploadBody = new URLSearchParams({
			files: JSON.stringify([{ id: ticket.file_id, title: args.filename }]),
			channel_id: args.channel,
			...(args.threadTs ? { thread_ts: args.threadTs } : {}),
		})
		const response = await fetch(`${SLACK_API}/files.completeUploadExternal`, {
			method: "POST",
			signal: requestSignal(),
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				authorization: `Bearer ${botToken}`,
			},
			body: completeUploadBody,
		})
		if (!response.ok) {
			const failure = (await response
				.json()
				.catch(() => ({}))) as SlackOkResponse
			return uploadFailure(
				"complete_upload",
				failure.error ?? `http_${response.status}`,
			)
		}
		const complete = (await response
			.json()
			.catch(() => ({}))) as SlackOkResponse
		if (complete.ok !== true) {
			return uploadFailure(
				"complete_upload",
				complete.error ?? "invalid_response",
			)
		}
		return { ok: true, fileId: ticket.file_id }
	} catch (error) {
		return uploadFailure("complete_upload", error)
	}
}

async function postSlackMessageRaw(
	botToken: string,
	channel: string,
	text: string,
	threadTs?: string,
	blocks?: unknown[],
): Promise<{ ok: boolean; ts?: string; error?: string }> {
	if (!channel) {
		console.warn("[slack] chat.postMessage skipped: missing channel")
		return { ok: false, error: "missing_channel" }
	}
	const res = await fetch(`${SLACK_API}/chat.postMessage`, {
		method: "POST",
		headers: {
			"content-type": "application/json; charset=utf-8",
			authorization: `Bearer ${botToken}`,
		},
		body: JSON.stringify({
			channel,
			text,
			...(blocks ? { blocks } : {}),
			...(threadTs ? { thread_ts: threadTs } : {}),
			unfurl_links: false,
			unfurl_media: false,
		}),
	})
	const data = (await res.json()) as {
		ok: boolean
		error?: string
		ts?: string
	}
	if (!data.ok) {
		console.warn(
			`[slack] chat.postMessage failed: ${data.error ?? "unknown"} channel=${channel}`,
		)
	}
	return { ok: data.ok, ts: data.ts, error: data.error }
}

export async function postSlackMessage(
	botToken: string,
	channel: string,
	text: string,
	threadTs?: string,
	blocks?: unknown[],
): Promise<string | undefined> {
	if (!channel) {
		console.warn("[slack] chat.postMessage skipped: missing channel")
		return undefined
	}
	const res = await fetch(`${SLACK_API}/chat.postMessage`, {
		method: "POST",
		headers: {
			"content-type": "application/json; charset=utf-8",
			authorization: `Bearer ${botToken}`,
		},
		body: JSON.stringify({
			channel,
			text: toSlackMrkdwn(text),
			...(blocks ? { blocks } : {}),
			...(threadTs ? { thread_ts: threadTs } : {}),
			unfurl_links: false,
			unfurl_media: false,
		}),
	})
	const data = (await res.json()) as {
		ok: boolean
		error?: string
		ts?: string
	}
	if (!data.ok) {
		console.warn(
			`[slack] chat.postMessage failed: ${data.error ?? "unknown"} channel=${channel}`,
		)
		return undefined
	}
	return data.ts
}

export type SlackPostResult =
	| { ok: true; ts: string; deduped?: boolean }
	| { ok: false; error: string; retryAfterSeconds?: number }

export async function inviteSlackUserToChannel(
	botToken: string,
	channel: string,
	slackUserId: string,
): Promise<
	{ ok: true } | { ok: false; error: string; retryAfterSeconds?: number }
> {
	try {
		const response = await fetch(`${SLACK_API}/conversations.invite`, {
			method: "POST",
			headers: {
				"content-type": "application/json; charset=utf-8",
				authorization: `Bearer ${botToken}`,
			},
			body: JSON.stringify({ channel, users: slackUserId }),
		})
		const retryAfter = retryAfterSeconds(response)
		if (!response.ok) {
			return {
				ok: false,
				error: `http_${response.status}`,
				...(retryAfter ? { retryAfterSeconds: retryAfter } : {}),
			}
		}
		const data = (await response.json().catch(() => ({}))) as {
			ok?: boolean
			error?: string
		}
		if (
			data.ok === true ||
			data.error === "already_in_channel" ||
			data.error === "cant_invite_self"
		) {
			return { ok: true }
		}
		return {
			ok: false,
			error: data.error ?? `http_${response.status}`,
			...(retryAfter ? { retryAfterSeconds: retryAfter } : {}),
		}
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

// A stable client_msg_id cannot double-post; Slack answers a repeat with ok and the original ts.
export async function postSlackMessageIdempotent(
	botToken: string,
	channel: string,
	text: string,
	clientMessageId: string,
	blocks?: unknown[],
): Promise<SlackPostResult> {
	const sentAt = Date.now() / 1000
	try {
		const response = await fetch(`${SLACK_API}/chat.postMessage`, {
			method: "POST",
			headers: {
				"content-type": "application/json; charset=utf-8",
				authorization: `Bearer ${botToken}`,
			},
			body: JSON.stringify({
				channel,
				text: toSlackMrkdwn(text),
				client_msg_id: clientMessageId,
				...(blocks ? { blocks } : {}),
				unfurl_links: false,
				unfurl_media: false,
			}),
		})
		const data = (await response.json().catch(() => ({}))) as {
			ok?: boolean
			error?: string
			ts?: string
		}
		if (data.ok === true && data.ts) {
			const deduped = sentAt - Number(data.ts) > 60
			return deduped
				? { ok: true, ts: data.ts, deduped }
				: { ok: true, ts: data.ts }
		}
		return {
			ok: false,
			error: data.error ?? `http_${response.status}`,
			...(retryAfterSeconds(response)
				? { retryAfterSeconds: retryAfterSeconds(response) }
				: {}),
		}
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

export async function postSlackEphemeral(
	botToken: string,
	channel: string,
	user: string,
	text: string,
	threadTs?: string,
	blocks?: unknown[],
): Promise<boolean> {
	if (!channel || !user) {
		console.warn("[slack] chat.postEphemeral skipped: missing channel or user")
		return false
	}
	try {
		const res = await fetch(`${SLACK_API}/chat.postEphemeral`, {
			method: "POST",
			headers: {
				"content-type": "application/json; charset=utf-8",
				authorization: `Bearer ${botToken}`,
			},
			body: JSON.stringify({
				channel,
				user,
				text: toSlackMrkdwn(text),
				...(blocks ? { blocks } : {}),
				...(threadTs ? { thread_ts: threadTs } : {}),
				unfurl_links: false,
				unfurl_media: false,
			}),
		})
		const data = (await res.json()) as {
			ok: boolean
			error?: string
		}
		if (!data.ok) {
			console.warn(
				`[slack] chat.postEphemeral failed: ${data.error ?? "unknown"} channel=${channel} user=${user}`,
			)
			return false
		}
		return true
	} catch (error) {
		console.warn("[slack] chat.postEphemeral error:", error)
		return false
	}
}

/** Model reply: one sentence-aligned message per Slack markdown payload, with
 * mrkdwn and plain-text fallbacks applied independently to each message.
 * `complete` is false unless every chunk landed, so callers that must know the
 * whole reply was seen don't read a partial post as delivered. */
export async function postSlackReplyDelivery(
	botToken: string,
	channel: string,
	reply: string,
	threadTs?: string,
	extraBlocks?: unknown[],
): Promise<{ ts?: string; complete: boolean }> {
	if (!reply.trim()) return { complete: false }
	let latestTs: string | undefined
	const chunks = splitSlackMarkdown(reply)
	for (const [index, chunk] of chunks.entries()) {
		const chunkTs = await postSlackReplyChunk(
			botToken,
			channel,
			chunk,
			threadTs,
			index === chunks.length - 1 ? extraBlocks : undefined,
		)
		// A prior chunk is already visible, so reporting its timestamp prevents an
		// outer fallback from duplicating the answer if a later Slack request fails.
		if (!chunkTs) return { ts: latestTs, complete: false }
		latestTs = chunkTs
	}
	// An empty chunk list posts nothing, so completeness tracks the last ts.
	return { ts: latestTs, complete: Boolean(latestTs) }
}

export async function postSlackReply(
	botToken: string,
	channel: string,
	reply: string,
	threadTs?: string,
	extraBlocks?: unknown[],
): Promise<string | undefined> {
	return (
		await postSlackReplyDelivery(
			botToken,
			channel,
			reply,
			threadTs,
			extraBlocks,
		)
	).ts
}

async function postSlackReplyChunk(
	botToken: string,
	channel: string,
	reply: string,
	threadTs?: string,
	extraBlocks?: unknown[],
): Promise<string | undefined> {
	const markdown = await postSlackMessageRaw(
		botToken,
		channel,
		plainTextFallback(reply),
		threadTs,
		[...markdownReplyBlocks(reply), ...(extraBlocks ?? [])],
	)
	if (markdown.ok) return markdown.ts

	console.warn(
		`[slack] markdown block reply failed (${markdown.error ?? "unknown"}); trying mrkdwn section`,
	)
	const mrkdwn = await postSlackMessageRaw(
		botToken,
		channel,
		toSlackMrkdwn(reply),
		threadTs,
		[...mrkdwnReplyBlocks(reply), ...(extraBlocks ?? [])],
	)
	if (mrkdwn.ok) return mrkdwn.ts

	console.warn(
		`[slack] mrkdwn section reply failed (${mrkdwn.error ?? "unknown"}); trying plain text`,
	)
	const plain = await postSlackMessageRaw(
		botToken,
		channel,
		toSlackMrkdwn(reply),
		threadTs,
	)
	return plain.ok ? plain.ts : undefined
}

export async function getSlackMessageBlocks(
	botToken: string,
	channel: string,
	threadTs: string,
	messageTs: string,
): Promise<{ text: string; blocks: unknown[] } | null> {
	try {
		const params = new URLSearchParams({
			channel,
			ts: threadTs,
			oldest: messageTs,
			inclusive: "true",
			limit: "2",
		})
		const res = await fetch(`${SLACK_API}/conversations.replies?${params}`, {
			headers: { authorization: `Bearer ${botToken}` },
		})
		const data = (await res.json()) as {
			ok: boolean
			error?: string
			messages?: Array<{ ts?: string; text?: string; blocks?: unknown[] }>
		}
		if (!data.ok) {
			console.warn(
				`[slack] conversations.replies failed: ${data.error ?? "unknown"}`,
			)
			return null
		}
		const message = data.messages?.find((m) => m.ts === messageTs)
		if (!message) return null
		return { text: message.text ?? "", blocks: message.blocks ?? [] }
	} catch (error) {
		console.warn("[slack] conversations.replies error:", error)
		return null
	}
}

export async function updateSlackMessage(
	botToken: string,
	channel: string,
	ts: string,
	text: string,
	blocks?: unknown[],
): Promise<boolean> {
	try {
		const res = await fetch(`${SLACK_API}/chat.update`, {
			method: "POST",
			headers: {
				"content-type": "application/json; charset=utf-8",
				authorization: `Bearer ${botToken}`,
			},
			body: JSON.stringify({
				channel,
				ts,
				// Blocks carry the complete formatted answer. Keep Slack's top-level
				// notification/fallback text bounded or chat.update rejects an otherwise
				// valid long markdown block with msg_too_long.
				text: blocks?.length ? plainTextFallback(text) : toSlackMrkdwn(text),
				...(blocks ? { blocks } : {}),
			}),
		})
		const data = slackOkResponse(await res.json())
		if (!data.ok) {
			console.warn(`[slack] chat.update failed: ${data.error ?? "unknown"}`)
		}
		return data.ok
	} catch (error) {
		console.warn("[slack] chat.update error:", error)
		return false
	}
}

export async function deleteSlackMessage(
	botToken: string,
	channel: string,
	ts: string,
): Promise<boolean> {
	try {
		const res = await fetch(`${SLACK_API}/chat.delete`, {
			method: "POST",
			headers: {
				"content-type": "application/json; charset=utf-8",
				authorization: `Bearer ${botToken}`,
			},
			body: JSON.stringify({ channel, ts }),
		})
		const data = slackOkResponse(await res.json())
		if (!data.ok) {
			console.warn(`[slack] chat.delete failed: ${data.error ?? "unknown"}`)
		}
		return data.ok
	} catch (error) {
		console.warn("[slack] chat.delete error:", error)
		return false
	}
}

export async function getSlackMessagePermalink(
	botToken: string,
	channel: string,
	messageTs: string,
): Promise<string | undefined> {
	try {
		const res = await fetch(`${SLACK_API}/chat.getPermalink`, {
			method: "POST",
			headers: {
				"content-type": "application/json; charset=utf-8",
				authorization: `Bearer ${botToken}`,
			},
			body: JSON.stringify({ channel, message_ts: messageTs }),
		})
		const data = (await res.json()) as {
			ok: boolean
			error?: string
			permalink?: string
		}
		if (!data.ok) {
			console.warn(
				`[slack] chat.getPermalink failed: ${data.error ?? "unknown"}`,
			)
			return undefined
		}
		return data.permalink
	} catch (error) {
		console.warn("[slack] chat.getPermalink error:", error)
		return undefined
	}
}

export type SlackMessageReaction = { name: string; count: number }

// Reactions on one message. The only signal we get on whether a sent post landed,
// short of someone replying.
export async function getSlackMessageReactions(
	botToken: string,
	channel: string,
	messageTs: string,
): Promise<SlackMessageReaction[]> {
	try {
		const url = new URL(`${SLACK_API}/reactions.get`)
		url.searchParams.set("channel", channel)
		url.searchParams.set("timestamp", messageTs)
		const res = await fetch(url, {
			headers: { authorization: `Bearer ${botToken}` },
		})
		const data = (await res.json()) as {
			ok: boolean
			error?: string
			message?: { reactions?: Array<{ name?: string; count?: number }> }
		}
		if (!data.ok) {
			console.warn(`[slack] reactions.get failed: ${data.error ?? "unknown"}`)
			return []
		}
		return (data.message?.reactions ?? []).flatMap((r) =>
			r.name ? [{ name: r.name, count: r.count ?? 0 }] : [],
		)
	} catch (error) {
		console.warn("[slack] reactions.get error:", error)
		return []
	}
}

export type SlackApprovalCard = {
	approvalId: string
	summary: string
	toolName: string
	slug?: string
	iconUrl?: string
	askerUser: string
	expiresAt: number
}

const BRAIN_LOGO_URL = "https://supermemory.ai/images/brain-head.png"

const APPROVAL_STATUS_META: Record<string, { emoji: string; label: string }> = {
	Approved: { emoji: "✅", label: "Approved" },
	Denied: { emoji: "🚫", label: "Denied" },
	Expired: { emoji: "⌛", label: "Expired" },
	Cancelled: { emoji: "🛑", label: "Cancelled" },
}

const clip = (s: string, n: number) =>
	s.length > n ? `${s.slice(0, n - 1)}…` : s

function actionLabels(action: string): { app?: string; operation: string } {
	const [app, ...operationParts] = action.split(" · ")
	if (!app || operationParts.length === 0) return { operation: action }
	return { app, operation: operationParts.join(" · ") }
}

// Slack `container` block: title/subtitle ≤150, ≤10 child blocks.
// The full summary lives in a section child (≤~3000) so nothing is hidden
// before approval; card's 200-char body cap would clip the write-action body.
export function approvalBlocks(
	card: SlackApprovalCard,
	status?: string,
): unknown[] {
	const expires = Math.floor(card.expiresAt / 1000)
	const action = humanizeToolAction(card.slug ?? card.toolName)
	const meta = status ? APPROVAL_STATUS_META[status] : undefined
	const iconUrl =
		card.iconUrl ??
		getCatalogIconUrlForToolLabel(card.slug, card.toolName, action) ??
		BRAIN_LOGO_URL
	const labels = actionLabels(action)
	const statusLabel = meta?.label ?? status
	const title = status
		? `${labels.operation} ${statusLabel?.toLowerCase() ?? ""}`.trim()
		: `${labels.operation} needs approval`
	const subtitle = [
		labels.app,
		status ? "Decision recorded" : "Review exact action",
	]
		.filter(Boolean)
		.join(" · ")

	const childBlocks: unknown[] = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: clip(`*What will happen*\n${toSlackMrkdwn(card.summary)}`, 2900),
			},
		},
	]

	if (status) {
		childBlocks.push({
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: `${meta?.emoji ?? ""} ${statusLabel ?? status} · Requested by <@${card.askerUser}>`,
				},
			],
		})
	} else {
		childBlocks.push(
			{
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: `<@${card.askerUser}> requested this · Expires <!date^${expires}^{time}|in 15 minutes> · 🔒 Only what’s listed above will run`,
					},
				],
			},
			{
				type: "actions",
				elements: [
					{
						type: "button",
						action_id: "brain_approval_approve",
						value: card.approvalId,
						style: "primary",
						text: {
							type: "plain_text",
							text: "Approve action",
							emoji: true,
						},
					},
					{
						type: "button",
						action_id: "brain_approval_deny",
						value: card.approvalId,
						text: { type: "plain_text", text: "Deny", emoji: true },
					},
				],
			},
		)
	}

	return [
		{
			type: "container",
			width: "standard",
			has_header_divider: !status,
			...(status ? { is_collapsible: true, default_collapsed: true } : {}),
			icon: {
				type: "image",
				image_url: iconUrl,
				alt_text: action,
			},
			title: { type: "plain_text", text: clip(title, 150), emoji: true },
			subtitle: { type: "mrkdwn", text: clip(subtitle, 150) },
			child_blocks: childBlocks,
		},
	]
}

export async function postSlackApprovalCard(
	botToken: string,
	channel: string,
	threadTs: string,
	card: SlackApprovalCard,
): Promise<string | undefined> {
	return postSlackMessage(
		botToken,
		channel,
		`${card.slug ?? card.toolName} needs approval from <@${card.askerUser}>.`,
		threadTs,
		approvalBlocks(card),
	)
}

export async function updateSlackInteractionResponse(
	responseUrl: string,
	payload: {
		text: string
		blocks?: unknown[]
		replaceOriginal?: boolean
		responseType?: "ephemeral" | "in_channel"
	},
): Promise<boolean> {
	if (!responseUrl) return false
	try {
		const res = await fetch(responseUrl, {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify({
				text: toSlackMrkdwn(payload.text),
				...(payload.blocks ? { blocks: payload.blocks } : {}),
				replace_original: payload.replaceOriginal ?? false,
				...(payload.responseType
					? { response_type: payload.responseType }
					: {}),
			}),
		})
		if (!res.ok) {
			console.warn(`[slack] response_url update failed HTTP ${res.status}`)
			return false
		}
		return true
	} catch (error) {
		console.warn("[slack] response_url update error:", error)
		return false
	}
}

export async function deleteSlackInteractionResponse(
	responseUrl: string,
): Promise<boolean> {
	if (!responseUrl) return false
	try {
		const res = await fetch(responseUrl, {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify({ delete_original: true }),
		})
		if (!res.ok) {
			console.warn(`[slack] response_url delete failed HTTP ${res.status}`)
			return false
		}
		return true
	} catch (error) {
		console.warn("[slack] response_url delete error:", error)
		return false
	}
}

export function resolvedApprovalBlocks(
	card: SlackApprovalCard,
	status: "Approved" | "Denied" | "Expired" | "Cancelled",
): unknown[] {
	return approvalBlocks(card, status)
}

export type SlackLeaseCard = {
	requestId: string
	serverSlug: string
	serverName: string
	askerUser: string
	askerName?: string
	iconUrl?: string
	ownerSlackUsers?: string[]
	channel: string
	reason: string
	capabilities: string
	expiresAt: number
}

export type LeaseCardStatus =
	| "Approved"
	| "Denied"
	| "Declined"
	| "Unavailable"
	| "Expired"
	| "Cancelled"
	| "Revoked"

const LEASE_STATUS_META: Record<string, { emoji: string; label: string }> = {
	Approved: { emoji: "✅", label: "Approved" },
	Denied: { emoji: "🚫", label: "Denied" },
	Declined: { emoji: "🚫", label: "Declined" },
	Unavailable: { emoji: "⚠️", label: "No longer available" },
	Expired: { emoji: "⌛", label: "Expired" },
	Cancelled: { emoji: "🛑", label: "Cancelled" },
	Revoked: { emoji: "🛑", label: "Revoked" },
}

function slackMentionList(slackUserIds: string[]): string {
	const mentions = [...new Set(slackUserIds)].map((userId) => `<@${userId}>`)
	if (mentions.length <= 1) return mentions[0] ?? ""
	if (mentions.length === 2) return `${mentions[0]} and ${mentions[1]}`
	return `${mentions.slice(0, -1).join(", ")}, and ${mentions.at(-1)}`
}

export function leaseBlocks(
	card: SlackLeaseCard,
	status?: string,
	revokeLeaseId?: string,
	statusDetail?: string,
): unknown[] {
	const expires = Math.floor(card.expiresAt / 1000)
	const meta = status ? LEASE_STATUS_META[status] : undefined
	const ownerSlackUsers = [...new Set(card.ownerSlackUsers ?? [])]
	const ownerMentions = slackMentionList(ownerSlackUsers)
	const title = status
		? `${card.serverName} access ${(meta?.label ?? status).toLowerCase()}`.trim()
		: `Grant temporary ${card.serverName} access?`
	const decisionScope = ownerMentions
		? "Only tagged connection owners can decide"
		: ""
	const canCollapse = Boolean(
		status && !(status === "Approved" && revokeLeaseId),
	)
	const iconUrl =
		card.iconUrl ??
		getCatalogIconUrlForToolLabel(card.serverSlug, card.serverName) ??
		BRAIN_LOGO_URL
	const askerName = card.askerName?.trim() || "a teammate"

	const childBlocks: unknown[] = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: clip(`*Why they need it*\n${toSlackMrkdwn(card.reason)}`, 1900),
			},
		},
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: clip(
					`*${ownerSlackUsers.length === 1 ? "Connection owner" : "Connection owners"}*  ${ownerMentions || "Eligible workspace connection owner"}\n*Access*  ${toSlackMrkdwn(card.capabilities)}`,
					1900,
				),
			},
		},
	]
	if (status) {
		const statusLabel = meta ? `${meta.emoji} ${meta.label}` : status
		childBlocks.push({
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: clip(
						statusDetail
							? `${statusLabel} · ${toSlackMrkdwn(statusDetail)}`
							: statusLabel,
						1900,
					),
				},
			],
		})
		if (status === "Approved" && revokeLeaseId) {
			childBlocks.push({
				type: "actions",
				elements: [
					{
						type: "button",
						action_id: "brain_lease_revoke",
						value: revokeLeaseId,
						style: "danger",
						text: {
							type: "plain_text",
							text: "Revoke access",
							emoji: true,
						},
					},
				],
			})
		}
	} else {
		childBlocks.push(
			{
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: `🔒 ${decisionScope ? `${decisionScope} · ` : ""}This thread only · Expires <!date^${expires}^{time}|at the shown time>`,
					},
				],
			},
			{
				type: "actions",
				elements: [
					{
						type: "button",
						action_id: "brain_lease_approve",
						value: card.requestId,
						style: "primary",
						text: {
							type: "plain_text",
							text: "Grant temporary access",
							emoji: true,
						},
					},
					{
						type: "button",
						action_id: "brain_lease_deny",
						value: card.requestId,
						text: { type: "plain_text", text: "Deny", emoji: true },
					},
				],
			},
		)
	}
	return [
		{
			type: "container",
			width: "standard",
			has_header_divider: !canCollapse,
			...(canCollapse ? { is_collapsible: true, default_collapsed: true } : {}),
			icon: {
				type: "image",
				image_url: iconUrl,
				alt_text: card.serverName,
			},
			title: { type: "plain_text", text: clip(title, 150), emoji: true },
			subtitle: {
				type: "plain_text",
				text: clip(
					`Requested by ${askerName} · Access to ${card.serverName}`,
					150,
				),
			},
			child_blocks: childBlocks,
		},
	]
}

export function resolvedLeaseBlocks(
	card: SlackLeaseCard,
	status: LeaseCardStatus,
	leaseId?: string,
	statusDetail?: string,
): unknown[] {
	return leaseBlocks(card, status, leaseId, statusDetail)
}

export async function postSlackLeaseCardToThread(
	botToken: string,
	channel: string,
	threadTs: string,
	card: SlackLeaseCard,
): Promise<{ channel: string; ts: string } | undefined> {
	const ts = await postSlackMessage(
		botToken,
		channel,
		`${card.serverName} access requested by ${card.askerName?.trim() || "a teammate"}.`,
		threadTs,
		leaseBlocks(card),
	)
	return ts ? { channel, ts } : undefined
}
export async function startSlackStream(
	botToken: string,
	channel: string,
	threadTs: string | undefined,
	recipientUserId?: string,
	recipientTeamId?: string,
	taskDisplayMode?: "timeline" | "plan" | "dense",
): Promise<string | undefined> {
	if (!channel || !threadTs) return undefined
	try {
		const res = await fetch(`${SLACK_API}/chat.startStream`, {
			method: "POST",
			headers: {
				"content-type": "application/json; charset=utf-8",
				authorization: `Bearer ${botToken}`,
			},
			body: JSON.stringify({
				channel,
				thread_ts: threadTs,
				...(recipientUserId ? { recipient_user_id: recipientUserId } : {}),
				...(recipientTeamId ? { recipient_team_id: recipientTeamId } : {}),
				...(taskDisplayMode ? { task_display_mode: taskDisplayMode } : {}),
			}),
		})
		const data = (await res.json()) as {
			ok: boolean
			error?: string
			ts?: string
		}
		if (!data.ok) {
			console.warn(
				`[slack] chat.startStream failed: ${data.error ?? "unknown"}`,
			)
			return undefined
		}
		return data.ts
	} catch (error) {
		console.warn("[slack] chat.startStream error:", error)
		return undefined
	}
}
export type StreamChunk =
	| { type: "markdown_text"; text: string }
	| { type: "blocks"; blocks: unknown[] }
	| {
			type: "task_update"
			id: string
			title: string
			status: "pending" | "in_progress" | "complete" | "error"
			details?: string
			output?: string
			sources?: { type: "url"; url: string; text: string }[]
	  }
	| { type: "plan_update"; title: string }

/** Append sentence-aligned markdown_text chunks, then a mrkdwn block fallback. */
export async function appendSlackStreamReply(
	botToken: string,
	channel: string,
	ts: string,
	reply: string,
): Promise<boolean> {
	const chunks: StreamChunk[] = splitSlackMarkdown(reply).map((text) => ({
		type: "markdown_text",
		text,
	}))
	const markdownOk = await appendSlackStreamChunks(
		botToken,
		channel,
		ts,
		chunks,
	)
	if (markdownOk) return true

	console.warn(
		"[slack] markdown_text stream append failed; trying mrkdwn blocks chunk",
	)
	const fallbackBlocks = mrkdwnReplyBlocks(reply)
	return appendSlackStreamChunks(botToken, channel, ts, [
		{ type: "blocks", blocks: fallbackBlocks },
	])
}
export async function appendSlackStreamChunks(
	botToken: string,
	channel: string,
	ts: string,
	chunks: StreamChunk[],
): Promise<boolean> {
	if (!chunks.length) return true
	try {
		const res = await fetch(`${SLACK_API}/chat.appendStream`, {
			method: "POST",
			headers: {
				"content-type": "application/json; charset=utf-8",
				authorization: `Bearer ${botToken}`,
			},
			body: JSON.stringify({ channel, ts, chunks }),
		})
		const data = slackOkResponse(await res.json())
		if (!data.ok) {
			console.warn(
				`[slack] chat.appendStream failed: ${data.error ?? "unknown"}`,
			)
		}
		return data.ok
	} catch (error) {
		console.warn("[slack] chat.appendStream error:", error)
		return false
	}
}
export async function stopSlackStream(
	botToken: string,
	channel: string,
	ts: string,
	options?: {
		chunks?: StreamChunk[]
		markdownText?: string
		blocks?: unknown[]
	},
): Promise<boolean> {
	try {
		const markdownChunks: StreamChunk[] = options?.markdownText?.trim()
			? splitSlackMarkdown(options.markdownText).map((text) => ({
					type: "markdown_text",
					text,
				}))
			: []
		const chunks = [...(options?.chunks ?? []), ...markdownChunks]
		const res = await fetch(`${SLACK_API}/chat.stopStream`, {
			method: "POST",
			headers: {
				"content-type": "application/json; charset=utf-8",
				authorization: `Bearer ${botToken}`,
			},
			body: JSON.stringify({
				channel,
				ts,
				...(chunks.length ? { chunks } : {}),
				...(options?.blocks?.length ? { blocks: options.blocks } : {}),
			}),
		})
		const data = slackOkResponse(await res.json())
		if (!data.ok) {
			console.warn(`[slack] chat.stopStream failed: ${data.error ?? "unknown"}`)
		}
		return data.ok
	} catch (error) {
		console.warn("[slack] chat.stopStream error:", error)
		return false
	}
}
export async function getSlackBotIdentity(
	botToken: string,
): Promise<{ userId?: string; botId?: string }> {
	try {
		const res = await fetch(`${SLACK_API}/auth.test`, {
			method: "POST",
			headers: { authorization: `Bearer ${botToken}` },
		})
		const data = (await res.json()) as {
			ok: boolean
			user_id?: string
			bot_id?: string
		}
		if (!data.ok) return {}
		return { userId: data.user_id, botId: data.bot_id }
	} catch {
		return {}
	}
}

export async function getSlackBotUserId(
	botToken: string,
): Promise<string | undefined> {
	const { userId } = await getSlackBotIdentity(botToken)
	return userId
}

export type SlackConversationInfo = {
	id?: string
	name?: string
	topic?: string
	purpose?: string
	isPrivate?: boolean
	isMember?: boolean
	isArchived?: boolean
}

export type SlackConversationInfoLookup =
	| { ok: true; info: SlackConversationInfo }
	| {
			ok: false
			reason:
				| "missing_channel_id"
				| "conversation_unavailable"
				| "slack_api_error"
			error?: string
	  }

function isTransientSlackConversationError(
	status: number,
	error: string | undefined,
): boolean {
	if (status === 408 || status === 429 || status >= 500) return true
	return /rate.?limit|temporar|timeout|internal_error|service_unavailable/i.test(
		error ?? "",
	)
}

export async function lookupSlackConversationInfo(
	botToken: string,
	channel: string,
): Promise<SlackConversationInfoLookup> {
	if (!channel) return { ok: false, reason: "missing_channel_id" }
	try {
		const url = new URL(`${SLACK_API}/conversations.info`)
		url.searchParams.set("channel", channel)
		const res = await fetch(url, {
			headers: { authorization: `Bearer ${botToken}` },
		})
		const data = (await res.json()) as {
			ok: boolean
			error?: string
			channel?: {
				id?: string
				name?: string
				topic?: { value?: string }
				purpose?: { value?: string }
				is_private?: boolean
				is_member?: boolean
				is_archived?: boolean
			}
		}
		if (!data.ok) {
			console.warn(
				`[slack] conversations.info failed: ${data.error ?? "unknown"} channel=${channel}`,
			)
			return {
				ok: false,
				reason: isTransientSlackConversationError(res.status, data.error)
					? "slack_api_error"
					: "conversation_unavailable",
				error: data.error ?? `http_${res.status}`,
			}
		}
		if (!data.channel) {
			return {
				ok: false,
				reason: "conversation_unavailable",
				error: "channel_unavailable",
			}
		}
		return {
			ok: true,
			info: {
				id: data.channel.id,
				name: data.channel.name,
				topic: data.channel.topic?.value?.trim() || undefined,
				purpose: data.channel.purpose?.value?.trim() || undefined,
				isPrivate: data.channel.is_private,
				isMember: data.channel.is_member,
				isArchived: data.channel.is_archived,
			},
		}
	} catch (error) {
		console.warn("[slack] conversations.info error:", error)
		return {
			ok: false,
			reason: "slack_api_error",
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

export async function getSlackConversationInfo(
	botToken: string,
	channel: string,
): Promise<SlackConversationInfo | undefined> {
	const lookup = await lookupSlackConversationInfo(botToken, channel)
	return lookup.ok ? lookup.info : undefined
}

const SLACK_CONVERSATION_INFO_CACHE_TTL_SECONDS = 10 * 60

/** Short-lived channel identity cache for passive triage context. */
export async function getCachedSlackConversationInfo(
	env: Env,
	teamId: string,
	botToken: string,
	channel: string,
): Promise<SlackConversationInfo | undefined> {
	const cacheKey = `slack:conversation-info:${teamId}:${channel}`
	if (env.BRAIN_KV) {
		const cached = await env.BRAIN_KV.get(cacheKey).catch(() => null)
		if (cached) {
			try {
				const parsed = JSON.parse(cached) as unknown
				if (isRecord(parsed)) return parsed as SlackConversationInfo
			} catch {}
		}
	}

	const info = await getSlackConversationInfo(botToken, channel)
	if (info && env.BRAIN_KV) {
		await env.BRAIN_KV.put(cacheKey, JSON.stringify(info), {
			expirationTtl: SLACK_CONVERSATION_INFO_CACHE_TTL_SECONDS,
		}).catch(() => {})
	}
	return info
}

export async function openSlackConversation(
	botToken: string,
	userId: string,
): Promise<string | undefined> {
	if (!userId) return undefined
	try {
		const res = await fetch(`${SLACK_API}/conversations.open`, {
			method: "POST",
			headers: {
				"content-type": "application/json; charset=utf-8",
				authorization: `Bearer ${botToken}`,
			},
			body: JSON.stringify({ users: userId }),
		})
		const data = (await res.json()) as {
			ok: boolean
			error?: string
			channel?: { id?: string }
		}
		if (!data.ok) {
			console.warn(
				`[slack] conversations.open failed: ${data.error ?? "unknown"} user=${userId}`,
			)
			return undefined
		}
		return data.channel?.id
	} catch (error) {
		console.warn("[slack] conversations.open error:", error)
		return undefined
	}
}

export async function lookupSlackUserByEmail(
	botToken: string,
	email: string,
): Promise<string | undefined> {
	if (!email) return undefined
	try {
		const url = new URL(`${SLACK_API}/users.lookupByEmail`)
		url.searchParams.set("email", email)
		const res = await fetch(url, {
			headers: { authorization: `Bearer ${botToken}` },
		})
		const data = (await res.json()) as {
			ok: boolean
			error?: string
			user?: { id?: string }
		}
		if (!data.ok || !data.user?.id) {
			console.warn(
				`[slack] users.lookupByEmail failed: ${data.error ?? "unknown"}`,
			)
			return undefined
		}
		return data.user.id
	} catch (error) {
		console.warn("[slack] users.lookupByEmail error:", error)
		return undefined
	}
}

export async function setAssistantThreadStatus(
	botToken: string,
	channelId: string,
	threadTs: string,
	status: string,
	loadingMessages?: string[],
): Promise<boolean> {
	if (!channelId || !threadTs) return false
	try {
		const res = await fetch(`${SLACK_API}/assistant.threads.setStatus`, {
			method: "POST",
			headers: {
				"content-type": "application/json; charset=utf-8",
				authorization: `Bearer ${botToken}`,
			},
			body: JSON.stringify({
				channel_id: channelId,
				thread_ts: threadTs,
				status,
				...(loadingMessages?.length
					? { loading_messages: loadingMessages.slice(0, 10) }
					: {}),
			}),
		})
		const data = (await res.json()) as { ok: boolean; error?: string }
		if (!data.ok) {
			console.warn(
				`[slack] assistant.threads.setStatus failed: ${data.error ?? "unknown"}`,
			)
		}
		return data.ok
	} catch (error) {
		console.warn("[slack] assistant.threads.setStatus error:", error)
		return false
	}
}

export async function clearAssistantThreadStatus(
	botToken: string,
	channelId: string,
	threadTs: string,
): Promise<boolean> {
	return setAssistantThreadStatus(botToken, channelId, threadTs, "")
}

export type SlackReactionAddResult =
	| { ok: true; outcome: "added" | "already_present" }
	| { ok: false; error: string; retryAfterSeconds?: number }

export async function addSlackReactionDetailed(
	botToken: string,
	channel: string,
	timestamp: string,
	name: string,
	options?: { quietErrors?: string[] },
): Promise<SlackReactionAddResult> {
	if (!channel || !timestamp) return { ok: false, error: "missing_target" }
	try {
		const res = await fetch(`${SLACK_API}/reactions.add`, {
			method: "POST",
			headers: {
				"content-type": "application/json; charset=utf-8",
				authorization: `Bearer ${botToken}`,
			},
			body: JSON.stringify({ channel, timestamp, name }),
		})
		const data = (await res.json()) as { ok: boolean; error?: string }
		if (data.ok) return { ok: true, outcome: "added" }
		if (data.error === "already_reacted") {
			return { ok: true, outcome: "already_present" }
		}
		if (!data.error || !options?.quietErrors?.includes(data.error)) {
			console.warn(`[slack] reactions.add failed: ${data.error ?? "unknown"}`)
		}
		const retryAfterHeader = res.headers.get("retry-after")
		const retryAfterSeconds = retryAfterHeader
			? Number.parseInt(retryAfterHeader, 10)
			: undefined
		return {
			ok: false,
			error: data.error ?? "unknown",
			...(typeof retryAfterSeconds === "number" && retryAfterSeconds > 0
				? { retryAfterSeconds }
				: {}),
		}
	} catch (error) {
		console.warn("[slack] reactions.add error:", error)
		return { ok: false, error: "request_failed" }
	}
}

export async function addSlackReaction(
	botToken: string,
	channel: string,
	timestamp: string,
	name: string,
	options?: { quietErrors?: string[] },
): Promise<boolean> {
	return (
		await addSlackReactionDetailed(botToken, channel, timestamp, name, options)
	).ok
}

export async function removeSlackReaction(
	botToken: string,
	channel: string,
	timestamp: string,
	name: string,
): Promise<void> {
	if (!channel || !timestamp) return
	try {
		const res = await fetch(`${SLACK_API}/reactions.remove`, {
			method: "POST",
			headers: {
				"content-type": "application/json; charset=utf-8",
				authorization: `Bearer ${botToken}`,
			},
			body: JSON.stringify({ channel, timestamp, name }),
		})
		const data = (await res.json()) as { ok: boolean; error?: string }
		if (!data.ok && data.error !== "no_reaction") {
			console.warn(
				`[slack] reactions.remove failed: ${data.error ?? "unknown"}`,
			)
		}
	} catch (error) {
		console.warn("[slack] reactions.remove error:", error)
	}
}

export async function swapSlackReaction(
	botToken: string,
	channel: string,
	timestamp: string,
	from: string,
	to: string,
): Promise<void> {
	await removeSlackReaction(botToken, channel, timestamp, from)
	await addSlackReaction(botToken, channel, timestamp, to)
}

export type SlackLegacyAttachment = {
	pretext?: string
	title?: string
	title_link?: string
	text?: string
	footer?: string
}

export type SlackThreadMessage = {
	user?: string
	text?: string
	ts?: string
	bot_id?: string
	subtype?: string
	app_id?: string
	thread_ts?: string
	reply_count?: number
	attachments?: SlackLegacyAttachment[]
	reactions?: Array<{
		name?: string
		count?: number
		users?: string[]
	}>
	files?: Array<{
		id: string
		name?: string
		mimetype?: string
		size?: number
		url_private?: string
		url_private_download?: string
	}>
}

export type SlackCursorPage<T> =
	| {
			ok: true
			items: T[]
			nextCursor?: string
			complete: boolean
	  }
	| {
			ok: false
			error: string
			retryAfterSeconds?: number
	  }

function retryAfterSeconds(response: Response): number | undefined {
	if (response.status !== 429) return undefined
	const parsed = Number.parseInt(response.headers.get("retry-after") ?? "", 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

/**
 * One durable-workflow-sized channel-history page. Unlike the interactive
 * thread helpers below, this does not sleep or retry a 429; callers persist
 * their cursor and schedule the next attempt using Slack's Retry-After value.
 */
export async function getSlackChannelHistoryPage(
	botToken: string,
	channel: string,
	opts: {
		oldest: string
		latest: string
		cursor?: string
		limit?: number
	},
): Promise<SlackCursorPage<SlackThreadMessage>> {
	try {
		const url = new URL(`${SLACK_API}/conversations.history`)
		url.searchParams.set("channel", channel)
		url.searchParams.set("oldest", opts.oldest)
		url.searchParams.set("latest", opts.latest)
		url.searchParams.set("inclusive", "true")
		url.searchParams.set("limit", String(Math.min(opts.limit ?? 100, 200)))
		if (opts.cursor) url.searchParams.set("cursor", opts.cursor)
		const response = await fetch(url, {
			headers: { authorization: `Bearer ${botToken}` },
		})
		const data = (await response.json().catch(() => ({}))) as {
			ok?: boolean
			error?: string
			messages?: SlackThreadMessage[]
			has_more?: boolean
			response_metadata?: { next_cursor?: string }
		}
		if (data.ok !== true) {
			return {
				ok: false,
				error: data.error ?? `http_${response.status}`,
				...(retryAfterSeconds(response)
					? { retryAfterSeconds: retryAfterSeconds(response) }
					: {}),
			}
		}
		const nextCursor = data.response_metadata?.next_cursor?.trim() || undefined
		return {
			ok: true,
			items: data.messages ?? [],
			nextCursor,
			complete: !nextCursor || data.has_more === false,
		}
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

/** One cursor page of replies for the durable public-channel backfill. */
export async function getSlackThreadHistoryPage(
	botToken: string,
	channel: string,
	threadTs: string,
	opts: { cursor?: string; limit?: number } = {},
): Promise<SlackCursorPage<SlackThreadMessage>> {
	try {
		const url = new URL(`${SLACK_API}/conversations.replies`)
		url.searchParams.set("channel", channel)
		url.searchParams.set("ts", threadTs)
		url.searchParams.set("limit", String(Math.min(opts.limit ?? 100, 200)))
		if (opts.cursor) url.searchParams.set("cursor", opts.cursor)
		const response = await fetch(url, {
			headers: { authorization: `Bearer ${botToken}` },
		})
		const data = (await response.json().catch(() => ({}))) as {
			ok?: boolean
			error?: string
			messages?: SlackThreadMessage[]
			response_metadata?: { next_cursor?: string }
		}
		if (data.ok !== true) {
			return {
				ok: false,
				error: data.error ?? `http_${response.status}`,
				...(retryAfterSeconds(response)
					? { retryAfterSeconds: retryAfterSeconds(response) }
					: {}),
			}
		}
		const nextCursor = data.response_metadata?.next_cursor?.trim() || undefined
		return {
			ok: true,
			items: data.messages ?? [],
			nextCursor,
			complete: !nextCursor,
		}
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

export type SlackThreadHistory = {
	ok?: boolean
	messages: SlackThreadMessage[]
	complete: boolean
	nextCursor?: string
	error?: string
}

export type SlackThreadHistoryOpts = {
	/** Requested Slack page size. Slack may enforce a smaller workspace/app limit. */
	pageLimit?: number
	/** Hard bound on messages retained across pages. */
	maxMessages?: number
	/** Hard bound on Web API calls for this read. */
	maxPages?: number
	/** Continue a prior bounded read. */
	cursor?: string
	/** Return messages strictly newer than this timestamp. */
	oldest?: string
}

/**
 * Cursor-aware thread read. Callers decide how much history to fetch and how
 * much of it to place in the model prompt; fetching and prompt injection are
 * deliberately separate budgets.
 */
export async function getSlackThreadHistory(
	botToken: string,
	channel: string,
	threadTs: string,
	opts: SlackThreadHistoryOpts = {},
): Promise<SlackThreadHistory> {
	const pageLimit = Math.min(Math.max(opts.pageLimit ?? 200, 1), 200)
	const maxMessages = Math.max(opts.maxMessages ?? pageLimit, 1)
	const maxPages = Math.max(opts.maxPages ?? 1, 1)
	const collected: SlackThreadMessage[] = []
	let cursor = opts.cursor?.trim() || undefined
	let complete = false
	let error: string | undefined
	try {
		for (
			let page = 0;
			page < maxPages && collected.length < maxMessages;
			page++
		) {
			const requestCursor = cursor
			const url = new URL(`${SLACK_API}/conversations.replies`)
			url.searchParams.set("channel", channel)
			url.searchParams.set("ts", threadTs)
			if (opts.oldest) {
				url.searchParams.set("oldest", opts.oldest)
				url.searchParams.set("inclusive", "false")
			}
			url.searchParams.set(
				"limit",
				String(Math.min(pageLimit, maxMessages - collected.length)),
			)
			if (requestCursor) url.searchParams.set("cursor", requestCursor)
			const res = await slackFetchWithRetry(url, botToken)
			const data = (await res.json()) as {
				ok: boolean
				error?: string
				messages?: SlackThreadMessage[]
				has_more?: boolean
				response_metadata?: { next_cursor?: string }
			}
			if (!data.ok) {
				console.warn(
					`[slack] conversations.replies failed: ${data.error ?? "unknown"}`,
				)
				// Preserve the cursor that failed so an on-demand read can retry it.
				cursor = requestCursor
				error = data.error ?? "unknown"
				break
			}
			collected.push(...(data.messages ?? []))
			const nextCursor = data.response_metadata?.next_cursor?.trim()
			if (!nextCursor) {
				cursor = undefined
				complete = true
				break
			}
			cursor = nextCursor
		}
	} catch (error) {
		console.warn("[slack] conversations.replies error:", error)
		return {
			ok: false,
			messages: collected,
			complete: false,
			nextCursor: cursor,
			error: error instanceof Error ? error.message : String(error),
		}
	}

	const seen = new Set<string>()
	const messages = collected.filter((message, index) => {
		const key = message.ts ?? `index:${index}`
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
	if (error) {
		return { ok: false, messages, complete: false, nextCursor: cursor, error }
	}
	return { ok: true, messages, complete, nextCursor: cursor }
}

export async function getSlackThread(
	botToken: string,
	channel: string,
	threadTs: string,
	limit = 30,
): Promise<SlackThreadMessage[]> {
	const history = await getSlackThreadHistory(botToken, channel, threadTs, {
		pageLimit: Math.min(limit, 200),
		maxMessages: limit,
		maxPages: Math.max(1, Math.ceil(limit / 200)),
	})
	return history.messages
}

export type SlackChannelHistoryOpts = {
	oldest?: string
	latest?: string
	inclusive?: boolean
	limit?: number
	maxMessages?: number
	maxPages?: number
}

export type SlackChannelHistoryResult =
	| { ok: true; messages: SlackThreadMessage[]; complete: boolean }
	| {
			ok: false
			messages: SlackThreadMessage[]
			complete: false
			error: string
	  }

async function slackFetchWithRetry(
	url: URL,
	botToken: string,
	maxRetries = 3,
): Promise<Response> {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(url, {
			headers: { authorization: `Bearer ${botToken}` },
		})
		if (res.status !== 429 || attempt >= maxRetries) return res
		const seconds = Number.parseInt(res.headers.get("retry-after") ?? "1", 10)
		const waitMs =
			Math.min(Math.max(Number.isFinite(seconds) ? seconds : 1, 1), 5) * 1000
		await new Promise((resolve) => setTimeout(resolve, waitMs))
	}
}

export async function getSlackChannelHistoryResult(
	botToken: string,
	channel: string,
	opts: SlackChannelHistoryOpts = {},
): Promise<SlackChannelHistoryResult> {
	const pageLimit = opts.limit ?? 80
	const maxMessages = opts.maxMessages ?? pageLimit
	const maxPages = opts.maxPages ?? (opts.maxMessages ? 8 : 1)
	const collected: SlackThreadMessage[] = []
	let cursor: string | undefined
	let complete = false
	try {
		for (
			let page = 0;
			page < maxPages && collected.length < maxMessages;
			page++
		) {
			const url = new URL(`${SLACK_API}/conversations.history`)
			url.searchParams.set("channel", channel)
			url.searchParams.set(
				"limit",
				String(Math.min(pageLimit, maxMessages - collected.length)),
			)
			if (opts.oldest) url.searchParams.set("oldest", opts.oldest)
			if (opts.latest) url.searchParams.set("latest", opts.latest)
			if (opts.oldest || opts.latest) {
				url.searchParams.set("inclusive", String(opts.inclusive ?? false))
			}
			if (cursor) url.searchParams.set("cursor", cursor)
			const res = await slackFetchWithRetry(url, botToken)
			const data = (await res.json()) as {
				ok: boolean
				error?: string
				messages?: SlackThreadMessage[]
				has_more?: boolean
				response_metadata?: { next_cursor?: string }
			}
			if (!data.ok) {
				console.warn(
					`[slack] conversations.history failed: ${data.error ?? "unknown"} channel=${channel}`,
				)
				return {
					messages: collected.reverse(),
					ok: false,
					complete: false,
					error: data.error ?? "unknown",
				}
			}
			collected.push(...(data.messages ?? []))
			cursor = data.response_metadata?.next_cursor?.trim()
			if (!cursor || !data.has_more) {
				complete = true
				break
			}
		}
		return {
			messages: collected.reverse(),
			ok: true,
			complete,
		}
	} catch (error) {
		console.warn("[slack] conversations.history error:", error)
		return {
			messages: collected.reverse(),
			ok: false,
			complete: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

export async function getSlackChannelHistory(
	botToken: string,
	channel: string,
	opts: SlackChannelHistoryOpts = {},
): Promise<SlackChannelHistoryResult> {
	return getSlackChannelHistoryResult(botToken, channel, opts)
}

export type SlackUserInfo = {
	name?: string
	email?: string
	timezone?: string
	tzOffset?: number
	/** Slack login handle (users.list `name`, often lowercase). */
	handle?: string
	displayName?: string
	isBot?: boolean
	/** Single- or multi-channel guest: only sees channels they're added to. */
	isRestricted?: boolean
	/** Single-channel guest, retained separately for explicit eligibility checks. */
	isUltraRestricted?: boolean
	/** Home workspace id — differs from ours for Slack Connect users. */
	teamId?: string
	/** Slack Connect / external user relative to the queried workspace. */
	isStranger?: boolean
}

export type SlackAsker = SlackUserInfo & { slackUserId?: string }

/** This workspace's Company Brain Slack app identity. */
export type SlackBotIdentity = SlackUserInfo & {
	slackUserId: string
	productName: string
}

export function buildSlackBotIdentity(
	slackUserId: string,
	profile: SlackUserInfo = {},
): SlackBotIdentity {
	return {
		slackUserId,
		productName: "Company Brain",
		...profile,
	}
}

type SlackUsersListMember = {
	id?: string
	name?: string
	deleted?: boolean
	is_bot?: boolean
	is_restricted?: boolean
	is_ultra_restricted?: boolean
	is_stranger?: boolean
	team_id?: string
	real_name?: string
	tz?: string
	tz_offset?: number
	profile?: {
		real_name?: string
		display_name?: string
		email?: string
	}
}

function mapSlackMember(m: SlackUsersListMember): SlackMember | null {
	if (m.deleted || !m.id) return null
	const displayName = m.profile?.display_name?.trim()
	const realName = m.real_name || m.profile?.real_name || ""
	const name = realName || displayName || m.name || ""
	if (!name && !m.name) return null
	return {
		id: m.id,
		name: name || m.name || m.id,
		handle: m.name?.trim() || undefined,
		displayName: displayName || undefined,
		email: m.profile?.email,
		isBot: m.is_bot === true,
		isRestricted: m.is_restricted === true,
		isUltraRestricted: m.is_ultra_restricted === true,
		teamId: m.team_id || undefined,
		isStranger: m.is_stranger === true,
	}
}

export type SlackUserInfoLookup =
	| { ok: true; user: SlackUserInfo }
	| {
			ok: false
			reason:
				| "missing_user_id"
				| "user_not_found"
				| "slack_api_error"
				| "profile_unavailable"
			error?: string
			retryAfterSeconds?: number
	  }

function slackUserInfoFromMember(
	user: SlackUsersListMember,
): SlackUserInfo | null {
	const mapped = mapSlackMember(user)
	if (!mapped) return null
	return {
		name: mapped.name,
		email: mapped.email,
		handle: mapped.handle,
		displayName: mapped.displayName,
		isBot: mapped.isBot,
		isRestricted:
			user.is_restricted === true || user.is_ultra_restricted === true,
		isUltraRestricted: user.is_ultra_restricted === true,
		teamId: user.team_id || undefined,
		isStranger: user.is_stranger === true,
		timezone: user.tz?.trim() || undefined,
		tzOffset: typeof user.tz_offset === "number" ? user.tz_offset : undefined,
	}
}

export async function lookupSlackUserInfo(
	botToken: string,
	userId: string,
): Promise<SlackUserInfoLookup> {
	if (!userId) return { ok: false, reason: "missing_user_id" }
	try {
		const url = new URL(`${SLACK_API}/users.info`)
		url.searchParams.set("user", userId)
		const res = await fetch(url, {
			headers: { authorization: `Bearer ${botToken}` },
		})
		const data = (await res.json()) as {
			ok: boolean
			user?: SlackUsersListMember
			error?: string
		}
		if (!data.ok) {
			if (data.error === "user_not_found") {
				return {
					ok: false,
					reason: "user_not_found",
					error: data.error,
				}
			}
			return {
				ok: false,
				reason: "slack_api_error",
				error: data.error ?? `http_${res.status}`,
				...(retryAfterSeconds(res)
					? { retryAfterSeconds: retryAfterSeconds(res) }
					: {}),
			}
		}
		if (!data.user) return { ok: false, reason: "profile_unavailable" }
		const user = slackUserInfoFromMember(data.user)
		if (!user) return { ok: false, reason: "profile_unavailable" }
		return { ok: true, user }
	} catch (error) {
		return {
			ok: false,
			reason: "slack_api_error",
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

export async function getSlackUserInfo(
	botToken: string,
	userId: string,
): Promise<SlackUserInfo> {
	const lookup = await lookupSlackUserInfo(botToken, userId)
	if (lookup.ok) return lookup.user
	if (lookup.reason === "slack_api_error") {
		console.warn(
			`[slack] users.info error user=${userId || "?"}: ${lookup.error ?? "unknown"}`,
		)
	}
	return {}
}

export type SlackMember = {
	id: string
	name: string
	handle?: string
	displayName?: string
	email?: string
	isBot?: boolean
	isRestricted?: boolean
	isUltraRestricted?: boolean
	teamId?: string
	isStranger?: boolean
}

/** One users.list page for Durable Object workflows. */
export async function listSlackUsersPage(
	botToken: string,
	opts: { cursor?: string; limit?: number } = {},
): Promise<SlackCursorPage<SlackMember>> {
	try {
		const url = new URL(`${SLACK_API}/users.list`)
		url.searchParams.set("limit", String(Math.min(opts.limit ?? 200, 200)))
		if (opts.cursor) url.searchParams.set("cursor", opts.cursor)
		const response = await fetch(url, {
			headers: { authorization: `Bearer ${botToken}` },
		})
		const data = (await response.json().catch(() => ({}))) as {
			ok?: boolean
			error?: string
			members?: SlackUsersListMember[]
			response_metadata?: { next_cursor?: string }
		}
		if (data.ok !== true) {
			return {
				ok: false,
				error: data.error ?? `http_${response.status}`,
				...(retryAfterSeconds(response)
					? { retryAfterSeconds: retryAfterSeconds(response) }
					: {}),
			}
		}
		const items = (data.members ?? []).flatMap((member) => {
			const mapped = mapSlackMember(member)
			return mapped ? [mapped] : []
		})
		const nextCursor = data.response_metadata?.next_cursor?.trim() || undefined
		return { ok: true, items, nextCursor, complete: !nextCursor }
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

export async function getSlackTeamDirectory(
	botToken: string,
	maxMembers = 1000,
): Promise<SlackMember[]> {
	const out: SlackMember[] = []
	let cursor: string | undefined
	try {
		while (out.length < maxMembers) {
			const url = new URL(`${SLACK_API}/users.list`)
			url.searchParams.set("limit", "200")
			if (cursor) url.searchParams.set("cursor", cursor)
			const res = await fetch(url, {
				headers: { authorization: `Bearer ${botToken}` },
			})
			const data = (await res.json()) as {
				ok: boolean
				members?: SlackUsersListMember[]
				response_metadata?: { next_cursor?: string }
			}
			if (!data.ok || !data.members?.length) break
			for (const member of data.members) {
				const mapped = mapSlackMember(member)
				if (mapped) out.push(mapped)
				if (out.length >= maxMembers) break
			}
			cursor = data.response_metadata?.next_cursor?.trim()
			if (!cursor) break
		}
		return out
	} catch (error) {
		console.warn("[slack] users.list error:", error)
		return out
	}
}

export type SlackUserGroup = {
	id: string
	handle: string
	name: string
	userIds: string[]
}

export async function getSlackUserGroups(
	botToken: string,
): Promise<SlackUserGroup[]> {
	try {
		const url = new URL(`${SLACK_API}/usergroups.list`)
		url.searchParams.set("include_users", "true")
		url.searchParams.set("include_disabled", "false")
		const res = await fetch(url, {
			headers: { authorization: `Bearer ${botToken}` },
		})
		const data = (await res.json()) as {
			ok: boolean
			error?: string
			usergroups?: Array<{
				id?: string
				handle?: string
				name?: string
				users?: string[]
			}>
		}
		if (!data.ok || !data.usergroups?.length) {
			if (data.error) console.warn(`[slack] usergroups.list: ${data.error}`)
			return []
		}
		return data.usergroups.flatMap((g) =>
			g.id
				? [
						{
							id: g.id,
							handle: g.handle ?? g.name ?? g.id,
							name: g.name ?? g.handle ?? g.id,
							userIds: Array.isArray(g.users) ? g.users : [],
						},
					]
				: [],
		)
	} catch (error) {
		console.warn("[slack] usergroups.list error:", error)
		return []
	}
}

export type SlackConversation = {
	id: string
	name: string
	isPrivate: boolean
}

export type SlackPublicChannel = {
	id: string
	name: string
	topic?: string
	purpose?: string
	isMember: boolean
	isArchived: boolean
	isGeneral: boolean
	/** Slack Connect / externally shared channel. */
	isExternal: boolean
	memberCount?: number
}

/** One page of every public channel visible to the app. */
export async function listSlackPublicChannelsPage(
	botToken: string,
	opts: { cursor?: string; limit?: number } = {},
): Promise<SlackCursorPage<SlackPublicChannel>> {
	try {
		const url = new URL(`${SLACK_API}/conversations.list`)
		url.searchParams.set("types", "public_channel")
		url.searchParams.set("exclude_archived", "false")
		// Slack omits num_members unless asked; the beachhead ranks on it.
		url.searchParams.set("include_num_members", "true")
		url.searchParams.set("limit", String(Math.min(opts.limit ?? 200, 200)))
		if (opts.cursor) url.searchParams.set("cursor", opts.cursor)
		const response = await fetch(url, {
			headers: { authorization: `Bearer ${botToken}` },
		})
		const data = (await response.json().catch(() => ({}))) as {
			ok?: boolean
			error?: string
			channels?: Array<{
				id?: string
				name?: string
				topic?: { value?: string }
				purpose?: { value?: string }
				is_member?: boolean
				is_archived?: boolean
				is_general?: boolean
				is_ext_shared?: boolean
				is_pending_ext_shared?: boolean
				is_shared?: boolean
				is_org_shared?: boolean
				num_members?: number
			}>
			response_metadata?: { next_cursor?: string }
		}
		if (data.ok !== true) {
			return {
				ok: false,
				error: data.error ?? `http_${response.status}`,
				...(retryAfterSeconds(response)
					? { retryAfterSeconds: retryAfterSeconds(response) }
					: {}),
			}
		}
		const items = (data.channels ?? []).flatMap((channel) => {
			if (!channel.id || !channel.name) return []
			return [
				{
					id: channel.id,
					name: channel.name,
					topic: channel.topic?.value?.trim() || undefined,
					purpose: channel.purpose?.value?.trim() || undefined,
					isMember: channel.is_member === true,
					isArchived: channel.is_archived === true,
					isGeneral: channel.is_general === true,
					isExternal:
						channel.is_ext_shared === true ||
						channel.is_pending_ext_shared === true ||
						(channel.is_shared === true && channel.is_org_shared !== true),
					memberCount:
						typeof channel.num_members === "number"
							? channel.num_members
							: undefined,
				},
			]
		})
		const nextCursor = data.response_metadata?.next_cursor?.trim() || undefined
		return { ok: true, items, nextCursor, complete: !nextCursor }
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

export type SlackJoinResult =
	| { ok: true; alreadyMember: boolean }
	| { ok: false; error: string; retryAfterSeconds?: number }

/** Join one public channel without hiding Slack's rate-limit signal. */
export async function joinSlackPublicChannel(
	botToken: string,
	channel: string,
): Promise<SlackJoinResult> {
	try {
		const response = await fetch(`${SLACK_API}/conversations.join`, {
			method: "POST",
			headers: {
				"content-type": "application/json; charset=utf-8",
				authorization: `Bearer ${botToken}`,
			},
			body: JSON.stringify({ channel }),
		})
		const data = (await response.json().catch(() => ({}))) as {
			ok?: boolean
			error?: string
		}
		if (data.ok === true) return { ok: true, alreadyMember: false }
		if (data.error === "already_in_channel") {
			return { ok: true, alreadyMember: true }
		}
		return {
			ok: false,
			error: data.error ?? `http_${response.status}`,
			...(retryAfterSeconds(response)
				? { retryAfterSeconds: retryAfterSeconds(response) }
				: {}),
		}
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

export async function getBotConversations(
	botToken: string,
	maxChannels = 1000,
	requireComplete = false,
): Promise<SlackConversation[]> {
	const out: SlackConversation[] = []
	let cursor: string | undefined
	try {
		while (out.length < maxChannels) {
			const url = new URL(`${SLACK_API}/users.conversations`)
			url.searchParams.set("types", "public_channel,private_channel")
			url.searchParams.set("exclude_archived", "true")
			url.searchParams.set("limit", "200")
			if (cursor) url.searchParams.set("cursor", cursor)
			const res = await slackFetchWithRetry(url, botToken)
			const data = (await res.json()) as {
				ok: boolean
				error?: string
				channels?: Array<{ id?: string; name?: string; is_private?: boolean }>
				response_metadata?: { next_cursor?: string }
			}
			if (!data.ok) {
				if (requireComplete) {
					throw new Error(data.error ?? `http_${res.status}`)
				}
				console.warn(
					`[slack] users.conversations failed: ${data.error ?? "unknown"}`,
				)
				break
			}
			for (const ch of data.channels ?? []) {
				if (ch.id && ch.name) {
					out.push({
						id: ch.id,
						name: ch.name,
						isPrivate: Boolean(ch.is_private),
					})
				}
				if (out.length >= maxChannels) break
			}
			cursor = data.response_metadata?.next_cursor?.trim()
			if (!cursor) break
		}
		if (requireComplete && (cursor || out.length >= maxChannels)) {
			throw new Error("Slack channel lookup incomplete")
		}
		return out
	} catch (error) {
		console.warn("[slack] users.conversations error:", error)
		if (requireComplete) throw error
		return out
	}
}

export async function getConversationMembers(
	botToken: string,
	channel: string,
	maxMembers = 1000,
): Promise<string[]> {
	const out: string[] = []
	let cursor: string | undefined
	try {
		while (out.length < maxMembers) {
			const url = new URL(`${SLACK_API}/conversations.members`)
			url.searchParams.set("channel", channel)
			url.searchParams.set("limit", "200")
			if (cursor) url.searchParams.set("cursor", cursor)
			const res = await slackFetchWithRetry(url, botToken)
			const data = (await res.json()) as {
				ok: boolean
				error?: string
				members?: string[]
				response_metadata?: { next_cursor?: string }
			}
			if (!data.ok) {
				console.warn(
					`[slack] conversations.members failed: ${data.error ?? "unknown"} channel=${channel}`,
				)
				break
			}
			for (const id of data.members ?? []) {
				out.push(id)
				if (out.length >= maxMembers) break
			}
			cursor = data.response_metadata?.next_cursor?.trim()
			if (!cursor) break
		}
		return out
	} catch (error) {
		console.warn("[slack] conversations.members error:", error)
		return out
	}
}

export type SlackOAuthResult = {
	teamId: string
	teamName?: string
	botUserId?: string
	botToken: string
	appId?: string
	scopes?: string
	authedUserId?: string
}
/** Dead beyond recovery, so skip the auth.revoke retry. `invalid_auth` can mean IP restrictions. */
const SLACK_DEAD_TOKEN_ERRORS: ReadonlySet<string> = new Set([
	"token_revoked",
	"token_expired",
	"account_inactive",
])

const SLACK_RETRYABLE_ERRORS: ReadonlySet<string> = new Set([
	"ratelimited",
	"internal_error",
	"service_unavailable",
	"fatal_error",
	"request_timeout",
])

/**
 * `transient` means Slack never gave a verdict, so the caller must keep the token
 * and retry; `terminal` means the install is beyond our reach either way.
 */
export type SlackUninstallOutcome = "revoked" | "terminal" | "transient"

export async function uninstallSlackApp(
	botToken: string,
	env: Env,
): Promise<SlackUninstallOutcome> {
	try {
		const res = await fetch(`${SLACK_API}/apps.uninstall`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${botToken}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				client_id: (await slackCredentials(env))?.clientId ?? "",
				client_secret: (await slackCredentials(env))?.clientSecret ?? "",
			}),
		})
		if (!res.ok) return "transient"
		const data = (await res.json()) as { ok?: boolean; error?: string }
		if (data.ok) return "revoked"
		const error = data.error ?? "unknown"
		console.warn(`[slack] apps.uninstall failed: ${error}`)
		if (SLACK_DEAD_TOKEN_ERRORS.has(error)) return "terminal"
		if (SLACK_RETRYABLE_ERRORS.has(error)) return "transient"
	} catch (error) {
		console.warn(
			"[slack] apps.uninstall error:",
			error instanceof Error ? error.message : error,
		)
		return "transient"
	}
	return await revokeSlackToken(botToken)
}

async function revokeSlackToken(
	botToken: string,
): Promise<SlackUninstallOutcome> {
	try {
		const res = await fetch(`${SLACK_API}/auth.revoke`, {
			method: "POST",
			headers: { Authorization: `Bearer ${botToken}` },
		})
		if (!res.ok) return "transient"
		const data = (await res.json()) as { ok?: boolean; error?: string }
		if (data.ok) return "revoked"
		const error = data.error ?? "unknown"
		console.warn(`[slack] auth.revoke failed: ${error}`)
		return SLACK_RETRYABLE_ERRORS.has(error) ? "transient" : "terminal"
	} catch (error) {
		console.warn(
			"[slack] auth.revoke error:",
			error instanceof Error ? error.message : error,
		)
		return "transient"
	}
}

export async function exchangeSlackOAuth(
	env: Env,
	code: string,
	redirectUri: string,
): Promise<SlackOAuthResult> {
	const credentials = await slackCredentials(env)
	if (!credentials) {
		throw new Error("Slack is not configured — finish setup at /setup")
	}
	const body = new URLSearchParams({
		client_id: credentials.clientId,
		client_secret: credentials.clientSecret,
		code,
		redirect_uri: redirectUri,
	})
	const res = await fetch(`${SLACK_API}/oauth.v2.access`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body,
	})
	const data = (await res.json()) as {
		ok: boolean
		error?: string
		access_token?: string
		bot_user_id?: string
		app_id?: string
		scope?: string
		team?: { id: string; name?: string }
		authed_user?: { id?: string }
	}
	if (!data.ok || !data.access_token || !data.team?.id) {
		throw new Error(`slack oauth.v2.access failed: ${data.error ?? "unknown"}`)
	}
	return {
		teamId: data.team.id,
		teamName: data.team.name,
		botUserId: data.bot_user_id,
		botToken: data.access_token,
		appId: data.app_id,
		scopes: data.scope,
		authedUserId: data.authed_user?.id,
	}
}
