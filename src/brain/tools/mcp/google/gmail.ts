import type { ProviderTool, ToolProviderHandle } from "../provider"
import type { McpConnectionRow } from "../store"
import { GmailApiError, gmailApiRequest, isGmailQuotaError } from "./api"
import { GMAIL_SEND_ENABLED } from "./scopes"

const MAX_RESULTS = 50
const MAX_BODY_CHARS = 100_000
const MAX_TOTAL_RECIPIENTS = 50
const MAX_ID_CHARS = 200
const MAX_QUERY_CHARS = 500
const MAX_PAGE_TOKEN_CHARS = 500
const MAX_SUBJECT_CHARS = 998
const MAX_ATTACHMENT_ID_CHARS = 2_000
const MAX_EXTERNAL_BODY_BYTES = 1_000_000
const MAX_EXTERNAL_BODY_RESPONSE_BYTES = 1_400_000
const MESSAGE_FIELDS =
	"id,threadId,labelIds,snippet,internalDate,payload(mimeType,filename,headers,body(data,attachmentId,size),parts(mimeType,filename,headers,body(data,attachmentId,size),parts(mimeType,filename,headers,body(data,attachmentId,size))))"

type GmailHeader = { name?: string; value?: string }
type GmailPart = {
	mimeType?: string
	filename?: string
	headers?: GmailHeader[]
	body?: { data?: string; attachmentId?: string; size?: number }
	parts?: GmailPart[]
}
type GmailMessage = {
	id?: string
	threadId?: string
	labelIds?: string[]
	snippet?: string
	internalDate?: string
	payload?: GmailPart
}

type GmailSendInput = {
	to: string[]
	cc?: string[]
	subject: string
	text?: string
	html?: string
}

function decodeBase64Url(data: string, maxChars = MAX_BODY_CHARS): string {
	const maxEncodedChars = Math.ceil((maxChars * 4) / 3 / 4) * 4
	const normalized = data
		.slice(0, maxEncodedChars)
		.replace(/-/g, "+")
		.replace(/_/g, "/")
	const binary = atob(normalized)
	return new TextDecoder()
		.decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
		.slice(0, maxChars)
}

function encodeBase64Url(value: string): string {
	const bytes = new TextEncoder().encode(value)
	let binary = ""
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function header(part: GmailPart | undefined, name: string): string | undefined {
	return part?.headers?.find((item) => item.name?.toLowerCase() === name)?.value
}

type GmailBodyContent = {
	mimeType?: string
	body: string
	bodyOmittedReason?: string
}

function preferredBodyPart(part: GmailPart | undefined): GmailPart | undefined {
	if (!part) return undefined
	const candidates = [...walkParts(part)].filter(
		(candidate) => !candidate.filename?.trim(),
	)
	for (const mimeType of ["text/plain", "text/html"]) {
		const candidate = candidates.find((item) => item.mimeType === mimeType)
		if (candidate) return candidate
	}
}

async function messageBody(
	part: GmailPart | undefined,
	maxChars: number,
	loadExternalBody?: (attachmentId: string) => Promise<string | undefined>,
): Promise<GmailBodyContent> {
	const candidate = preferredBodyPart(part)
	if (!candidate) return { body: "" }
	if (candidate.body?.data) {
		return {
			mimeType: candidate.mimeType,
			body: decodeBase64Url(candidate.body.data, maxChars),
		}
	}
	const attachmentId = candidate.body?.attachmentId
	if (!attachmentId || !loadExternalBody) return { body: "" }
	if ((candidate.body?.size ?? 0) > MAX_EXTERNAL_BODY_BYTES) {
		return {
			mimeType: candidate.mimeType,
			body: "",
			bodyOmittedReason: `message body exceeds ${MAX_EXTERNAL_BODY_BYTES} byte read limit`,
		}
	}
	const data = await loadExternalBody(attachmentId)
	if (!data) {
		return {
			mimeType: candidate.mimeType,
			body: "",
			bodyOmittedReason: "external message body was unavailable",
		}
	}
	return {
		mimeType: candidate.mimeType,
		body: decodeBase64Url(data, maxChars),
	}
}

function* walkParts(part: GmailPart): Generator<GmailPart> {
	yield part
	for (const child of part.parts ?? []) yield* walkParts(child)
}

async function summarizeMessage(
	message: GmailMessage,
	bodyLimit = MAX_BODY_CHARS,
	loadExternalBody?: (attachmentId: string) => Promise<string | undefined>,
) {
	const content = await messageBody(
		message.payload,
		bodyLimit,
		loadExternalBody,
	)
	return {
		id: message.id,
		threadId: message.threadId,
		labelIds: message.labelIds ?? [],
		snippet: message.snippet?.slice(0, 2_000),
		date: header(message.payload, "date"),
		from: header(message.payload, "from"),
		to: header(message.payload, "to"),
		cc: header(message.payload, "cc"),
		subject: header(message.payload, "subject"),
		mimeType: content.mimeType,
		body: content.body.slice(0, bodyLimit),
		...(content.bodyOmittedReason
			? { bodyOmittedReason: content.bodyOmittedReason }
			: {}),
	}
}

function requiredString(
	args: Record<string, unknown>,
	key: string,
	maxChars: number,
): string {
	const value = args[key]
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${key} is required`)
	const trimmed = value.trim()
	if (trimmed.length > maxChars)
		throw new Error(`${key} exceeds ${maxChars} characters`)
	return trimmed
}

function recipients(value: unknown, key: string, required = false): string[] {
	if (value !== undefined && !Array.isArray(value)) {
		throw new Error(`${key} must be an array with one mailbox per entry`)
	}
	const values = Array.isArray(value) ? value : []
	const clean = values.map((item) => {
		if (typeof item !== "string" || !item.trim()) {
			throw new Error(`${key} contains an invalid mailbox`)
		}
		return mailbox(item.trim(), key)
	})
	if (required && clean.length === 0)
		throw new Error(`${key} requires at least one recipient`)
	return clean
}

function headerSafe(value: string, key: string): string {
	if (/\r|\n/.test(value)) throw new Error(`${key} cannot contain newlines`)
	return value
}

function mailbox(value: string, key: string): string {
	headerSafe(value, key)
	if (value.includes(",") || value.includes(";")) {
		throw new Error(`${key} requires one mailbox per entry`)
	}
	const plain = value.match(/^([^<>\s]+@[^<>\s]+)$/)?.[1]
	const named = value.match(/^[^<>]+\s+<([^<>\s]+@[^<>\s]+)>$/)?.[1]
	const address = plain ?? named
	if (!address || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
		throw new Error(`${key} contains an invalid mailbox`)
	}
	return value
}

function gmailId(args: Record<string, unknown>, key: string): string {
	const value = requiredString(args, key, MAX_ID_CHARS)
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${key} is invalid`)
	return value
}

function gmailAttachmentId(value: string): string {
	if (!value || value.length > MAX_ATTACHMENT_ID_CHARS) {
		throw new Error("attachmentId is invalid")
	}
	if (!/^[A-Za-z0-9_-]+$/.test(value)) {
		throw new Error("attachmentId is invalid")
	}
	return value
}

export function gmailAuthTransition(
	error: GmailApiError,
): "grant_error" | "binding_error" | undefined {
	if (error.status === 401) return "grant_error"
	if (error.status !== 403) return
	if (isGmailQuotaError(error)) return
	const permissionReasons = new Set([
		"access_token_scope_insufficient",
		"insufficientpermissions",
	])
	if (
		error.reasons.some((reason) => permissionReasons.has(reason.toLowerCase()))
	) {
		return "binding_error"
	}
}

function normalizeGmailSendInput(
	args: Record<string, unknown>,
): GmailSendInput {
	const allowedKeys = new Set(["to", "cc", "subject", "text", "html", "body"])
	const unsupported = Object.keys(args).filter((key) => !allowedKeys.has(key))
	if (unsupported.length) {
		throw new Error(
			`unsupported email argument${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}`,
		)
	}
	const to = recipients(args.to, "to", true)
	const cc = recipients(args.cc, "cc")
	if (to.length + cc.length > MAX_TOTAL_RECIPIENTS) {
		throw new Error(
			`email supports at most ${MAX_TOTAL_RECIPIENTS} total recipients`,
		)
	}
	const subject = headerSafe(
		requiredString(args, "subject", MAX_SUBJECT_CHARS),
		"subject",
	)
	if (args.text !== undefined && typeof args.text !== "string") {
		throw new Error("text must be a string")
	}
	if (args.html !== undefined && typeof args.html !== "string") {
		throw new Error("html must be a string")
	}
	let text = args.text as string | undefined
	const html = args.html as string | undefined
	if (args.body !== undefined) {
		if (typeof args.body !== "string") throw new Error("body must be a string")
		if (text !== undefined || html !== undefined) {
			throw new Error("provide exactly one of body, text, or html")
		}
		text = args.body
	}
	if (
		(!text?.trim() && !html?.trim()) ||
		(text !== undefined && html !== undefined)
	) {
		throw new Error("provide exactly one of text or html")
	}
	if ((text ?? html ?? "").length > MAX_BODY_CHARS) {
		throw new Error(`message body exceeds ${MAX_BODY_CHARS} characters`)
	}
	return {
		to,
		...(cc.length ? { cc } : {}),
		subject,
		...(html !== undefined ? { html } : { text }),
	}
}

function buildRawEmail(args: Record<string, unknown>): string {
	const { to, cc = [], subject, text, html } = normalizeGmailSendInput(args)
	const lines = [
		`To: ${to.join(", ")}`,
		...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
		`Subject: ${subject}`,
		"MIME-Version: 1.0",
		`Content-Type: ${html ? "text/html" : "text/plain"}; charset=UTF-8`,
		"Content-Transfer-Encoding: 8bit",
		"",
		html ?? text ?? "",
	]
	return encodeBase64Url(lines.join("\r\n"))
}

export const GMAIL_TOOLS: ProviderTool[] = [
	{
		name: "search_messages",
		description: "Search Gmail messages using Gmail query syntax.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", minLength: 1, maxLength: 500 },
				maxResults: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
				pageToken: { type: "string", maxLength: 500 },
			},
			required: ["query"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, destructiveHint: false },
	},
	{
		name: "get_message",
		description:
			"Get one Gmail message with headers and a bounded decoded body.",
		inputSchema: {
			type: "object",
			properties: {
				messageId: { type: "string", minLength: 1, maxLength: 200 },
			},
			required: ["messageId"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, destructiveHint: false },
	},
	{
		name: "get_thread",
		description: "Get the ordered messages in a Gmail thread.",
		inputSchema: {
			type: "object",
			properties: {
				threadId: { type: "string", minLength: 1, maxLength: 200 },
			},
			required: ["threadId"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, destructiveHint: false },
	},
	{
		name: "send_email",
		description:
			"Send an email after requester approval. Provide exactly one non-empty body field: text for plain text (preferred) or html for HTML.",
		inputSchema: {
			type: "object",
			properties: {
				to: {
					type: "array",
					items: { type: "string" },
					minItems: 1,
					maxItems: 50,
				},
				cc: { type: "array", items: { type: "string" }, maxItems: 50 },
				subject: { type: "string", minLength: 1, maxLength: 998 },
				text: {
					type: "string",
					minLength: 1,
					maxLength: MAX_BODY_CHARS,
					description:
						"Plain-text email body. Required unless html is provided.",
				},
				html: {
					type: "string",
					minLength: 1,
					maxLength: MAX_BODY_CHARS,
					description: "HTML email body. Required unless text is provided.",
				},
			},
			required: ["to", "subject"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: false, destructiveHint: true },
		normalizeInput: normalizeGmailSendInput,
	},
]

export async function connectGmailProvider(
	env: Env,
	connection: McpConnectionRow,
): Promise<ToolProviderHandle> {
	if (!connection.googleWorkspaceGrantId)
		throw new Error("Gmail grant is missing")
	const grantId = connection.googleWorkspaceGrantId
	let terminalAuthError: Error | undefined
	async function accessToken(): Promise<string> {
		const { getFreshGoogleAccessToken, GoogleGrantReconnectRequiredError } =
			await import("./grant-store")
		try {
			return await getFreshGoogleAccessToken(env, grantId)
		} catch (error) {
			if (error instanceof GoogleGrantReconnectRequiredError) {
				const { McpReauthRequiredError } = await import("../oauth-provider")
				throw new McpReauthRequiredError("gmail")
			}
			throw error
		}
	}
	const callApi = async <T>(args: Parameters<typeof gmailApiRequest<T>>[0]) => {
		if (terminalAuthError) throw terminalAuthError
		try {
			return await gmailApiRequest<T>(args)
		} catch (error) {
			if (!(error instanceof GmailApiError)) {
				throw error
			}
			const transition = gmailAuthTransition(error)
			if (!transition) throw error
			const { markGoogleBindingError, markGoogleGrantError } = await import(
				"./grant-store"
			)
			const { McpReauthRequiredError } = await import("../oauth-provider")
			if (transition === "grant_error") {
				await markGoogleGrantError(
					env,
					grantId,
					"Google authorization rejected",
				)
			} else {
				await markGoogleBindingError(
					env,
					grantId,
					"missing required Gmail scopes",
				)
			}
			terminalAuthError = new McpReauthRequiredError("gmail")
			throw terminalAuthError
		}
	}
	await accessToken()
	return {
		listTools: async () =>
			GMAIL_TOOLS.filter(
				(tool) => tool.name !== "send_email" || GMAIL_SEND_ENABLED,
			),
		callTool: async (name, args) => {
			if (terminalAuthError) throw terminalAuthError
			if (name === "send_email" && !GMAIL_SEND_ENABLED) {
				throw new Error(
					"Gmail sending is temporarily unavailable while authorization is pending",
				)
			}
			const token = await accessToken()
			const loadExternalBody = async (
				messageId: string,
				attachmentId: string,
			): Promise<string | undefined> => {
				const attachment = await callApi<{ data?: string }>({
					accessToken: token,
					path: `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(gmailAttachmentId(attachmentId))}`,
					retryRead: true,
					maxResponseBytes: MAX_EXTERNAL_BODY_RESPONSE_BYTES,
				})
				return attachment.data
			}
			if (name === "search_messages") {
				const query = requiredString(args, "query", MAX_QUERY_CHARS)
				const maxResults = args.maxResults === undefined ? 20 : args.maxResults
				if (
					typeof maxResults !== "number" ||
					!Number.isInteger(maxResults) ||
					maxResults < 1 ||
					maxResults > MAX_RESULTS
				) {
					throw new Error(`maxResults must be between 1 and ${MAX_RESULTS}`)
				}
				const params = new URLSearchParams({
					q: query,
					maxResults: String(maxResults),
				})
				if (args.pageToken !== undefined) {
					if (typeof args.pageToken !== "string") {
						throw new Error("pageToken must be a string")
					}
					if (args.pageToken.length > MAX_PAGE_TOKEN_CHARS)
						throw new Error(
							`pageToken exceeds ${MAX_PAGE_TOKEN_CHARS} characters`,
						)
					params.set("pageToken", args.pageToken)
				}
				params.set(
					"fields",
					"messages(id,threadId),nextPageToken,resultSizeEstimate",
				)
				return callApi({
					accessToken: token,
					path: `/messages?${params}`,
					retryRead: true,
					maxResponseBytes: 256_000,
				})
			}
			if (name === "get_message") {
				const id = encodeURIComponent(gmailId(args, "messageId"))
				const params = new URLSearchParams({
					format: "full",
					fields: MESSAGE_FIELDS,
				})
				const message = await callApi<GmailMessage>({
					accessToken: token,
					path: `/messages/${id}?${params}`,
					retryRead: true,
					maxResponseBytes: 512_000,
				})
				return summarizeMessage(message, MAX_BODY_CHARS, (attachmentId) =>
					loadExternalBody(id, attachmentId),
				)
			}
			if (name === "get_thread") {
				const id = encodeURIComponent(gmailId(args, "threadId"))
				const params = new URLSearchParams({
					format: "full",
					fields: `id,messages(${MESSAGE_FIELDS})`,
				})
				const thread = await callApi<{
					id?: string
					messages?: GmailMessage[]
				}>({
					accessToken: token,
					path: `/threads/${id}?${params}`,
					retryRead: true,
					maxResponseBytes: 1_000_000,
				})
				const messages = (thread.messages ?? [])
					.sort(
						(a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0),
					)
					.slice(-100)
				const summaries = []
				for (const message of messages) {
					const messageId = message.id
					summaries.push(
						await summarizeMessage(
							message,
							5_000,
							messageId
								? (attachmentId) => loadExternalBody(messageId, attachmentId)
								: undefined,
						),
					)
				}
				return {
					id: thread.id,
					messages: summaries,
				}
			}
			if (name === "send_email") {
				return callApi({
					accessToken: token,
					path: "/messages/send",
					method: "POST",
					body: { raw: buildRawEmail(args) },
				})
			}
			throw new Error(`unknown Gmail tool '${name}'`)
		},
		close: async () => {},
	}
}

export const gmailValidation = {
	buildRawEmail,
	gmailId,
	normalizeGmailSendInput,
}
