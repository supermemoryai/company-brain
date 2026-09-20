/**
 * Container tags partition memory. supermemory creates a container the first
 * time something is written to it, so there is nothing to provision here.
 */
export const SHARED_TEAM_BRAIN_CONTAINER_TAG = "sm_org_shared"

export const AGENT_SELF_CONTAINER_TAG = "sm_agent_self"

export function privateContainerTagFor(userId: string): string {
	return `user_${userId}`
}

export function buildOrgEntityContext(params: {
	orgName: string
	domain?: string | null
	about?: string | null
}): string {
	const header = `Organization: ${params.orgName}${params.domain ? ` (${params.domain})` : ""}. This is the shared company brain for everyone in this org.`
	const aboutLine = params.about?.trim() ? `About: ${params.about.trim()}` : ""
	return [
		header,
		aboutLine,
		"Scope every memory to this organization — its people, teams, projects, customers, decisions, and product/domain terms.",
		"A full profile isn't provided yet: infer the org's products, structure, and vocabulary from ingested content, and treat recurring names (people, repos, products, customers, projects) as this org's entities.",
	]
		.filter(Boolean)
		.join("\n")
}
