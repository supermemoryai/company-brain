import { db, eq } from "@repo/db"
import { organization, user } from "@repo/db/schema"
import { getConfig } from "@/config"
import { LIFECYCLE_UNSUBSCRIBE_GROUP_ID } from "@/lib/cron/lifecycle-triggers/shared"
import { renderCompanyBrainWelcomeEmail } from "@/lib/render-lifecycle"
import { parseEmailAddress, sendEmail } from "@/services/email/autosend"

export const COMPANY_BRAIN_BOOK_CALL_URL =
	"https://cal.com/team/supermemory/company-brain"

/** Throws on send failure; the webhook reports it and moves on. */
export async function sendCompanyBrainWelcomeEmail(
	env: Env,
	params: { orgId: string; userId: string },
): Promise<void> {
	const apiKey = env.AUTOSEND_API_KEY
	if (!getConfig().features.email || !apiKey) return

	const [[recipient], [org]] = await Promise.all([
		db(env)
			.select({ email: user.email, name: user.name })
			.from(user)
			.where(eq(user.id, params.userId))
			.limit(1),
		db(env)
			.select({ name: organization.name })
			.from(organization)
			.where(eq(organization.id, params.orgId))
			.limit(1),
	])
	if (!recipient?.email) return

	const base = (env.CONSUMER_APP_URL ?? "https://app.supermemory.ai").replace(
		/\/$/,
		"",
	)

	await sendEmail(apiKey, {
		from: parseEmailAddress(
			"Dhravya from supermemory <dhravya@team.supermemory.ai>",
		),
		to: { email: recipient.email },
		subject: "Your Company Brain is ready",
		html: renderCompanyBrainWelcomeEmail({
			displayName: recipient.name,
			orgName: org?.name ?? "",
			brainUrl: base,
			bookCallUrl: COMPANY_BRAIN_BOOK_CALL_URL,
		}),
		replyTo: { email: "support@supermemory.com" },
		unsubscribeGroupId: LIFECYCLE_UNSUBSCRIBE_GROUP_ID,
		// Autumn retries the webhook; keep a retry from mailing twice.
		idempotencyKey: `cb-welcome:${params.orgId}`,
	})
}
