import type { FilePart, ImagePart, TextPart, UserContent } from "ai"
import type { SlackThreadMessage } from "./client"

export type SlackFileRef = {
	id: string
	name: string
	mimetype?: string
	size?: number
	url_private?: string
	url_private_download?: string
}

export const MAX_THREAD_ATTACHMENTS = 5
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

const IMAGE_MEDIA_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
])

function trimmedString(value: unknown): string {
	return typeof value === "string" ? value.trim() : ""
}

function validHttpUrl(value: unknown): string | undefined {
	const trimmed = trimmedString(value)
	if (!trimmed) return undefined
	for (const char of trimmed) {
		const code = char.charCodeAt(0)
		if (
			code <= 31 ||
			code === 127 ||
			char === "<" ||
			char === ">" ||
			char === "|"
		) {
			return undefined
		}
	}
	try {
		const url = new URL(trimmed)
		return url.protocol === "http:" || url.protocol === "https:"
			? url.href
			: undefined
	} catch {
		return undefined
	}
}

function exactSlackHttpLink(value: string): boolean {
	const match = value.match(/^<([^|>]+)(?:\|[^>]*)?>$/)
	return Boolean(match?.[1] && validHttpUrl(match[1]))
}

export function normalizeSlackMessageContent(
	message: SlackThreadMessage,
): string {
	const segments: string[] = []
	const text = trimmedString(message.text)
	if (text) segments.push(text)

	if (Array.isArray(message.attachments)) {
		for (const attachment of message.attachments) {
			if (!attachment || typeof attachment !== "object") continue
			const title = trimmedString(attachment.title)
			const titleLink = validHttpUrl(attachment.title_link)
			const pretext = trimmedString(attachment.pretext)
			const body = trimmedString(attachment.text)
			const footer = trimmedString(attachment.footer)
			if (pretext) segments.push(pretext)
			if (title) segments.push(title)
			// Exact whole-string Slack HTTP(S) titles already carry their URL;
			// only then ignore title_link (including when the two conflict).
			if (titleLink && !exactSlackHttpLink(title)) {
				segments.push(`<${titleLink}>`)
			}
			if (body) segments.push(body)
			if (footer) segments.push(footer)
		}
	}

	return segments.join("\n")
}

export function slackFilesFromMessage(
	message: SlackThreadMessage,
): SlackFileRef[] {
	const files = message.files
	if (!Array.isArray(files)) return []
	const out: SlackFileRef[] = []
	for (const file of files) {
		if (!file?.id || !file.name) continue
		out.push({
			id: file.id,
			name: file.name,
			mimetype: file.mimetype,
			size: file.size,
			url_private: file.url_private,
			url_private_download: file.url_private_download,
		})
	}
	return out
}

export function collectThreadFiles(
	messages: ReadonlyArray<SlackThreadMessage>,
): SlackFileRef[] {
	const seen = new Set<string>()
	const out: SlackFileRef[] = []
	for (const message of messages) {
		for (const file of slackFilesFromMessage(message)) {
			if (seen.has(file.id)) continue
			seen.add(file.id)
			out.push(file)
		}
	}
	return out.slice(-MAX_THREAD_ATTACHMENTS)
}

/** Merge thread history with the triggering Slack event (top-level @mentions). */
export function collectTurnFiles(
	messages: ReadonlyArray<SlackThreadMessage>,
	trigger?: SlackThreadMessage,
): SlackFileRef[] {
	if (!trigger) return collectThreadFiles(messages)
	return collectThreadFiles([...messages, trigger])
}

export function isModelReadableSlackFile(file: SlackFileRef): boolean {
	const mediaType = (file.mimetype ?? "").toLowerCase()
	if (!mediaType) return false
	return IMAGE_MEDIA_TYPES.has(mediaType) || mediaType === "application/pdf"
}

export function formatMessageAttachmentHint(
	files: ReadonlyArray<SlackFileRef> | undefined,
): string {
	if (!files?.length) return ""
	const labels = files.map((f) => {
		const type = f.mimetype ?? "unknown"
		const readable = isModelReadableSlackFile(f) ? "" : ", not sent to model"
		return `${f.name} (${type}${readable})`
	})
	return `[attachments: ${labels.join("; ")}]`
}

const SLACK_API = "https://slack.com/api"

function downloadUrl(file: SlackFileRef): string | undefined {
	return file.url_private_download ?? file.url_private
}

async function resolveSlackFileDownloadUrl(
	botToken: string,
	file: SlackFileRef,
): Promise<string | undefined> {
	const direct = downloadUrl(file)
	if (direct) return direct
	if (!file.id) return undefined
	try {
		const url = new URL(`${SLACK_API}/files.info`)
		url.searchParams.set("file", file.id)
		const res = await fetch(url, {
			headers: { authorization: `Bearer ${botToken}` },
		})
		const data = (await res.json()) as {
			ok: boolean
			file?: {
				url_private_download?: string
				url_private?: string
			}
		}
		if (!data.ok || !data.file) return undefined
		return data.file.url_private_download ?? data.file.url_private
	} catch (err) {
		console.warn(`[slack] files.info failed for ${file.id}:`, err)
		return undefined
	}
}

export async function downloadSlackFile(
	botToken: string,
	file: SlackFileRef,
): Promise<Uint8Array | null> {
	const url = await resolveSlackFileDownloadUrl(botToken, file)
	if (!url) return null
	if (typeof file.size === "number" && file.size > MAX_ATTACHMENT_BYTES) {
		console.warn(
			`[slack] skip attachment ${file.name}: size ${file.size} exceeds limit`,
		)
		return null
	}
	try {
		const res = await fetch(url, {
			headers: { authorization: `Bearer ${botToken}` },
			redirect: "follow",
		})
		if (!res.ok) {
			console.warn(
				`[slack] attachment download failed ${file.name}: HTTP ${res.status}`,
			)
			return null
		}
		const buf = new Uint8Array(await res.arrayBuffer())
		if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
			console.warn(
				`[slack] skip attachment ${file.name}: downloaded ${buf.byteLength} bytes exceeds limit`,
			)
			return null
		}
		return buf
	} catch (err) {
		console.warn(`[slack] attachment download error ${file.name}:`, err)
		return null
	}
}

export type ThreadAttachmentPart = ImagePart | FilePart

export async function loadThreadAttachmentParts(
	botToken: string,
	files: ReadonlyArray<SlackFileRef>,
): Promise<ThreadAttachmentPart[]> {
	const parts: ThreadAttachmentPart[] = []
	for (const file of files) {
		if (!isModelReadableSlackFile(file)) continue
		const data = await downloadSlackFile(botToken, file)
		if (!data) continue
		const mediaType = (file.mimetype ?? "").toLowerCase()
		if (IMAGE_MEDIA_TYPES.has(mediaType)) {
			parts.push({
				type: "image",
				image: data,
				mediaType,
			})
			continue
		}
		if (mediaType === "application/pdf") {
			parts.push({
				type: "file",
				data,
				mediaType: "application/pdf",
				filename: file.name,
			})
		}
	}
	return parts
}

export function buildTurnUserContent(
	textPrompt: string,
	attachmentParts: ReadonlyArray<ThreadAttachmentPart>,
): UserContent {
	if (!attachmentParts.length) return textPrompt
	const textParts: TextPart[] = [
		{
			type: "text",
			text: `${textPrompt}\n\n<slack_attachments>\n${attachmentParts.length} image/PDF file(s) from this Slack thread are attached below for direct inspection. Use their content when answering — especially screenshots shared earlier in the thread.\n</slack_attachments>`,
		},
	]
	return [...textParts, ...attachmentParts]
}
