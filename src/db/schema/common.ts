export type BrainProactivityDefault = "all_channels" | "own_channel_only"
export type BrainChannelProactivity = "proactive" | "quiet"

/** Where the brain may reply unprompted; absent keys fall back to all_channels. */
export type BrainProactivitySettings = {
	default?: BrainProactivityDefault
	channels?: Record<string, BrainChannelProactivity>
	journey?: { enabled?: boolean }
}

export type ProfileBucketDef = {
	key: string
	label: string
	description?: string
}
