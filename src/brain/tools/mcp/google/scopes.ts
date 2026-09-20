export const GOOGLE_IDENTITY_SCOPES = [
	"openid",
	"https://www.googleapis.com/auth/userinfo.email",
] as const

export const GMAIL_READONLY_SCOPE =
	"https://www.googleapis.com/auth/gmail.readonly"
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"
export const GMAIL_SEND_ENABLED = false

export const GMAIL_SCOPES = [
	GMAIL_READONLY_SCOPE,
	...(GMAIL_SEND_ENABLED ? [GMAIL_SEND_SCOPE] : []),
]

export const GMAIL_METADATA_SCOPE =
	"https://www.googleapis.com/auth/gmail.metadata"

const EXCLUDED_GMAIL_SCOPES = new Set([
	GMAIL_METADATA_SCOPE,
	...(!GMAIL_SEND_ENABLED ? [GMAIL_SEND_SCOPE] : []),
])

export const GMAIL_REQUIRED_SCOPES = [
	...GOOGLE_IDENTITY_SCOPES,
	...GMAIL_SCOPES,
]

export function hasRequiredGmailScopes(scopes: readonly string[]): boolean {
	const granted = new Set(scopes)
	return (
		GMAIL_SCOPES.every((scope) => granted.has(scope)) &&
		!granted.has(GMAIL_METADATA_SCOPE)
	)
}

export function mergeGmailScopes(scopes: readonly string[] = []): string[] {
	return [
		...new Set([
			...scopes.filter((scope) => !EXCLUDED_GMAIL_SCOPES.has(scope)),
			...GMAIL_REQUIRED_SCOPES,
		]),
	]
}
