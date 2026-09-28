import type { SurfaceKind, SurfaceRef } from "./types"

/** What the surface can do that changes which tools and prompt text a turn gets. */
export type SurfaceCapabilities = {
	/** Search history of channels other than the current thread. */
	canSearchChannels: boolean
	/** Queryable member directory. */
	hasDirectory: boolean
	/** Messages only the asker can see. */
	supportsEphemeral: boolean
	/** Native streaming of progress and the reply. */
	supportsStreaming: boolean
}

export const SLACK_SURFACE_CAPABILITIES: SurfaceCapabilities = {
	canSearchChannels: true,
	hasDirectory: true,
	supportsEphemeral: true,
	supportsStreaming: true,
}

export type TurnSurfaceContext = {
	kind: SurfaceKind
	ref?: SurfaceRef
	capabilities: SurfaceCapabilities
}

/** A turn with no explicit surface behaves as it always has: on Slack. */
export function surfaceCapabilitiesOf(
	surface: TurnSurfaceContext | undefined,
): SurfaceCapabilities {
	return surface?.capabilities ?? SLACK_SURFACE_CAPABILITIES
}

/**
 * Which Slack-only tool families a turn on this surface may assemble:
 * search_slack_channel(s) and inspect_people_directory. Channel search still
 * also needs a Slack lookup context to exist.
 */
export function surfaceToolGate(surface: TurnSurfaceContext | undefined): {
	channelSearch: boolean
	peopleDirectory: boolean
} {
	const capabilities = surfaceCapabilitiesOf(surface)
	return {
		channelSearch: capabilities.canSearchChannels,
		peopleDirectory: capabilities.hasDirectory,
	}
}
