import type { ProfileBucketDef } from "@repo/db/schema/common"
import { captureException } from "@/lib/capture"
import { setContainerEntityContext } from "../../memory/entity-context"
import {
	AGENT_SELF_CONTAINER_TAG,
	privateContainerTagFor,
	SHARED_TEAM_BRAIN_CONTAINER_TAG,
} from "@/lib/spaces/provisioning"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { privateSlackChannelContainerTag } from "."
import {
	BRAIN_MEMORY_BUCKETS,
	BRAIN_SELF_BUCKETS,
	buildBrainPersonalEntityContext,
	buildBrainPrivateChannelEntityContext,
	buildBrainSelfEntityContext,
	buildBrainSharedEntityContext,
} from "./profile-config"
import {
	isGeneratedBrainSpaceName,
	isSlackManagedBrainSpaceName,
	SLACK_MANAGED_SPACE_NAME_METADATA_KEY,
	slackChannelSpaceName,
	slackManagedBrainSpaceName,
} from "./space-name"

/** Re-sync a tag's brain config at most once per this window. */
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000

function ensureSyncTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_profile_sync (
			scope_key TEXT PRIMARY KEY,
			synced_at INTEGER NOT NULL
		)
	`
}

/** True when this scope hasn't been synced inside the interval (throttle guard). */
function needsSync(agent: CompanyBrainAgent, scopeKey: string): boolean {
	ensureSyncTable(agent)
	const rows = agent.sql<{ synced_at: number }>`
		SELECT synced_at FROM brain_profile_sync WHERE scope_key = ${scopeKey}
	`
	const last = rows[0]?.synced_at
	return !last || Date.now() - last >= SYNC_INTERVAL_MS
}

/** Drop the profile-sync throttle so provisioning re-runs immediately on reset. */
export function clearBrainProfileSync(agent: CompanyBrainAgent): void {
	ensureSyncTable(agent)
	agent.sql`DELETE FROM brain_profile_sync`
}

function markSynced(agent: CompanyBrainAgent, scopeKey: string): void {
	ensureSyncTable(agent)
	agent.sql`
		INSERT INTO brain_profile_sync (scope_key, synced_at) VALUES (${scopeKey}, ${Date.now()})
		ON CONFLICT(scope_key) DO UPDATE SET synced_at = excluded.synced_at
	`
}

/**
 * Record what a container is about so every write into it carries that context.
 *
 * The hosted product owned the space row and could also set its display name,
 * visibility and profile buckets. The public API exposes none of those, but it
 * does take the entity context per document, which is the part that actually
 * shapes what gets remembered.
 */
async function upsertBrainSpaceConfig(
	_env: Env,
	params: {
		orgId: string
		ownerId: string | null
		containerTag: string
		name: string
		visibility: "public" | "private" | "unlisted"
		entityContext: string
		profileBuckets: ProfileBucketDef[]
		trackSlackManagedName?: boolean
	},
): Promise<void> {
	setContainerEntityContext(params.containerTag, params.entityContext)
}

export type BrainProfileSyncContext = {
	orgId: string
	orgName: string
	domain?: string | null
	about?: string | null
	installerUserId?: string | null
	/** The org member who sent the message, if resolved. */
	asker?: { userId: string; name?: string | null } | null
	/** Present when the turn happened in a private channel. */
	privateChannel?: { channelId: string; channelName?: string | null } | null
}

// Refreshes this turn's brain-tag config (entity context + buckets), throttled
// per scope. Best-effort — failures are captured, never thrown.
export async function maybeSyncBrainProfileConfig(
	agent: CompanyBrainAgent,
	ctx: BrainProfileSyncContext,
): Promise<void> {
	const env = brainAgent(agent).env
	const defaultSpaceOwnerId = ctx.installerUserId ?? ctx.asker?.userId ?? null

	// Shared Team Brain: enriched entity context + the standard memory buckets.
	// Buckets classify a memory's kind (preference/pattern/task); people/topic
	// routing is orthogonal and lives in memory_entry.metadata.sm_brain_tags.
	if (needsSync(agent, "shared")) {
		try {
			await upsertBrainSpaceConfig(env, {
				orgId: ctx.orgId,
				ownerId: defaultSpaceOwnerId,
				containerTag: SHARED_TEAM_BRAIN_CONTAINER_TAG,
				name: "Team Brain",
				visibility: "public",
				entityContext: buildBrainSharedEntityContext({
					orgName: ctx.orgName,
					domain: ctx.domain,
					about: ctx.about,
				}),
				profileBuckets: BRAIN_MEMORY_BUCKETS,
			})
			markSynced(agent, "shared")
		} catch (err) {
			captureException(err instanceof Error ? err : new Error(String(err)), {
				tags: { component: "brain-profile-sync", scope: "shared" },
			})
		}
	}

	if (needsSync(agent, "self")) {
		try {
			await upsertBrainSpaceConfig(env, {
				orgId: ctx.orgId,
				ownerId: defaultSpaceOwnerId,
				containerTag: AGENT_SELF_CONTAINER_TAG,
				name: "Agent Self",
				visibility: "unlisted",
				entityContext: buildBrainSelfEntityContext(),
				profileBuckets: BRAIN_SELF_BUCKETS,
			})
			markSynced(agent, "self")
		} catch (err) {
			captureException(err instanceof Error ? err : new Error(String(err)), {
				tags: { component: "brain-profile-sync", scope: "self" },
			})
		}
	}

	// Asker's personal DM tag: personal entity context + the standard buckets.
	if (ctx.asker?.userId) {
		const scopeKey = `user:${ctx.asker.userId}`
		if (needsSync(agent, scopeKey)) {
			try {
				await upsertBrainSpaceConfig(env, {
					orgId: ctx.orgId,
					ownerId: ctx.asker.userId,
					containerTag: privateContainerTagFor(ctx.asker.userId),
					name: "My Brain",
					visibility: "private",
					entityContext: buildBrainPersonalEntityContext({
						memberName: ctx.asker.name,
					}),
					profileBuckets: BRAIN_MEMORY_BUCKETS,
				})
				markSynced(agent, scopeKey)
			} catch (err) {
				captureException(err instanceof Error ? err : new Error(String(err)), {
					tags: { component: "brain-profile-sync", scope: "personal" },
				})
			}
		}
	}

	// Private channel: channel-scoped entity context + the standard buckets.
	if (ctx.privateChannel?.channelId) {
		const scopeKey = `channel:${ctx.privateChannel.channelId}`
		const containerTag = privateSlackChannelContainerTag(
			ctx.privateChannel.channelId,
		)
		const name = slackChannelSpaceName(
			ctx.privateChannel.channelId,
			ctx.privateChannel.channelName,
		)
		// Space display names were a hosted-product concern; there is nothing to
		// repair here, so a channel only does the profile refresh.
		const profileSyncNeeded = needsSync(agent, scopeKey)

		if (profileSyncNeeded) {
			try {
				await upsertBrainSpaceConfig(env, {
					orgId: ctx.orgId,
					ownerId: defaultSpaceOwnerId,
					containerTag,
					name,
					visibility: "private",
					entityContext: buildBrainPrivateChannelEntityContext({
						channelName: ctx.privateChannel.channelName,
					}),
					profileBuckets: BRAIN_MEMORY_BUCKETS,
					trackSlackManagedName: true,
				})
				markSynced(agent, scopeKey)
			} catch (err) {
				captureException(err instanceof Error ? err : new Error(String(err)), {
					tags: { component: "brain-profile-sync", scope: "private_channel" },
				})
			}
		}
	}
}
