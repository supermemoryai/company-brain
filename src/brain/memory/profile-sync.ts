import { and, db, eq, isNull, sql } from "@repo/db"
import type { ProfileBucketDef } from "@repo/db/schema/common"
import { space } from "@repo/db/schema/spaces"
import { captureException } from "@/lib/capture"
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

type ExistingBrainSpace = Pick<
	typeof space.$inferSelect,
	"id" | "name" | "metadata"
>

function existingNamePredicate(existing: ExistingBrainSpace) {
	return existing.name === null
		? isNull(space.name)
		: eq(space.name, existing.name)
}

function managedNamePredicate(existing: ExistingBrainSpace) {
	const managedName = slackManagedBrainSpaceName(existing.metadata)
	return managedName === undefined
		? sql`(${space.metadata}->>${SLACK_MANAGED_SPACE_NAME_METADATA_KEY}) IS NULL`
		: sql`${space.metadata}->>${SLACK_MANAGED_SPACE_NAME_METADATA_KEY} = ${managedName}`
}

function metadataObjectExpression() {
	return sql`CASE
		WHEN jsonb_typeof(COALESCE(${space.metadata}::jsonb, '{}'::jsonb)) = 'object'
		THEN COALESCE(${space.metadata}::jsonb, '{}'::jsonb)
		ELSE '{}'::jsonb
	END`
}

function metadataWithManagedName(name: string) {
	return sql`jsonb_set(
		${metadataObjectExpression()},
		ARRAY[${SLACK_MANAGED_SPACE_NAME_METADATA_KEY}]::text[],
		to_jsonb(${name}::text),
		true
	)::json`
}

function metadataWithoutManagedName() {
	return sql`(${metadataObjectExpression()} - ${SLACK_MANAGED_SPACE_NAME_METADATA_KEY}::text)::json`
}

async function reconcileBrainSpaceName(
	env: Env,
	params: {
		orgId: string
		containerTag: string
		name: string
		trackSlackManagedName?: boolean
	},
	selected?: ExistingBrainSpace,
): Promise<void> {
	let existing = selected
	if (!existing) {
		const [row] = await db(env)
			.select({ id: space.id, name: space.name, metadata: space.metadata })
			.from(space)
			.where(
				and(
					eq(space.orgId, params.orgId),
					eq(space.containerTag, params.containerTag),
				),
			)
			.limit(1)
		existing = row
	}
	if (!existing?.id) return

	const previousManagedName = slackManagedBrainSpaceName(existing.metadata)
	const shouldManageName = params.trackSlackManagedName
		? isSlackManagedBrainSpaceName({
				name: existing.name,
				containerTag: params.containerTag,
				desiredName: params.name,
				metadata: existing.metadata,
			})
		: isGeneratedBrainSpaceName(existing.name, params.containerTag, params.name)

	if (!shouldManageName) {
		// A name that differs from the last Slack-managed value is customized.
		// Clear provenance with a CAS so future channel renames cannot claim it.
		if (params.trackSlackManagedName && previousManagedName !== undefined) {
			await db(env)
				.update(space)
				.set({ metadata: metadataWithoutManagedName() })
				.where(
					and(
						eq(space.id, existing.id),
						existingNamePredicate(existing),
						managedNamePredicate(existing),
					),
				)
		}
		return
	}

	const shouldSetName = existing.name !== params.name
	const shouldSetManagedName =
		params.trackSlackManagedName && previousManagedName !== params.name
	if (!shouldSetName && !shouldSetManagedName) return

	await db(env)
		.update(space)
		.set({
			...(shouldSetName ? { name: params.name } : {}),
			...(shouldSetManagedName
				? { metadata: metadataWithManagedName(params.name) }
				: {}),
		})
		.where(
			and(
				eq(space.id, existing.id),
				existingNamePredicate(existing),
				...(params.trackSlackManagedName
					? [managedNamePredicate(existing)]
					: []),
			),
		)
}

// Upserts a brain-owned space's config, creating the space row if
// ingestion/provisioning hasn't yet. Config refresh is independent from the
// compare-and-swap name reconciliation so concurrent custom renames win.
async function upsertBrainSpaceConfig(
	env: Env,
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
	const [existing] = await db(env)
		.select({ id: space.id, name: space.name, metadata: space.metadata })
		.from(space)
		.where(
			and(
				eq(space.orgId, params.orgId),
				eq(space.containerTag, params.containerTag),
			),
		)
		.limit(1)

	if (existing?.id) {
		await db(env)
			.update(space)
			.set({
				entityContext: params.entityContext,
				profileBuckets: params.profileBuckets,
			})
			.where(eq(space.id, existing.id))
		await reconcileBrainSpaceName(env, params, existing)
		return
	}

	await db(env)
		.insert(space)
		.values({
			orgId: params.orgId,
			ownerId: params.ownerId,
			containerTag: params.containerTag,
			name: params.name,
			visibility: params.visibility,
			entityContext: params.entityContext,
			profileBuckets: params.profileBuckets,
			...(params.trackSlackManagedName
				? {
						metadata: {
							[SLACK_MANAGED_SPACE_NAME_METADATA_KEY]: params.name,
						},
					}
				: {}),
		})
		.onConflictDoNothing()
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
		const profileSyncNeeded = needsSync(agent, scopeKey)

		// Display-name repair is cheap and independent from the heavier profile
		// refresh. This lets legacy/generated names heal on the next channel turn.
		if (!profileSyncNeeded) {
			try {
				await reconcileBrainSpaceName(env, {
					orgId: ctx.orgId,
					containerTag,
					name,
					trackSlackManagedName: true,
				})
			} catch (err) {
				captureException(err instanceof Error ? err : new Error(String(err)), {
					tags: {
						component: "brain-profile-sync",
						scope: "private_channel_name",
					},
				})
			}
		}

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
