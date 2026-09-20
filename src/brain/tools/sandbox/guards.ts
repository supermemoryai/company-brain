const DEFAULT_TIMEOUT_SEC = 30
const MAX_TIMEOUT_SEC = 120
const MAX_OUTPUT_CHARS = 50_000
const MAX_TEXT_FILE_CHARS = 80_000
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024

const PRIVATE_172_REGEX = /^172\.(1[6-9]|2\d|3[01])\./

const BLOCKED_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{
		pattern: /\bgit\s+push\b/i,
		reason: "Pushing changes is not available in V1.",
	},
	{
		pattern: /\b(?:wrangler|vercel|netlify|firebase)\s+deploy\b/i,
		reason: "Deploy commands are not available in V1.",
	},
	{
		pattern: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sh|bash|zsh|fish)\b/i,
		reason: "Piping downloaded scripts into a shell is blocked.",
	},
	{
		pattern: /\brm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)\s+\/(?:\s|$)/i,
		reason: "Destructive root removal is blocked.",
	},
	{
		pattern: /\bsudo\b/i,
		reason: "sudo is not available in the sandbox tools.",
	},
	{
		pattern: /\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:dev|start)\b/i,
		reason: "Long-running dev servers are not available in V1.",
	},
	{
		pattern: /\b(?:next|vite|astro|nuxt)\s+dev\b/i,
		reason: "Long-running dev servers are not available in V1.",
	},
	{
		pattern: /\bpython(?:3)?\s+-m\s+http\.server\b/i,
		reason: "Long-running HTTP servers are not available in V1.",
	},
]

function isPrivateIpv4(hostname: string): boolean {
	if (hostname === "0.0.0.0") return true
	if (hostname.startsWith("127.")) return true
	if (hostname.startsWith("10.")) return true
	if (hostname.startsWith("192.168.")) return true
	if (hostname.startsWith("169.254.")) return true
	if (PRIVATE_172_REGEX.test(hostname)) return true
	const parts = hostname.split(".")
	if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part))) {
		return false
	}
	const [first, second] = parts.map((part) => Number(part))
	return (
		first === 0 ||
		first === 127 ||
		first === undefined ||
		(second !== undefined && first === 100 && second >= 64 && second <= 127) ||
		first >= 224
	)
}

function isPrivateIpv6(hostname: string): boolean {
	const host = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase()
	return (
		host === "::" ||
		host === "::1" ||
		host.startsWith("fc") ||
		host.startsWith("fd") ||
		host.startsWith("fe80:")
	)
}

function isUnsafeHost(hostname: string): boolean {
	const host = hostname.toLowerCase()
	return (
		host === "localhost" ||
		host === "metadata" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal") ||
		isPrivateIpv4(host) ||
		isPrivateIpv6(host)
	)
}

export function validateRepoUrl(
	repoUrl: string,
): { ok: true; url: string } | { ok: false; error: string } {
	let url: URL
	try {
		url = new URL(repoUrl)
	} catch {
		return { ok: false, error: "Enter a valid repository URL." }
	}
	if (url.protocol !== "https:") {
		return { ok: false, error: "Repository URL must use https." }
	}
	if (url.username || url.password) {
		return { ok: false, error: "Repository URL must not include credentials." }
	}
	if (isUnsafeHost(url.hostname)) {
		return { ok: false, error: "Repository URL must use a public host." }
	}
	url.hash = ""
	return { ok: true, url: url.toString() }
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`
}

export function safeRepoDir(repoUrl: string): string {
	try {
		const url = new URL(repoUrl)
		const last = url.pathname.split("/").filter(Boolean).at(-1) ?? "repo"
		const name = last.replace(/\.git$/i, "").replace(/[^a-zA-Z0-9_.-]+/g, "-")
		return name ? `workspace/${name}` : "workspace/repo"
	} catch {
		return "workspace/repo"
	}
}

export function normalizeCwd(
	cwd: string | undefined,
	fallback: string,
): string {
	const value = (cwd?.trim() || fallback).replaceAll("\\", "/")
	if (value.includes("\0")) return fallback
	if (value.startsWith("~")) return fallback
	if (value.length > 300) return fallback
	const parts = value.split("/").filter(Boolean)
	if (parts.includes("..")) return fallback
	return value || fallback
}

export function normalizePath(
	path: string | undefined,
	fallback: string,
): string {
	const value = (path?.trim() || fallback).replaceAll("\\", "/")
	if (value.includes("\0")) return fallback
	if (value.length > 500) return fallback
	const parts = value.split("/").filter(Boolean)
	if (parts.includes("..")) return fallback
	return value || fallback
}

export function normalizeTimeout(timeoutSec?: number): number {
	if (!Number.isFinite(timeoutSec)) return DEFAULT_TIMEOUT_SEC
	if (timeoutSec === undefined) return DEFAULT_TIMEOUT_SEC
	return Math.max(1, Math.min(MAX_TIMEOUT_SEC, Math.floor(timeoutSec)))
}

export function validateCommand(
	command: string,
): { ok: true; command: string } | { ok: false; error: string } {
	const trimmed = command.trim()
	if (!trimmed) return { ok: false, error: "Command is required." }
	if (trimmed.length > 2000) {
		return { ok: false, error: "Command is too long." }
	}
	for (const blocked of BLOCKED_COMMAND_PATTERNS) {
		if (blocked.pattern.test(trimmed))
			return { ok: false, error: blocked.reason }
	}
	return { ok: true, command: trimmed }
}

export function truncateText(
	value: string,
	max = MAX_OUTPUT_CHARS,
): {
	text: string
	truncated: boolean
} {
	if (value.length <= max) return { text: value, truncated: false }
	return { text: `${value.slice(0, max)}\n...[truncated]`, truncated: true }
}

export const sandboxLimits = {
	maxOutputChars: MAX_OUTPUT_CHARS,
	maxTextFileChars: MAX_TEXT_FILE_CHARS,
	maxArtifactBytes: MAX_ARTIFACT_BYTES,
	defaultTimeoutSec: DEFAULT_TIMEOUT_SEC,
	maxTimeoutSec: MAX_TIMEOUT_SEC,
}
