import { decryptToken } from "@/lib/crypto"
import { cleanMention } from "../prompt/build"
import {
	buildSlackBotIdentity,
	getSlackUserInfo,
	type SlackBotIdentity,
} from "./client"

const PRODUCT_ALIASES = [
	"supermemory",
	"company brain",
	"company-brain",
] as const
const ALIAS_CACHE_TTL_SECONDS = 60 * 60 * 24
const DIRECT_GREETING_PREFIX =
	"(?:(?:hey|hi|hello|yo)(?:\\s+there)?[\\s,!:;-]+)?"

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function collectBotAddressAliases(bot: SlackBotIdentity): string[] {
	const out = new Set<string>(PRODUCT_ALIASES)
	const add = (value: string | undefined) => {
		const trimmed = value?.trim().toLowerCase()
		if (trimmed && trimmed.length >= 2) out.add(trimmed)
	}
	add(bot.productName)
	add(bot.name)
	add(bot.displayName)
	add(bot.handle)
	for (const field of [bot.name, bot.displayName]) {
		const first = field?.trim().split(/\s+/)[0]
		add(first)
	}
	return [...out]
}

/** True when the message plainly addresses the bot by name (no Slack @mention token). */
export function isBotAddressedByName(
	text: string | undefined,
	aliases: ReadonlyArray<string>,
): boolean {
	const normalized = cleanMention(text).toLowerCase()
	if (!normalized || aliases.length === 0) return false
	for (const alias of aliases) {
		if (!alias || alias.length < 2) continue
		const pattern = new RegExp(
			`^${DIRECT_GREETING_PREFIX}@?${escapeRegex(alias)}(?:\\b|[\\s,:;!?."'])`,
			"i",
		)
		if (pattern.test(normalized)) return true
	}
	return false
}

type WorkspaceAliasSource = {
	teamId: string
	botUserId?: string | null
	botTokenEnc: string
}

export async function resolveBotAddressAliases(
	env: Env,
	ws: WorkspaceAliasSource,
): Promise<string[]> {
	const cacheKey = `slack:bot-aliases:${ws.teamId}`
	if (env.BRAIN_KV) {
		const cached = await env.BRAIN_KV.get(cacheKey).catch(() => null)
		if (cached) {
			try {
				const parsed = JSON.parse(cached) as string[]
				if (Array.isArray(parsed) && parsed.length) {
					// Product aliases are code-level guarantees; an older 24h cache entry
					// must not delay a newly-added wake name such as "Supermemory".
					return [...new Set([...PRODUCT_ALIASES, ...parsed])]
				}
			} catch {
				// refresh below
			}
		}
	}

	const defaults = [...PRODUCT_ALIASES]
	if (!ws.botUserId) return defaults

	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)
	const profile = await getSlackUserInfo(botToken, ws.botUserId)
	const aliases = collectBotAddressAliases(
		buildSlackBotIdentity(ws.botUserId, profile),
	)

	if (env.BRAIN_KV) {
		await env.BRAIN_KV.put(cacheKey, JSON.stringify(aliases), {
			expirationTtl: ALIAS_CACHE_TTL_SECONDS,
		}).catch(() => {})
	}
	return aliases
}
