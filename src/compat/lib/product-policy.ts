/** Metadata keys the brain owns; never stripped from a document on update. */
export const preservedInternalMetadataKeys = new Set([
	"sm_brain_tags",
	"sm_brain_tag_labels",
])
