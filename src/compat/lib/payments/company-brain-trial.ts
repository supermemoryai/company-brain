/** Trial machinery from the hosted product; a self-hosted brain has no trial. */
export {
	companyBrainDenialMessage,
	getCompanyBrainEntitlement,
	orgCanRunCompanyBrain,
} from "./company-brain-entitlement"

/** Upsell link on a denial. Self-hosted denials carry no link. */
export function companyBrainActivateUrl(_env: Env): string {
	return ""
}
