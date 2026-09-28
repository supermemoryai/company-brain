// @ts-expect-error bun:test types are not part of the worker tsconfig
import { mock } from "bun:test"
import { describe, expect, it } from "vitest"
import type { CompanyBrainAgent } from "../turn/agent"
import {
	privateSlackChannelContainerTag,
	slackMemoryContainerTag,
} from "./writeback"

type FakeAgent = CompanyBrainAgent & { privateChannelIds: string[] }

// channel-membership imports the Durable Object runtime, which doesn't load
// outside workerd, so the membership lookup is stubbed: it maps the fake
// agent's private-channel ids to their container tags.
mock.module("../slack/channel-membership", () => ({
	ensureChannelMembershipTables: () => {},
	runSlackMembershipEvent: async () => {},
	reconcileChannelMembership: async () => {},
	readableSlackChannelContainerTagsForUser: (
		agent: FakeAgent,
		slackUserId: string | undefined,
	) =>
		slackUserId
			? agent.privateChannelIds.map(privateSlackChannelContainerTag)
			: [],
}))
const { resolveBrainReadContainerTags } = await import("./read-scope")

const fakeAgent = (privateChannelIds: string[]) =>
	({ privateChannelIds }) as unknown as CompanyBrainAgent

describe("slackMemoryContainerTag", () => {
	it("maps each scope kind to its write tag", () => {
		expect(slackMemoryContainerTag(undefined)).toBe("sm_org_shared")
		expect(slackMemoryContainerTag({ kind: "shared", channelId: "C1" })).toBe(
			"sm_org_shared",
		)
		expect(slackMemoryContainerTag({ kind: "dm", userId: "u1" })).toBe(
			"user_u1",
		)
		expect(slackMemoryContainerTag({ kind: "dm" })).toBeUndefined()
		expect(
			slackMemoryContainerTag({ kind: "private_channel", channelId: "G9" }),
		).toBe("slack_channel_G9")
		expect(privateSlackChannelContainerTag("G9")).toBe("slack_channel_G9")
	})
})

describe("resolveBrainReadContainerTags", () => {
	const agent = fakeAgent(["G1", "G2"])

	it("reads shared plus the scope tag for channels", () => {
		expect(resolveBrainReadContainerTags(agent, undefined)).toEqual([
			"sm_org_shared",
		])
		expect(
			resolveBrainReadContainerTags(agent, { kind: "shared", channelId: "C1" }),
		).toEqual(["sm_org_shared"])
		expect(
			resolveBrainReadContainerTags(agent, {
				kind: "private_channel",
				channelId: "G9",
			}),
		).toEqual(["sm_org_shared", "slack_channel_G9"])
	})

	it("adds every private channel the asker belongs to for a DM", () => {
		expect(
			resolveBrainReadContainerTags(agent, {
				kind: "dm",
				userId: "u1",
				slackUserId: "U1",
			}),
		).toEqual([
			"sm_org_shared",
			"user_u1",
			"slack_channel_G1",
			"slack_channel_G2",
		])
		// no slack id: no membership lookup
		expect(
			resolveBrainReadContainerTags(agent, { kind: "dm", userId: "u1" }),
		).toEqual(["sm_org_shared", "user_u1"])
	})

	it("lets an explicit override replace the derived set, even when empty", () => {
		expect(
			resolveBrainReadContainerTags(agent, { kind: "dm", userId: "u1" }, [
				"a",
				"a",
				"b",
			]),
		).toEqual(["a", "b"])
		expect(resolveBrainReadContainerTags(agent, undefined, [])).toEqual([])
	})
})
