export const LAZY_TOOL_FAMILIES = ["sandbox", "scheduler"] as const

export type LazyToolFamily = (typeof LAZY_TOOL_FAMILIES)[number]

export type LazyToolUnlockResult = {
	family: LazyToolFamily
	status: "enabled" | "already_enabled" | "unavailable"
	tools: string[]
}

export type LazyToolState = {
	unlock: (families: LazyToolFamily[]) => LazyToolUnlockResult[]
	activeToolNames: (allToolNames: string[]) => string[]
	enabledFamilies: () => LazyToolFamily[]
	availableFamilies: () => LazyToolFamily[]
	isEnabled: (family: LazyToolFamily) => boolean
}

/**
 * Keeps optional typed tools server-side until the model explicitly asks for a
 * family. AI SDK activeTools then exposes the unlocked schemas on the next step.
 */
export function createLazyToolState(
	definitions: Partial<Record<LazyToolFamily, string[]>>,
	initiallyEnabled: Iterable<LazyToolFamily> = [],
): LazyToolState {
	const toolsByFamily = new Map<LazyToolFamily, string[]>()
	for (const family of LAZY_TOOL_FAMILIES) {
		toolsByFamily.set(family, [...new Set(definitions[family] ?? [])])
	}
	const optionalToolNames = new Set([...toolsByFamily.values()].flat())
	const enabled = new Set<LazyToolFamily>(
		[...initiallyEnabled].filter(
			(family) => (toolsByFamily.get(family)?.length ?? 0) > 0,
		),
	)

	return {
		unlock(families) {
			return [...new Set(families)].map((family) => {
				const names = toolsByFamily.get(family) ?? []
				if (!names.length) {
					return { family, status: "unavailable" as const, tools: [] }
				}
				if (enabled.has(family)) {
					return {
						family,
						status: "already_enabled" as const,
						tools: names,
					}
				}
				enabled.add(family)
				return { family, status: "enabled" as const, tools: names }
			})
		},
		activeToolNames(allToolNames) {
			const activeOptionalNames = new Set(
				[...enabled].flatMap((family) => toolsByFamily.get(family) ?? []),
			)
			return allToolNames.filter(
				(name) => !optionalToolNames.has(name) || activeOptionalNames.has(name),
			)
		},
		enabledFamilies: () => [...enabled],
		availableFamilies: () =>
			LAZY_TOOL_FAMILIES.filter(
				(family) => (toolsByFamily.get(family)?.length ?? 0) > 0,
			),
		isEnabled: (family) => enabled.has(family),
	}
}
