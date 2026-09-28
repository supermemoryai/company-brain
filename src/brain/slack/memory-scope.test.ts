import { describe, expect, it } from "vitest"
import { slackMemoryScopeForTurn } from "./turn"

const channel = "C0PRODUCT"
const scopeKind = (
	channelType: string | undefined,
	isPrivate: boolean | undefined,
	lookupFailed = false,
) =>
	slackMemoryScopeForTurn({
		isDM: false,
		channel,
		channelType,
		userId: "user_1",
		...(lookupFailed ? {} : { conversationInfo: { id: channel, isPrivate } }),
	}).kind

describe("slackMemoryScopeForTurn", () => {
	// app_mention events carry no channel_type.
	it("scopes an @mention in a public channel to the shared brain", () => {
		expect(scopeKind(undefined, false)).toBe("shared")
	})

	it("keeps an @mention in a private channel private", () => {
		expect(scopeKind(undefined, true)).toBe("private_channel")
	})

	it("stays private when the channel lookup fails", () => {
		expect(scopeKind(undefined, undefined, true)).toBe("private_channel")
		expect(scopeKind(undefined, undefined)).toBe("private_channel")
	})

	it("lets either signal mark a message event private", () => {
		expect(scopeKind("channel", false)).toBe("shared")
		expect(scopeKind("channel", true)).toBe("private_channel")
		expect(scopeKind("group", false)).toBe("private_channel")
	})
})
