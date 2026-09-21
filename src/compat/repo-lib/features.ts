export type BrainOrgLike = { id?: string; metadata?: unknown } | null | undefined

/**
 * In the hosted product this gated the brain behind a paid add-on. A
 * self-hosted deployment exists to run the brain, so every org has it.
 */
export function isCompanyBrainOrg(_org?: BrainOrgLike): boolean {
	return true
}
