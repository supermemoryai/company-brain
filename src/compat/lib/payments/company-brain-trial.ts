/** Trial machinery from the hosted product; self-hosted has no trial. */
export const COMPANY_BRAIN_TRIAL_REMINDER_DAYS: number[] = []

export async function shouldSendBrainTrialReminder(): Promise<boolean> {
	return false
}

export async function markBrainTrialReminderSent(): Promise<void> {}

export {
	companyBrainDenialMessage,
	getCompanyBrainEntitlement,
	orgCanRunCompanyBrain,
} from "./company-brain-entitlement"
