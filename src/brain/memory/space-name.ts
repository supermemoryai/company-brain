const SLACK_CHANNEL_CONTAINER_TAG_PREFIX = "slack_channel_"
const SLACK_CHANNEL_SPACE_NAME_PREFIX = "slack_"
export const SLACK_MANAGED_SPACE_NAME_METADATA_KEY =
	"sm_internal_slack_managed_space_name"

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function slackChannelSpaceName(
	channelId: string,
	channelName?: string | null,
): string {
	return `${SLACK_CHANNEL_SPACE_NAME_PREFIX}${channelName?.trim() || channelId}`
}

export function isGeneratedBrainSpaceName(
	name: string | null,
	containerTag: string,
	desiredName?: string,
): boolean {
	const normalizedName = name?.trim()
	if (!normalizedName) return true
	if (
		normalizedName === containerTag ||
		normalizedName === `Space ${containerTag}`
	) {
		return true
	}

	if (!containerTag.startsWith(SLACK_CHANNEL_CONTAINER_TAG_PREFIX)) {
		return false
	}

	const channelId = containerTag.slice(
		SLACK_CHANNEL_CONTAINER_TAG_PREFIX.length,
	)
	if (
		normalizedName === channelId ||
		normalizedName === `#${channelId}` ||
		normalizedName === `${SLACK_CHANNEL_SPACE_NAME_PREFIX}${channelId}`
	) {
		return true
	}

	// Recognize the display name emitted by the short-lived `#channel-name`
	// convention so it can migrate to `slack_channel-name` on the next sync.
	if (desiredName?.startsWith(SLACK_CHANNEL_SPACE_NAME_PREFIX)) {
		const channelName = desiredName.slice(
			SLACK_CHANNEL_SPACE_NAME_PREFIX.length,
		)
		return normalizedName === `#${channelName}`
	}

	return false
}

export function slackManagedBrainSpaceName(
	metadata: unknown,
): string | undefined {
	if (!isRecord(metadata)) return undefined
	const managedName = metadata[SLACK_MANAGED_SPACE_NAME_METADATA_KEY]
	return typeof managedName === "string" && managedName
		? managedName
		: undefined
}

export function isSlackManagedBrainSpaceName(params: {
	name: string | null
	containerTag: string
	desiredName: string
	metadata: unknown
}): boolean {
	const managedName = slackManagedBrainSpaceName(params.metadata)
	if (managedName !== undefined) return params.name === managedName

	// Seed provenance for rows created before the marker existed, including a
	// row already using the current generated display name.
	return (
		params.name === params.desiredName ||
		isGeneratedBrainSpaceName(
			params.name,
			params.containerTag,
			params.desiredName,
		)
	)
}
