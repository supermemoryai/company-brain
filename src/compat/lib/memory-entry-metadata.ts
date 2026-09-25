import { preservedInternalMetadataKeys } from "./product-policy"

// supermemory reserves the sm_ prefix and drops those keys from API writes, so
// the brain's own keys go without it.
export const BRAIN_TAGS_METADATA_KEY = "brain_tags"
export const BRAIN_TAG_LABELS_METADATA_KEY = "brain_tag_labels"

export function filterMemoryEntryMetadata(
	metadata: Record<string, unknown> | null | undefined,
	preserveBrainTags = false,
): Record<string, unknown> {
	const result: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(metadata ?? {})) {
		if (
			!key.startsWith("sm_") ||
			(preserveBrainTags && preservedInternalMetadataKeys.has(key))
		) {
			result[key] = value
		}
	}
	return result
}
