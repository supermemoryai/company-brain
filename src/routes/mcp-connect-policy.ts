import type { mcpOAuthState } from "@repo/db/schema/brain/mcp"
import type { McpCatalogEntry } from "@/lib/brain/tools/mcp/catalog"
import { getDirectoryEntryBySlug } from "@/lib/brain/tools/mcp/directory"

type McpOAuthState = typeof mcpOAuthState.$inferSelect

function sameServerUrl(left: string, right: string): boolean {
	try {
		const a = new URL(left)
		const b = new URL(right)
		a.hash = ""
		b.hash = ""
		return a.toString() === b.toString()
	} catch {
		return left === right
	}
}

export function catalogConnectUrlIsValid(
	entry: McpCatalogEntry | undefined,
	serverUrl: string | undefined,
): boolean {
	if (!entry) return true
	if (entry.runtime === "embedded") return serverUrl === undefined
	return serverUrl === undefined || sameServerUrl(serverUrl, entry.serverUrl)
}

// A directory slug names a known server, so a caller-supplied URL must not
// repoint it: that would persist an attacker endpoint under a trusted name.
export function directoryConnectUrlIsValid(
	slug: string,
	serverUrl: string | undefined,
): boolean {
	const entry = getDirectoryEntryBySlug(slug)
	if (!entry?.url) return true
	return serverUrl === undefined || sameServerUrl(serverUrl, entry.url)
}

// The authorize URL is a transferable link, so whoever opens it picks the
// account that approves. Unless the callback re-checks the session, the grant
// lands on whoever started the flow instead. Slack connects are bound to a
// team and user before the redirect and have no browser session to match.
export function callbackSessionIsValid(
	flow: Pick<McpOAuthState, "orgId" | "userId" | "context">,
	session: { userId: string | null; orgId: string | null; isOrgAdmin: boolean },
): boolean {
	if (flow.context?.slack) return true
	if (!session.userId || session.orgId !== flow.orgId) return false
	// Shared connections have no owning user, so gate them like the start endpoint.
	if (flow.userId === null) return session.isOrgAdmin
	return session.userId === flow.userId
}
