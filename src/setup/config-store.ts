import { db, deploymentConfig, eq } from "@repo/db"
import { decryptToken, encryptToken } from "@/lib/crypto"
import { encryptionSecret } from "./secrets"

export type SlackCredentials = {
	clientId: string
	clientSecret: string
	signingSecret: string
}

const SLACK_KEYS = {
	clientId: "slack_client_id",
	clientSecret: "slack_client_secret",
	signingSecret: "slack_signing_secret",
} as const

const cache = new WeakMap<object, SlackCredentials | null>()

/**
 * Slack credentials, from Workers secrets when present, otherwise from what the
 * setup wizard stored. Cached per Env so the Slack event path stays one query.
 */
export async function slackCredentials(
	env: Env,
): Promise<SlackCredentials | null> {
	if (env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.SLACK_SIGNING_SECRET) {
		return {
			clientId: env.SLACK_CLIENT_ID,
			clientSecret: env.SLACK_CLIENT_SECRET,
			signingSecret: env.SLACK_SIGNING_SECRET,
		}
	}
	const cached = cache.get(env as unknown as object)
	if (cached !== undefined) return cached

	const rows = await db(env)
		.select()
		.from(deploymentConfig)
		.where(eq(deploymentConfig.key, SLACK_KEYS.clientId))
		.union(
			db(env)
				.select()
				.from(deploymentConfig)
				.where(eq(deploymentConfig.key, SLACK_KEYS.clientSecret)),
		)
		.union(
			db(env)
				.select()
				.from(deploymentConfig)
				.where(eq(deploymentConfig.key, SLACK_KEYS.signingSecret)),
		)

	const byKey = new Map(rows.map((row) => [row.key, row]))
	const clientId = byKey.get(SLACK_KEYS.clientId)?.value
	const clientSecretRow = byKey.get(SLACK_KEYS.clientSecret)
	const signingSecretRow = byKey.get(SLACK_KEYS.signingSecret)
	if (!clientId || !clientSecretRow || !signingSecretRow) {
		cache.set(env as unknown as object, null)
		return null
	}

	const secret = await encryptionSecret(env)
	const credentials: SlackCredentials = {
		clientId,
		clientSecret: await decryptToken(clientSecretRow.value, secret),
		signingSecret: await decryptToken(signingSecretRow.value, secret),
	}
	cache.set(env as unknown as object, credentials)
	return credentials
}

export async function storeSlackCredentials(
	env: Env,
	credentials: SlackCredentials,
): Promise<void> {
	const secret = await encryptionSecret(env)
	const rows = [
		{ key: SLACK_KEYS.clientId, value: credentials.clientId, encrypted: false },
		{
			key: SLACK_KEYS.clientSecret,
			value: await encryptToken(credentials.clientSecret, secret),
			encrypted: true,
		},
		{
			key: SLACK_KEYS.signingSecret,
			value: await encryptToken(credentials.signingSecret, secret),
			encrypted: true,
		},
	]
	for (const row of rows) {
		await db(env)
			.insert(deploymentConfig)
			.values(row)
			.onConflictDoUpdate({
				target: deploymentConfig.key,
				set: { value: row.value, updatedAt: new Date() },
			})
	}
	cache.delete(env as unknown as object)
}
