export type SlackMembershipMapping = {
	status: string
	provisionedMemberId: string | null
}

export function provisionedMembershipToRevoke(
	mappings: SlackMembershipMapping[],
): string | null {
	if (mappings.some((mapping) => mapping.status === "active")) {
		return null
	}

	return (
		mappings.find((mapping) => mapping.provisionedMemberId)
			?.provisionedMemberId ?? null
	)
}
