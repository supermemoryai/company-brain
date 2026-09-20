import { db, eq, withTransaction } from "@repo/db"
import * as schema from "@repo/db/schema"
import type {
	BrainChannelProactivity,
	BrainProactivityDefault,
	BrainProactivitySettings,
} from "@repo/db/schema/common"
import { parseBrainProactivity } from "../slack/proactivity"

export const MAX_CHANNEL_OVERRIDES = 500

export type ProactivityPatch = {
	default?: BrainProactivityDefault | null
	// null value deletes that channel's override; channels: null clears them all.
	channels?: Record<string, BrainChannelProactivity | null> | null
}

export type ProactivityUpdateResult =
	| { merged: BrainProactivitySettings | null }
	| { error: "too_many_channel_overrides" }

// Shared by the route and the tool; owns the transaction, not the authz.
export async function updateBrainProactivity(
	env: Env,
	orgId: string,
	patch: ProactivityPatch | null,
): Promise<ProactivityUpdateResult> {
	return withTransaction(db(env), async (tx) => {
		// FOR UPDATE locks nothing on a missing row; insert first so writes serialize
		await tx
			.insert(schema.organizationSettings)
			.values({ orgId })
			.onConflictDoNothing({ target: schema.organizationSettings.orgId })
		const [row] = await tx
			.select({
				brainProactivity: schema.organizationSettings.brainProactivity,
			})
			.from(schema.organizationSettings)
			.where(eq(schema.organizationSettings.orgId, orgId))

		let merged: BrainProactivitySettings | null = null
		if (patch != null) {
			const current = parseBrainProactivity(row?.brainProactivity)
			merged = { ...current }
			const { default: mode, channels } = patch
			if (mode !== undefined) {
				if (mode === null) delete merged.default
				else merged.default = mode
			}
			if (channels === null) {
				delete merged.channels
			} else if (channels) {
				const next = { ...(current.channels ?? {}) }
				for (const [channelId, value] of Object.entries(channels)) {
					if (value == null) delete next[channelId]
					else next[channelId] = value
				}
				if (Object.keys(next).length > MAX_CHANNEL_OVERRIDES) {
					return { error: "too_many_channel_overrides" as const }
				}
				if (Object.keys(next).length) merged.channels = next
				else delete merged.channels
			}
			if (!Object.keys(merged).length) merged = null
		}

		await tx
			.insert(schema.organizationSettings)
			.values({
				orgId,
				brainProactivity: merged,
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: schema.organizationSettings.orgId,
				set: { brainProactivity: merged, updatedAt: new Date() },
			})
		return { merged }
	})
}
