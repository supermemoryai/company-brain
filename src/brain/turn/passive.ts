export const PASSIVE_NO_REPLY = "NO_REPLY"

export function isPassiveNoReply(reply: string): boolean {
	return reply.trim() === PASSIVE_NO_REPLY
}

export function buildPassiveInvocationContext(reason: string): string {
	const safeReason = reason
		.normalize("NFKC")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: Control-character removal is intentional prompt sanitization.
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 900)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
	return `<passive_invocation>
You were not addressed directly. Triage flagged this message with a hypothesis: ${safeReason || "The visible Slack context may contain an organization-relevant signal."}
Act on it like a sharp, warm teammate. Verify using read-only memory and connected-source checks. If confirmed, respond the way that teammate would: a specific fact, a connection to prior work, or looping in — or directly asking — the person who should pick this up. When the hypothesis is that Company Brain could do legwork someone else was asked for, the right reply is an offer addressed to that person: name exactly what you can pull and wait for their acceptance. Never deliver the data uninvited, and never decide who should see it — their yes is the permission, and it arrives as a normal follow-up message. A person's subjective statement is evidence about that person's experience only: attribute it to them, and never restate it as a product, team, or company-wide condition unless the record independently corroborates it. If the checks find nothing actionable but the moment deserves a human word, one short warm line is a valid reply. Do not request approval, connect an app, schedule anything, or save memory in this passive turn. If there is genuinely nothing worth saying, respond with exactly ${PASSIVE_NO_REPLY} and nothing else.
</passive_invocation>`
}
