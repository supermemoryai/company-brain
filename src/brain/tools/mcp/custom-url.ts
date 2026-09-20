import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js"

export type CustomMcpServerUrlValidation =
	| { ok: true; normalizedUrl: string }
	| { ok: false; error: string }

const RFC1918_172_REGEX = /^172\.(1[6-9]|2\d|3[01])\./
const DECIMAL_OCTET_REGEX = /^\d+$/
const MAX_CUSTOM_MCP_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function isPrivateIpv4(hostname: string): boolean {
	if (hostname === "0.0.0.0") return true
	if (hostname.startsWith("127.")) return true
	if (hostname.startsWith("10.")) return true
	if (hostname.startsWith("192.168.")) return true
	if (hostname.startsWith("169.254.")) return true
	if (RFC1918_172_REGEX.test(hostname)) return true

	const octets = hostname.split(".")
	if (octets.length !== 4) return false
	if (!octets.every((octet) => DECIMAL_OCTET_REGEX.test(octet))) return false
	const parsed = octets.map((octet) => Number(octet))
	if (
		parsed.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
	) {
		return true
	}
	const [first] = parsed
	if (first === undefined) return true
	const second = parsed[1]
	return (
		first === 0 ||
		(first === 100 && second !== undefined && second >= 64 && second <= 127) ||
		(first === 198 && (second === 18 || second === 19)) ||
		first >= 224
	)
}

function ipv4FromMappedIpv6(rest: string): string | undefined {
	if (rest.includes(".")) return rest
	const hextets = rest.split(":").filter(Boolean)
	if (hextets.length !== 2) return undefined
	const [highRaw, lowRaw] = hextets
	const high = Number.parseInt(highRaw ?? "", 16)
	const low = Number.parseInt(lowRaw ?? "", 16)
	if (
		!Number.isInteger(high) ||
		!Number.isInteger(low) ||
		high < 0 ||
		high > 0xffff ||
		low < 0 ||
		low > 0xffff
	) {
		return undefined
	}
	return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

function isPrivateIpv6(hostname: string): boolean {
	const lower =
		hostname.startsWith("[") && hostname.endsWith("]")
			? hostname.slice(1, -1).toLowerCase()
			: hostname.toLowerCase()
	if (lower === "::" || lower === "::1" || lower === "0:0:0:0:0:0:0:1")
		return true
	if (lower.startsWith("::ffff:")) {
		const mappedIpv4 = ipv4FromMappedIpv6(lower.slice("::ffff:".length))
		return mappedIpv4 ? isPrivateIpv4(mappedIpv4) : true
	}
	const firstHextet = lower.split(":")[0] ?? ""
	if (/^f[cd][0-9a-f]{0,2}$/.test(firstHextet)) return true
	if (firstHextet === "fe80" || /^fe[89ab][0-9a-f]?$/.test(firstHextet))
		return true
	return false
}

function isUnsafeCustomMcpHost(hostname: string): boolean {
	const host = hostname.toLowerCase()
	return (
		host === "localhost" ||
		host === "metadata" ||
		host === "metadata.google.internal" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal") ||
		isPrivateIpv4(host) ||
		isPrivateIpv6(host)
	)
}

export function validateCustomMcpServerUrl(
	serverUrl: string,
	env: Pick<Env, "NODE_ENV">,
): CustomMcpServerUrlValidation {
	const url = (() => {
		try {
			return new URL(serverUrl)
		} catch {
			return null
		}
	})()
	if (!url) {
		return { ok: false, error: "Enter a valid MCP server URL." }
	}

	return validateCustomMcpUrlObject(url, env)
}

function validateCustomMcpUrlObject(
	url: URL,
	env: Pick<Env, "NODE_ENV">,
): CustomMcpServerUrlValidation {
	const normalized = new URL(url)

	if (normalized.protocol !== "https:" && normalized.protocol !== "http:") {
		return { ok: false, error: "MCP server URL must use http or https." }
	}
	if (normalized.username || normalized.password) {
		return { ok: false, error: "MCP server URL must not include credentials." }
	}
	if (env.NODE_ENV !== "development" && normalized.protocol !== "https:") {
		return { ok: false, error: "MCP server URL must use https." }
	}
	if (isUnsafeCustomMcpHost(normalized.hostname)) {
		return { ok: false, error: "MCP server URL must use a public host." }
	}

	normalized.hash = ""
	return { ok: true, normalizedUrl: normalized.toString() }
}

export function createCustomMcpFetch(env: Pick<Env, "NODE_ENV">): FetchLike {
	return async (url, init) => {
		let currentUrl = new URL(url.toString())
		let currentInit: RequestInit | undefined = init

		for (
			let redirects = 0;
			redirects <= MAX_CUSTOM_MCP_REDIRECTS;
			redirects++
		) {
			const validated = validateCustomMcpUrlObject(currentUrl, env)
			if (!validated.ok) {
				throw new Error("blocked unsafe MCP OAuth URL", {
					cause: validated.error,
				})
			}

			const response = await fetch(currentUrl, {
				...currentInit,
				redirect: "manual",
			})
			if (!REDIRECT_STATUSES.has(response.status)) return response

			const location = response.headers.get("location")
			if (!location) return response
			const nextUrl = new URL(location, currentUrl)
			const nextValidated = validateCustomMcpUrlObject(nextUrl, env)
			if (!nextValidated.ok) {
				throw new Error("blocked unsafe MCP OAuth redirect", {
					cause: nextValidated.error,
				})
			}

			currentUrl = nextUrl
			if (response.status === 303) {
				currentInit = {
					...currentInit,
					body: undefined,
					method: "GET",
				}
			}
		}

		throw new Error("blocked MCP OAuth redirect loop.")
	}
}
