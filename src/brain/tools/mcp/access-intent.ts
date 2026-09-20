const PERSONAL_ACCESS_DENIAL_PATTERNS = [
	/\b(?:i|we)\s+(?:do\s+not|don['’]?t|dont)\s+have(?:\s+[\p{L}\p{N}_-]+){0,5}\s+(?:access|permissions?|account)\b/iu,
	/\b(?:i|we)\s+have\s+no(?:\s+[\p{L}\p{N}_-]+){0,5}\s+(?:access|permissions?|account)\b/iu,
	/\b(?:i|we)\s+(?:can['’]?t|cant|cannot|can\s+not|couldn['’]?t|couldnt)\s+(?:access|authorize|authenticate|log\s*in|sign\s*in)\b/iu,
	/\b(?:access|permissions?)\s+(?:(?:is|was|got)\s+)?denied\b/iu,
	/\b(?:i(?:['’]?m|\s+am)|we(?:['’]?re|\s+are))\s+not\s+(?:authorized|permitted|a\s+member)\b/iu,
]

/**
 * True only when the requester says they cannot use their own underlying app
 * account. A missing MCP connection alone must not be treated as missing SaaS
 * access, so phrases such as "I don't have it connected" deliberately do not
 * match.
 */
export function requesterLacksPersonalAppAccess(
	text: string | undefined,
): boolean {
	const normalized = text?.normalize("NFKC").trim()
	if (!normalized) return false
	return PERSONAL_ACCESS_DENIAL_PATTERNS.some((pattern) =>
		pattern.test(normalized),
	)
}
