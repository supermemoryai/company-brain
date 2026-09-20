import { mcpAppDisplayName } from "../tools/mcp/directory"
import type { LeaseMode } from "./types"

export function serverDisplayName(serverSlug: string): string {
	return mcpAppDisplayName(serverSlug)
}
export function describeRequestCapabilities(
	serverSlug: string,
	mode: LeaseMode,
): string {
	const name = serverDisplayName(serverSlug)
	return mode === "read_write"
		? `view & query data in ${name}, and create, modify, or delete records there.`
		: `view & query data in ${name} (read-only — no changes).`
}
export function describeGrantedCapabilities(
	serverSlug: string,
	mode: LeaseMode,
): string {
	const name = serverDisplayName(serverSlug)
	return mode === "read_write"
		? `read + write access to ${name}`
		: `read-only access to ${name}`
}
