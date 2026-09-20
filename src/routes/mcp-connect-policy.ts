import type { McpCatalogEntry } from "@/lib/brain/tools/mcp/catalog"
import { getDirectoryEntryBySlug } from "@/lib/brain/tools/mcp/directory"

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
