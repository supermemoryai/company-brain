import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, vi } from "vitest"

// Keep the Workers runtime out of the import graph; only the SQL path is real.
vi.mock("../turn/agent", () => ({ brainAgent: () => ({ env: {} }) }))
vi.mock("../slack/workspace", () => ({
	getWorkspaceByTeamId: async () => undefined,
	ensureWorkspaceBotUserId: async () => undefined,
}))
vi.mock("../slack/client", () => ({
	getSlackConversationInfo: async () => undefined,
	getConversationMembers: async () => [],
}))
vi.mock("../slack/channel-directory", () => ({
	getChannelDirectory: async () => [],
}))

const { privateContainerTagFor } = await import("@/lib/spaces/provisioning")
const { ensureChannelMembershipTables } = await import(
	"../slack/channel-membership"
)
const { resolveBrainReadContainerTags } = await import("../memory/read-scope")
const { slackMemoryContainerTag } = await import("../memory/writeback")
const { scheduledRunMemoryScope } = await import("./schedule-derive")

// The owner's two identities: the org member id keys their employee memory,
// the Slack id resolves which private channels they belong to.
const owner = { creatorUserId: "member_42", creatorSlackUserId: "U042" }

function agentWhereOwnerIsIn(channelId: string) {
	const db = new DatabaseSync(":memory:")
	const sql = (strings: TemplateStringsArray, ...values: unknown[]) =>
		db.prepare(strings.join("?")).all(...(values as never[]))
	const agent = { name: "org", sql } as never
	ensureChannelMembershipTables(agent)
	sql`INSERT INTO brain_channel_membership (channel_id, slack_user_id, is_private, updated_at)
		VALUES (${channelId}, ${owner.creatorSlackUserId}, 1, 1)`
	return agent
}

describe("scheduled DM digest memory scope", () => {
	it("writes to the owner's employee memory, the container their DMs use", () => {
		const scope = scheduledRunMemoryScope(owner, true, "D042")
		expect(slackMemoryContainerTag(scope)).toBe(
			privateContainerTagFor("member_42"),
		)
	})

	it("reads the owner's employee memory and their private channels", () => {
		const tags = resolveBrainReadContainerTags(
			agentWhereOwnerIsIn("C0PRIV"),
			scheduledRunMemoryScope(owner, true, "D042"),
		)
		expect(tags).toContain(privateContainerTagFor("member_42"))
		expect(tags).toContain("slack_channel_C0PRIV")
		expect(tags).not.toContain(privateContainerTagFor("U042"))
	})

	it("keeps channel digests on the scope they were created with", () => {
		const memoryScope = { kind: "shared" as const, channelId: "C0PUB" }
		expect(
			scheduledRunMemoryScope({ ...owner, memoryScope }, false, "C0PUB"),
		).toBe(memoryScope)
	})
})
