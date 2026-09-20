const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"
const DEFAULT_MAX_RESPONSE_BYTES = 512_000

export class GmailApiError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly reasons: string[] = [],
		public readonly googleStatus?: string,
	) {
		super(message)
	}
}

const QUOTA_REASONS = new Set([
	"dailylimitexceeded",
	"quotaexceeded",
	"ratelimitexceeded",
	"userratelimitexceeded",
	"resource_exhausted",
])

function normalizeReason(reason: string): string {
	return reason.toLowerCase()
}

export function isGmailQuotaError(error: GmailApiError): boolean {
	return (
		error.status === 403 &&
		(error.reasons.some((reason) =>
			QUOTA_REASONS.has(normalizeReason(reason)),
		) ||
			normalizeReason(error.googleStatus ?? "") === "resource_exhausted")
	)
}

function isTransient(error: unknown): boolean {
	return (
		error instanceof TypeError ||
		(error instanceof GmailApiError &&
			(error.status === 429 || error.status >= 500 || isGmailQuotaError(error)))
	)
}

function googleErrorDetails(body: Record<string, unknown>): {
	message?: string
	reasons: string[]
	status?: string
} {
	const error = body.error
	if (!error || typeof error !== "object") return { reasons: [] }
	const value = error as Record<string, unknown>
	const reasons = new Set<string>()
	if (Array.isArray(value.errors)) {
		for (const item of value.errors) {
			if (item && typeof item === "object") {
				const reason = (item as Record<string, unknown>).reason
				if (typeof reason === "string") reasons.add(reason)
			}
		}
	}
	if (Array.isArray(value.details)) {
		for (const item of value.details) {
			if (item && typeof item === "object") {
				const reason = (item as Record<string, unknown>).reason
				if (typeof reason === "string") reasons.add(reason)
			}
		}
	}
	return {
		message: typeof value.message === "string" ? value.message : undefined,
		reasons: [...reasons],
		status: typeof value.status === "string" ? value.status : undefined,
	}
}

async function readBoundedJson(
	response: Response,
	maxBytes: number,
): Promise<Record<string, unknown>> {
	const contentLength = Number(response.headers.get("content-length"))
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		throw new GmailApiError("Gmail response exceeded the allowed size", 413)
	}
	if (!response.body) return {}
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let received = 0
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		received += value.byteLength
		if (received > maxBytes) {
			await reader.cancel().catch(() => {})
			throw new GmailApiError("Gmail response exceeded the allowed size", 413)
		}
		chunks.push(value)
	}
	const bytes = new Uint8Array(received)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	if (bytes.length === 0) return {}
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as Record<
			string,
			unknown
		>
	} catch {
		throw new GmailApiError("Gmail returned an invalid JSON response", 502)
	}
}

export async function gmailApiRequest<T>(args: {
	accessToken: string
	path: string
	method?: "GET" | "POST"
	body?: unknown
	retryRead?: boolean
	maxResponseBytes?: number
	fetch?: typeof fetch
}): Promise<T> {
	const request = args.fetch ?? fetch
	async function run(): Promise<T> {
		const response = await request(`${GMAIL_API}${args.path}`, {
			method: args.method ?? "GET",
			headers: {
				authorization: `Bearer ${args.accessToken}`,
				...(args.body ? { "content-type": "application/json" } : {}),
			},
			body: args.body ? JSON.stringify(args.body) : undefined,
		})
		const body = await readBoundedJson(
			response,
			args.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
		)
		if (!response.ok) {
			const apiError = googleErrorDetails(body)
			throw new GmailApiError(
				apiError.message ?? `Gmail API failed (${response.status})`,
				response.status,
				apiError.reasons,
				apiError.status,
			)
		}
		return body as T
	}
	try {
		return await run()
	} catch (error) {
		if (!args.retryRead || !isTransient(error)) throw error
		return run()
	}
}
