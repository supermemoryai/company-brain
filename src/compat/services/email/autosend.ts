/**
 * The hosted brain sent lifecycle email through Autosend. Self-hosted
 * deployments have no mail provider wired up, so these are inert.
 */
export function parseEmailAddress(
	value: string,
): { email: string; name?: string } | null {
	const trimmed = value.trim()
	if (!trimmed.includes("@")) return null
	return { email: trimmed }
}

export async function sendEmail(..._args: unknown[]): Promise<void> {}
