import { describe, expect, it } from "vitest"
import {
	SLACK_SURFACE_CAPABILITIES,
	surfaceCapabilitiesOf,
	surfaceToolGate,
	type TurnSurfaceContext,
} from "./capabilities"
import { surfaceAskerFromSlack } from "./identity"

const explicitSlack: TurnSurfaceContext = {
	kind: "slack",
	ref: { kind: "slack", tenantId: "T1", conversationId: "C1", threadId: "1.0" },
	capabilities: SLACK_SURFACE_CAPABILITIES,
}

describe("surface capabilities", () => {
	it("defaults to Slack's capabilities when no surface is given", () => {
		expect(surfaceCapabilitiesOf(undefined)).toEqual(SLACK_SURFACE_CAPABILITIES)
		expect(surfaceCapabilitiesOf(explicitSlack)).toEqual(
			SLACK_SURFACE_CAPABILITIES,
		)
	})

	it("gates the same Slack-only tools with or without an explicit Slack surface", () => {
		expect(surfaceToolGate(undefined)).toEqual(surfaceToolGate(explicitSlack))
		expect(surfaceToolGate(undefined)).toEqual({
			channelSearch: true,
			peopleDirectory: true,
		})
	})

	it("drops Slack-only tools for a surface without those capabilities", () => {
		expect(
			surfaceToolGate({
				kind: "teams",
				capabilities: {
					canSearchChannels: false,
					hasDirectory: false,
					supportsEphemeral: false,
					supportsStreaming: false,
				},
			}),
		).toEqual({ channelSearch: false, peopleDirectory: false })
	})
})

describe("surfaceAskerFromSlack", () => {
	it("maps the Slack asker to a neutral identity", () => {
		expect(
			surfaceAskerFromSlack({
				slackUserId: "U1",
				name: "Ada Lovelace",
				displayName: "ada",
				email: "ada@example.com",
				timezone: "Europe/London",
			}),
		).toEqual({
			externalUserId: "U1",
			displayName: "ada",
			email: "ada@example.com",
			tz: "Europe/London",
		})
		expect(surfaceAskerFromSlack({ name: "Ada" })).toEqual({
			displayName: "Ada",
		})
		expect(surfaceAskerFromSlack({})).toEqual({})
	})
})
