import { describe, expect, it, vi } from "vitest"
import type { SlackPostResult } from "./client"
import { postSlackFarewell, shouldHoldForFarewell } from "./farewell"

const post = (result: SlackPostResult) => vi.fn(async () => result)

describe("postSlackFarewell", () => {
	it("posts to #company-brain found from the bot's channels and holds on rate limit", async () => {
		const listBotConversations = vi.fn(async () => [
			{ id: "C-home", name: "company-brain", isPrivate: false },
		])
		const posted = post({ ok: true, ts: String(Date.now() / 1000) })
		await expect(
			postSlackFarewell({
				botToken: "xoxb",
				teamId: "T1",
				kind: "shutdown",
				text: "bye",
				deps: { postMessageIdempotent: posted, listBotConversations },
			}),
		).resolves.toBe("posted")
		expect(posted).toHaveBeenCalledWith(
			"xoxb",
			"C-home",
			"bye",
			expect.stringMatching(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			),
		)

		await expect(
			postSlackFarewell({
				botToken: "xoxb",
				teamId: "T1",
				kind: "shutdown",
				text: "bye",
				knownHomeChannelId: "C-home",
				deps: {
					postMessageIdempotent: post({
						ok: false,
						error: "ratelimited",
						retryAfterSeconds: 10,
					}),
					listBotConversations,
				},
			}),
		).resolves.toBe("hold")
	})

	it("reports a deduped repeat as already posted", async () => {
		await expect(
			postSlackFarewell({
				botToken: "xoxb",
				teamId: "T1",
				kind: "shutdown",
				text: "bye",
				knownHomeChannelId: "C-home",
				deps: {
					postMessageIdempotent: post({ ok: true, ts: "1.0", deduped: true }),
					listBotConversations: vi.fn(async () => []),
				},
			}),
		).resolves.toBe("already_posted")
	})

	it("skips a dead channel instead of blocking the exit", () => {
		expect(
			shouldHoldForFarewell({ ok: false, error: "channel_not_found" }),
		).toBe(false)
		expect(shouldHoldForFarewell({ ok: false, error: "http_503" })).toBe(true)
	})
})
