/** Chat surface a turn runs on. */
export type SurfaceKind = "slack" | "teams"

/** Where a conversation lives, in surface-neutral terms. */
export type SurfaceRef = {
	kind: SurfaceKind
	/** Workspace / tenant id (Slack team id). */
	tenantId: string
	/** Channel or chat the conversation is in. */
	conversationId: string
	/** Thread root within the conversation. */
	threadId?: string
	/** Surface-native id of the user the ref is scoped to. */
	userId?: string
}

/**
 * Durable per-thread key. For Slack this is the historical
 * `teamId:channel:threadTs` string and must not change: it is persisted in
 * brain_thread_turn.thread_key.
 */
export function surfaceThreadKey(ref: SurfaceRef): string {
	const key = `${ref.tenantId}:${ref.conversationId}:${ref.threadId ?? ""}`
	return ref.kind === "slack" ? key : `${ref.kind}:${key}`
}
