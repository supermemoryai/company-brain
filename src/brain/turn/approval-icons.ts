import {
	getCatalogIconUrlForToolLabel,
	mcpIconUrlForServer,
} from "../tools/mcp/catalog"
import { listActiveConnectionsForActor } from "../tools/mcp/store"
import type { TurnActor } from "./actor"

function serverSlugFromToolLabel(
	value: string | undefined,
): string | undefined {
	if (!value) return undefined
	const match = value.toLowerCase().match(/^([a-z0-9][a-z0-9_-]*)\./)
	return match?.[1]
}

export async function resolveApprovalIconUrl(args: {
	env: Env
	orgId: string
	actor: TurnActor
	slug?: string
	toolName: string
}): Promise<string | undefined> {
	const serverSlug =
		serverSlugFromToolLabel(args.slug) ?? serverSlugFromToolLabel(args.toolName)

	if (serverSlug) {
		const connections = await listActiveConnectionsForActor(
			args.env,
			args.orgId,
			args.actor.userId,
			args.actor.personalConnectionsOnly,
		)
		const connection = connections.find((row) => row.serverSlug === serverSlug)

		const catalogIconUrl = getCatalogIconUrlForToolLabel(serverSlug)
		if (catalogIconUrl) return catalogIconUrl

		const connectionIconUrl = mcpIconUrlForServer(
			serverSlug,
			connection?.serverUrl ?? undefined,
		)
		if (connectionIconUrl) return connectionIconUrl
	}

	return getCatalogIconUrlForToolLabel(args.slug, args.toolName)
}
