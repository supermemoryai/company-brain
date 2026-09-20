/**
 * What a container is about, in the brain's own words.
 *
 * The hosted product stored this on the space row and supermemory read it when
 * extracting memories. The public API takes the same thing per document
 * (`entityContext` on an add), so the brain keeps the current text here and
 * every write carries it.
 */
const byContainerTag = new Map<string, string>()

export function setContainerEntityContext(
	containerTag: string,
	entityContext: string,
): void {
	const trimmed = entityContext.trim()
	if (!trimmed) return
	byContainerTag.set(containerTag, trimmed)
}

export function getContainerEntityContext(
	containerTag: string | undefined,
): string | undefined {
	return containerTag ? byContainerTag.get(containerTag) : undefined
}

export function clearContainerEntityContexts(): void {
	byContainerTag.clear()
}
