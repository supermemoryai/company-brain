import { describe, expect, it } from "vitest"
import { callbackSessionIsValid } from "./mcp-connect-policy"

const ORG = "org_acme"
const OWNER = "user_owner"
const OTHER = "user_other"

const personal = { orgId: ORG, userId: OWNER, context: null }
const shared = { orgId: ORG, userId: null, context: null }
const owner = { userId: OWNER, orgId: ORG, isOrgAdmin: false }
const signedOut = { userId: null, orgId: null, isOrgAdmin: false }

describe("callbackSessionIsValid", () => {
	it("lets the account that started the flow finish it", () => {
		expect(callbackSessionIsValid(personal, owner)).toBe(true)
	})

	it("rejects another account finishing the flow", () => {
		expect(callbackSessionIsValid(personal, { ...owner, userId: OTHER })).toBe(
			false,
		)
	})

	it("rejects a signed-out callback", () => {
		expect(callbackSessionIsValid(personal, signedOut)).toBe(false)
	})

	it("rejects a session signed into another org", () => {
		expect(
			callbackSessionIsValid(personal, { ...owner, orgId: "org_other" }),
		).toBe(false)
	})

	it("lets an org admin finish a shared flow", () => {
		expect(
			callbackSessionIsValid(shared, {
				...owner,
				userId: OTHER,
				isOrgAdmin: true,
			}),
		).toBe(true)
	})

	it("rejects a plain member finishing a shared flow", () => {
		expect(callbackSessionIsValid(shared, { ...owner, userId: OTHER })).toBe(
			false,
		)
	})

	it("leaves Slack flows alone: they carry no browser session", () => {
		const slack = {
			...personal,
			context: {
				slack: {
					teamId: "T1",
					channel: "C1",
					threadTs: "1700000000.0",
					slackUserId: "U1",
				},
			},
		}
		expect(callbackSessionIsValid(slack, signedOut)).toBe(true)
	})
})
