import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/crypto", () => ({ decryptToken: async () => "xoxb-test" }))
vi.mock("./workspace", () => ({
	getWorkspaceByTeamId: async () => ({ orgId: "org", botTokenEnc: "enc" }),
	ensureWorkspaceBotUserId: async () => "UBOT",
}))
// Both privacy lookups fail, as they do during a Slack API outage.
vi.mock("./channel-directory", () => ({
	getChannelDirectory: async () => {
		throw new Error("slack down")
	},
}))
vi.mock("./client", () => ({
	getSlackConversationInfo: async () => undefined,
	getConversationMembers: async () => [],
}))
vi.mock("../turn/agent", () => ({ brainAgent: () => ({ env: {} }) }))

const {
	ensureChannelMembershipTables,
	readableSlackChannelContainerTagsForUser,
	runSlackMembershipEvent,
} = await import("./channel-membership")

function fakeAgent() {
	const db = new DatabaseSync(":memory:")
	const sql = (strings: TemplateStringsArray, ...values: unknown[]) =>
		db.prepare(strings.join("?")).all(...(values as never[]))
	return { name: "org", sql } as never
}

describe("runSlackMembershipEvent", () => {
	it("revokes DM access on leave even when the privacy lookup fails", async () => {
		const agent = fakeAgent()
		ensureChannelMembershipTables(agent)
		;(agent as { sql: Function }).sql`
			INSERT INTO brain_channel_membership (channel_id, slack_user_id, is_private, updated_at)
			VALUES (${"C1"}, ${"U1"}, 1, ${0})
		`
		expect(readableSlackChannelContainerTagsForUser(agent, "U1")).toHaveLength(1)

		await runSlackMembershipEvent(agent, {
			teamId: "T1",
			event: { type: "member_left_channel", channel: "C1", user: "U1" },
		} as never)

		expect(readableSlackChannelContainerTagsForUser(agent, "U1")).toEqual([])
	})
})
