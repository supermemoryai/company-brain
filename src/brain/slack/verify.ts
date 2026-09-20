import { createHmac, timingSafeEqual } from "node:crypto"

const MAX_SKEW_SECONDS = 60 * 5
export function verifySlackSignature(
	rawBody: Uint8Array,
	headers: Headers,
	signingSecret: string,
	nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
	const signature = headers.get("x-slack-signature")
	const timestamp = headers.get("x-slack-request-timestamp")
	if (!signature || !timestamp || !signingSecret) return false

	const ts = Number(timestamp)
	if (!Number.isFinite(ts)) return false
	if (Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return false

	const base = `v0:${timestamp}:${Buffer.from(rawBody).toString("utf8")}`
	const expected = `v0=${createHmac("sha256", signingSecret)
		.update(base)
		.digest("hex")}`

	const a = Buffer.from(expected)
	const b = Buffer.from(signature)
	if (a.length !== b.length) return false
	return timingSafeEqual(a, b)
}
export function isSlackRetry(headers: Headers): boolean {
	return headers.get("x-slack-retry-num") != null
}
