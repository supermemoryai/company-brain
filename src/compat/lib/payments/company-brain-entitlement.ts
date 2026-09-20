/**
 * The hosted brain checked a paid entitlement before every turn. A self-hosted
 * deployment pays its own model and memory bills, so the answer is always yes.
 */
export type CompanyBrainEntitlement = {
	allowed: boolean
	reason: string | null
}

export async function getCompanyBrainEntitlement(
	_env: Env,
	_orgId: string,
	_defer?: (promise: Promise<unknown>) => void,
): Promise<CompanyBrainEntitlement> {
	return { allowed: true, reason: null }
}

export async function orgCanRunCompanyBrain(): Promise<boolean> {
	return true
}

export function companyBrainDenialMessage(
	_reason?: string | null,
	_env?: Env,
	_activateUrl?: string,
): string {
	return "The brain is not available right now."
}
