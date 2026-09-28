import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { isSlackRetry, verifySlackSignature } from "./verify"

const SECRET = "shhh"
const NOW = 1_700_000_000

function sign(body: string, ts: number, secret = SECRET) {
	return `v0=${createHmac("sha256", secret)
		.update(`v0:${ts}:${body}`)
		.digest("hex")}`
}

function headers(signature: string, ts: number | string) {
	return new Headers({
		"x-slack-signature": signature,
		"x-slack-request-timestamp": String(ts),
	})
}

const bytes = (s: string) => new TextEncoder().encode(s)

describe("verifySlackSignature", () => {
	it("accepts a valid signature", () => {
		const body = '{"type":"event_callback"}'
		expect(
			verifySlackSignature(
				bytes(body),
				headers(sign(body, NOW), NOW),
				SECRET,
				NOW,
			),
		).toBe(true)
	})

	it("rejects a signature made with another secret or another body", () => {
		const body = "hello"
		expect(
			verifySlackSignature(
				bytes(body),
				headers(sign(body, NOW, "other"), NOW),
				SECRET,
				NOW,
			),
		).toBe(false)
		expect(
			verifySlackSignature(
				bytes("tampered"),
				headers(sign(body, NOW), NOW),
				SECRET,
				NOW,
			),
		).toBe(false)
		expect(
			verifySlackSignature(bytes(body), headers("v0=short", NOW), SECRET, NOW),
		).toBe(false)
	})

	it("enforces a 5 minute timestamp skew in both directions", () => {
		const body = "x"
		const at = (ts: number) =>
			verifySlackSignature(
				bytes(body),
				headers(sign(body, ts), ts),
				SECRET,
				NOW,
			)
		expect(at(NOW - 300)).toBe(true)
		expect(at(NOW - 301)).toBe(false)
		expect(at(NOW + 300)).toBe(true)
		expect(at(NOW + 301)).toBe(false)
	})

	it("accepts an empty body with a matching signature", () => {
		expect(
			verifySlackSignature(
				new Uint8Array(),
				headers(sign("", NOW), NOW),
				SECRET,
				NOW,
			),
		).toBe(true)
	})

	it("rejects missing headers, a missing secret and a non-numeric timestamp", () => {
		const sig = sign("x", NOW)
		expect(verifySlackSignature(bytes("x"), new Headers(), SECRET, NOW)).toBe(
			false,
		)
		expect(
			verifySlackSignature(bytes("x"), headers(sig, NOW), "", NOW),
		).toBe(false)
		expect(
			verifySlackSignature(bytes("x"), headers(sig, "abc"), SECRET, NOW),
		).toBe(false)
	})
})

describe("isSlackRetry", () => {
	it("is true only when the retry header is present", () => {
		expect(isSlackRetry(new Headers({ "x-slack-retry-num": "1" }))).toBe(true)
		expect(isSlackRetry(new Headers())).toBe(false)
	})
})
