import { describe, expect, it } from "vitest"
import {
	isAddressedToOtherSlackUser,
	isAnsweredEvent,
	isBotMentioned,
	isChimeInEvent,
	isContextRetentionEvent,
	isPrivateSlackChannel,
	type SlackEventInner,
} from "./events"

const BOT = "UBOT"
const ev = (over: Partial<SlackEventInner>): SlackEventInner => ({
	type: "message",
	user: "U1",
	text: "hello",
	channel: "C1",
	channel_type: "channel",
	ts: "1.1",
	...over,
})

describe("isBotMentioned", () => {
	it("matches <@id> and <@id|label> only for the bot", () => {
		expect(isBotMentioned(`hi <@${BOT}>`, BOT)).toBe(true)
		expect(isBotMentioned(`hi <@${BOT}|brain>`, BOT)).toBe(true)
		expect(isBotMentioned("hi <@U2>", BOT)).toBe(false)
		expect(isBotMentioned(`hi <@${BOT}>`, null)).toBe(false)
		expect(isBotMentioned(undefined, BOT)).toBe(false)
	})
})

describe("isAddressedToOtherSlackUser", () => {
	it.each([
		["no mention", "hello", false],
		["other user only", "<@U2> ping", true],
		["bot only", `<@${BOT}> ping`, false],
		["bot and other user", `<@${BOT}> <@U2> ping`, false],
	])("%s", (_name, text, expected) => {
		expect(isAddressedToOtherSlackUser(text, BOT)).toBe(expected)
	})
	it("is false without a bot id", () => {
		expect(isAddressedToOtherSlackUser("<@U2> ping", null)).toBe(false)
	})
})

describe("isPrivateSlackChannel", () => {
	it.each([
		["C1", "group", true],
		["C1", "mpim", true],
		["C1", "channel", false],
		["D1", "im", false],
		["G1", undefined, true],
		["C1", undefined, true],
		["D1", undefined, false],
		[undefined, undefined, false],
	] as const)("%s/%s -> %s", (channel, type, expected) => {
		expect(isPrivateSlackChannel(channel, type)).toBe(expected)
	})
})

describe("isAnsweredEvent", () => {
	it.each([
		["dm message", ev({ type: "message", channel: "D1", channel_type: "im" }), true],
		["dm app_mention", ev({ type: "app_mention", channel: "D1", channel_type: "im" }), false],
		["channel app_mention", ev({ type: "app_mention", text: `<@${BOT}> hi` }), true],
		["channel message twin of mention", ev({ text: `<@${BOT}> hi` }), false],
		["channel top-level message", ev({}), false],
		["channel thread reply", ev({ thread_ts: "1.0" }), true],
		["bot message", ev({ bot_id: "B1", thread_ts: "1.0" }), false],
		["app message", ev({ app_id: "A1", thread_ts: "1.0" }), false],
		["message_changed", ev({ subtype: "message_changed", thread_ts: "1.0" }), false],
		["file_share thread reply", ev({ subtype: "file_share", thread_ts: "1.0" }), true],
		["reaction_added", ev({ type: "reaction_added" }), false],
	])("%s -> %s", (_name, event, expected) => {
		expect(isAnsweredEvent(event, BOT)).toBe(expected)
	})
})

describe("isChimeInEvent", () => {
	it.each([
		["top-level channel message", ev({}), true],
		["thread reply", ev({ thread_ts: "1.0" }), false],
		["dm", ev({ channel: "D1", channel_type: "im" }), false],
		["bot mention", ev({ text: `<@${BOT}> hi` }), false],
		["blank text", ev({ text: "  " }), false],
		["bot author", ev({ bot_id: "B1" }), false],
		["app_mention type", ev({ type: "app_mention" }), false],
	])("%s -> %s", (_name, event, expected) => {
		expect(isChimeInEvent(event, BOT)).toBe(expected)
	})
})

describe("isContextRetentionEvent", () => {
	it.each([
		["plain human message", ev({}), true],
		["human mention twin", ev({ text: `<@${BOT}> hi` }), false],
		["bot message mentioning bot", ev({ bot_id: "B1", text: `<@${BOT}> hi` }), true],
		["bot message", ev({ bot_id: "B1" }), true],
		["no channel", ev({ channel: undefined }), false],
		["app_mention", ev({ type: "app_mention" }), false],
	])("%s -> %s", (_name, event, expected) => {
		expect(isContextRetentionEvent(event, BOT)).toBe(expected)
	})
})
