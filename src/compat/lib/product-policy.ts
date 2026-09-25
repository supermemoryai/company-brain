/** Metadata keys the brain owns; never stripped from a document on update. */
export const preservedInternalMetadataKeys = new Set([
	"brain_tags",
	"brain_tag_labels",
])
