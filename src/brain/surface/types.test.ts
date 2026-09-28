import { describe, expect, it } from "vitest"
import { slackThreadTurnKey } from "../slack/turn-control"
import { surfaceThreadKey } from "./types"

describe("surfaceThreadKey", () => {
	it("keeps the persisted Slack thread key string byte for byte", () => {
		expect(slackThreadTurnKey("T1", "C1", "1700000000.000100")).toBe(
			"T1:C1:1700000000.000100",
		)
		expect(
			surfaceThreadKey({
				kind: "slack",
				tenantId: "T1",
				conversationId: "C1",
				threadId: "1700000000.000100",
			}),
		).toBe("T1:C1:1700000000.000100")
	})

	it("namespaces other surfaces so keys cannot collide with Slack's", () => {
		expect(
			surfaceThreadKey({
				kind: "teams",
				tenantId: "T1",
				conversationId: "C1",
				threadId: "9",
			}),
		).toBe("teams:T1:C1:9")
	})
})
