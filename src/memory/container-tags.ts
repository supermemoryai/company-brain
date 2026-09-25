import type { ProfileBucketDef } from "@repo/db/schema/common"
import { memoryClient } from "./client"

export type ContainerTagSettings = {
	containerTag: string
	name: string | null
	entityContext: string | null
	profileBuckets: ProfileBucketDef[]
}

/** A container tag's settings, or null before anything has created it. */
export async function getContainerTagSettings(
	env: Env,
	containerTag: string,
): Promise<ContainerTagSettings | null> {
	try {
		return await memoryClient(env).get<ContainerTagSettings>(
			`/v3/container-tags/${encodeURIComponent(containerTag)}`,
		)
	} catch (error) {
		if ((error as { status?: number }).status === 404) return null
		throw error
	}
}

/**
 * Set a container tag's display name, entity context and profile buckets.
 * supermemory reads the context and buckets whenever it extracts memories from
 * a document in this container. Creates the tag if it doesn't exist yet.
 */
export async function updateContainerTagSettings(
	env: Env,
	containerTag: string,
	settings: {
		name?: string
		entityContext?: string
		profileBuckets?: ProfileBucketDef[]
	},
): Promise<void> {
	await memoryClient(env).patch(
		`/v3/container-tags/${encodeURIComponent(containerTag)}`,
		{ body: settings },
	)
}
