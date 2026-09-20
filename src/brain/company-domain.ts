// Shared between install bootstrap and the update_configuration tool. No imports.

const FREE_EMAIL_DOMAINS = new Set([
	"gmail.com",
	"googlemail.com",
	"yahoo.com",
	"outlook.com",
	"hotmail.com",
	"live.com",
	"icloud.com",
	"me.com",
	"aol.com",
	"protonmail.com",
	"proton.me",
	"fastmail.com",
	"zoho.com",
	"yandex.com",
	"mail.com",
	"qq.com",
	"163.com",
	"naver.com",
])

/** A real company domain, or null for empty and free-mail domains. */
export function companyDomain(
	domain: string | null | undefined,
): string | null {
	const clean = domain?.trim().toLowerCase()
	if (!clean || FREE_EMAIL_DOMAINS.has(clean)) return null
	return clean
}

/** User-supplied text ("https://www.acme.com/about") down to a bare domain. */
export function normalizeCompanyDomain(value: string): string | null {
	const host = value
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/^www\./, "")
		.replace(/[/?#].*$/, "")
	// Drives research and locks once confirmed, so reject acme..com and foo.-bar.com.
	const labels = host.split(".")
	if (labels.length < 2) return null
	if (!labels.every((label) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))) {
		return null
	}
	if (!/^[a-z]{2,}$/.test(labels[labels.length - 1] ?? "")) return null
	return companyDomain(host)
}
