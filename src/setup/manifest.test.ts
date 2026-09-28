import { describe, expect, it } from "vitest"
import { slackAppManifest } from "./manifest"

describe("slackAppManifest", () => {
	it("subscribes to the membership events DMs read private channels from", () => {
		const events =
			slackAppManifest("https://brain.example.com").settings
				.event_subscriptions.bot_events
		expect(events).toContain("member_joined_channel")
		expect(events).toContain("member_left_channel")
	})
})
