import { preservedInternalMetadataKeys } from "./product-policy"

export const BRAIN_TAGS_METADATA_KEY = "sm_brain_tags"
export const BRAIN_TAG_LABELS_METADATA_KEY = "sm_brain_tag_labels"

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
