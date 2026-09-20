import { describe, expect, it } from "vitest"
import {
	provisionedMembershipToRevoke,
	type SlackMembershipMapping,
} from "./membership-provenance"

function revoke(
	mappings: Record<string, SlackMembershipMapping>,
	mappingId: string,
): string | null {
	const mapping = mappings[mappingId]
	if (!mapping) throw new Error(`Unknown mapping: ${mappingId}`)
	mappings[mappingId] = {
		...mapping,
		status: "revoked",
	}
	return provisionedMembershipToRevoke(Object.values(mappings))
}

function sharedMembershipMappings(): Record<string, SlackMembershipMapping> {
	return {
		a: { status: "active", provisionedMemberId: "member-1" },
		b: { status: "active", provisionedMemberId: null },
	}
}

describe("shared Slack membership provenance", () => {
	it("retains provenance when the creating mapping is revoked first", () => {
		const mappings = sharedMembershipMappings()

		expect(revoke(mappings, "a")).toBeNull()
		expect(revoke(mappings, "b")).toBe("member-1")
	})

	it("retains provenance when the adopting mapping is revoked first", () => {
		const mappings = sharedMembershipMappings()

		expect(revoke(mappings, "b")).toBeNull()
		expect(revoke(mappings, "a")).toBe("member-1")
	})
})
