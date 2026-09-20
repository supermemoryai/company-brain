/**
 * The hosted brain used better-auth sessions. A self-hosted brain has no login:
 * Slack requests are verified by signature and the console by setup token.
 */
export const auth = {
	api: {
		getSession: async (): Promise<null> => null,
	},
}
