/** True for Slack thread parents that should receive conversations.replies. */
export function isSlackHistoryThreadRoot(message: {
	ts?: string | null
	thread_ts?: string | null
	reply_count?: number | null
}): boolean {
	if ((message.reply_count ?? 0) <= 0) return false
	if (!message.ts) return false
	// Roots often have thread_ts === ts; only exclude true replies (thread_ts !== ts).
	return !message.thread_ts || message.thread_ts === message.ts
}
