import { renderEmailTemplate } from "@/lib/email-templates"

function displayNameOrThere(name: string | null | undefined): string {
	return name?.trim() || "there"
}

function formatUsd(n: number): string {
	return Math.max(0, n).toFixed(2)
}

function usagePercentLabel(usage: number, limit: number): string {
	if (limit <= 0) return "0"
	return String(Math.min(100, Math.round((usage / limit) * 100)))
}

export type LifecycleCreditsEmailInput = {
	displayName: string | null | undefined
	usageUsd: number
	includedUsd: number
	orgName: string
}

export type LifecycleBillingPeriodEndingEmailInput = {
	displayName: string | null | undefined
	orgName: string
	currentPlan: string
	targetPlan: string
	switchDate: string
}

function creditsVariables(input: LifecycleCreditsEmailInput) {
	const usage = Math.max(0, input.usageUsd)
	const limit = Math.max(0, input.includedUsd)
	const remaining = Math.max(0, limit - usage)
	return {
		FIRST_NAME: displayNameOrThere(input.displayName),
		ORG_NAME: input.orgName.trim() || "Your organization",
		USAGE_USD: formatUsd(usage),
		INCLUDED_USD: formatUsd(limit),
		REMAINING_USD: formatUsd(remaining),
		USAGE_PERCENT: usagePercentLabel(usage, limit),
	}
}

export type CompanyBrainWelcomeEmailInput = {
	displayName: string | null | undefined
	orgName: string
	brainUrl: string
	bookCallUrl: string
}

export function renderCompanyBrainWelcomeEmail(
	input: CompanyBrainWelcomeEmailInput,
): string {
	return renderEmailTemplate("lifecycle/company-brain/welcome", {
		FIRST_NAME: displayNameOrThere(input.displayName),
		ORG_NAME: input.orgName.trim() || "your team",
		BRAIN_URL: input.brainUrl,
		BOOK_CALL_URL: input.bookCallUrl,
	})
}

export function renderLifecycleNoConnectorsEmail(
	displayName: string | null | undefined,
): string {
	return renderEmailTemplate("lifecycle/no-connectors", {
		FIRST_NAME: displayNameOrThere(displayName),
	})
}

export function renderLifecycleBillingPeriodEndingEmail(
	input: LifecycleBillingPeriodEndingEmailInput,
): string {
	return renderEmailTemplate("lifecycle/billing-period-ending", {
		FIRST_NAME: displayNameOrThere(input.displayName),
		ORG_NAME: input.orgName.trim() || "Your organization",
		CURRENT_PLAN: input.currentPlan,
		TARGET_PLAN: input.targetPlan,
		SWITCH_DATE: input.switchDate,
	})
}

export function renderLifecycleCreditsLow50Email(
	input: LifecycleCreditsEmailInput,
): string {
	return renderEmailTemplate(
		"lifecycle/credits-low-50",
		creditsVariables(input),
	)
}

export function renderLifecycleCreditsLow80Email(
	input: LifecycleCreditsEmailInput,
): string {
	return renderEmailTemplate(
		"lifecycle/credits-low-80",
		creditsVariables(input),
	)
}

export function renderLifecycleCreditsLow100Email(
	input: LifecycleCreditsEmailInput,
): string {
	return renderEmailTemplate(
		"lifecycle/credits-low-100",
		creditsVariables(input),
	)
}
