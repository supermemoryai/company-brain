/**
 * The hosted brain reported to Sentry. Self-hosted deployments log to the
 * Workers console instead, which `wrangler tail` and Workers Logs pick up.
 */
export function captureException(error: unknown, context?: unknown): void {
	const message = error instanceof Error ? error.message : String(error)
	const cause =
		error instanceof Error && error.cause ? ` | ${String(error.cause)}` : ""
	const tags = (context as { tags?: Record<string, string | undefined> })?.tags
	const tagStr = tags ? Object.values(tags).filter(Boolean).join(" | ") : ""
	console.error(`[error] ${tagStr ? `${tagStr} - ` : ""}${message}${cause}`)
	if (error instanceof Error && error.stack) console.error(error.stack)
}

export function captureMessage(message: string, context?: unknown): void {
	const level = (context as { level?: string })?.level ?? "info"
	console.log(`[${level}] ${message}`)
}
