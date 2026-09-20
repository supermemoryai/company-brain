import type {
	BrainChannelProactivity,
	BrainProactivityDefault,
	BrainProactivitySettings,
} from "@repo/db/schema/common"

export const BRAIN_PROACTIVITY_DEFAULTS = [
	"all_channels",
	"own_channel_only",
] as const satisfies readonly BrainProactivityDefault[]
export const BRAIN_CHANNEL_PROACTIVITY = [
	"proactive",
	"quiet",
] as const satisfies readonly BrainChannelProactivity[]

export const DEFAULT_BRAIN_PROACTIVITY: BrainProactivityDefault = "all_channels"
export const HOME_CHANNEL_NAME = "company-brain"

export const PROACTIVITY_FILTER_REASON =
	"Proactive replies are disabled for this channel by the org's proactivity settings."

function isDefaultMode(value: unknown): value is BrainProactivityDefault {
	return (BRAIN_PROACTIVITY_DEFAULTS as readonly unknown[]).includes(value)
}

function isChannelMode(value: unknown): value is BrainChannelProactivity {
	return (BRAIN_CHANNEL_PROACTIVITY as readonly unknown[]).includes(value)
}

/** Tolerates junk: unknown keys/values are dropped, never thrown on. */
export function parseBrainProactivity(raw: unknown): BrainProactivitySettings {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
	const record = raw as Record<string, unknown>
	const settings: BrainProactivitySettings = {}
	if (isDefaultMode(record.default)) settings.default = record.default
	const channels = record.channels
	if (channels && typeof channels === "object" && !Array.isArray(channels)) {
		const valid: Record<string, BrainChannelProactivity> = {}
		for (const [channelId, mode] of Object.entries(channels)) {
			if (isChannelMode(mode)) valid[channelId] = mode
		}
		if (Object.keys(valid).length) settings.channels = valid
	}
	// The PATCH merge spreads this parse; dropping journey here would erase the
	// scheduler opt-in on every ordinary proactivity edit.
	const journey = record.journey
	if (journey && typeof journey === "object" && !Array.isArray(journey)) {
		const enabled = (journey as Record<string, unknown>).enabled
		if (typeof enabled === "boolean") settings.journey = { enabled }
	}
	return settings
}

/**
 * Precedence: home channel (always proactive) > per-channel override > org
 * default. Only gates channel surfaces — DM/mention/name-wake paths never call this.
 */
export function resolveChannelProactivity(args: {
	settings: unknown
	channelId: string | null | undefined
	homeChannelId?: string | null
	channelName?: string | null
}): BrainChannelProactivity {
	if (!args.channelId) return "proactive"
	if (args.homeChannelId && args.channelId === args.homeChannelId)
		return "proactive"
	if (args.channelName === HOME_CHANNEL_NAME) return "proactive"
	const settings = parseBrainProactivity(args.settings)
	const override = settings.channels?.[args.channelId]
	if (override) return override
	return (settings.default ?? DEFAULT_BRAIN_PROACTIVITY) === "all_channels"
		? "proactive"
		: "quiet"
}
