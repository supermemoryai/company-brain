import type { ToolSet } from "ai"
import { captureException } from "@/lib/capture"
import type { MemoryWriteback } from "../memory"
import { MAX_BRAIN_MEMORY_DOCS_PER_TURN } from "../memory/tags"
import { logPreview } from "../observability/log-utils"
import { getMcpCatalogSlugs, isMcpCatalogSlug } from "../tools/mcp/catalog"
import {
	connectModeFor,
	getDirectoryEntryBySlug,
	mcpSetupUrl,
} from "../tools/mcp/directory"
import type { TurnDeps } from "./deps"

export type TurnCapture = {
	memory: MemoryWriteback
	connect: string[] | null
	blockedConnectSlugs?: Set<string>
}

export function memoryWritebackSchema(deps: TurnDeps) {
	return deps.z.union([
		deps.MemoryDocSchema,
		deps.z
			.array(deps.MemoryDocSchema)
			.min(1)
			.max(MAX_BRAIN_MEMORY_DOCS_PER_TURN),
	])
}

// save_memory/connect_app write here instead of a structured Output.object field.
export function createCaptureTools(
	deps: TurnDeps,
	capture: TurnCapture,
	traceId: string,
	options?: { allowWrites?: boolean; env?: Env },
): ToolSet {
	const tools: ToolSet = {}
	if (options?.allowWrites === false) return tools
	tools.save_memory = deps.tool({
		description:
			"Save one coherent tagged memory, or at most three independently retrievable memories, when this turn surfaced durable stable knowledge. Never save anything a connected tool owns as live truth (PR/review status, issue or ticket state, deploy status, current counts) — fetch those live instead. Call at most once, near the end, and only if it's genuinely worth keeping.",
		inputSchema: deps.z.object({ memories: memoryWritebackSchema(deps) }),
		execute: async (input) => {
			const memory =
				"memories" in input
					? input.memories
					: (input as unknown as MemoryWriteback)
			capture.memory = memory
			const first = Array.isArray(memory) ? memory[0] : memory
			console.log(
				`[company-brain][${traceId}] save_memory count=${Array.isArray(memory) ? memory.length : 1} firstTitle="${logPreview(first?.title)}"`,
			)
			return { saved: true }
		},
	})
	const catalogSlugs = getMcpCatalogSlugs()
	if (catalogSlugs.length > 0) {
		tools.connect_app = deps.tool({
			description: `Connect an app. Accepts the built-in apps (${catalogSlugs.join(", ")}) and any slug returned by search_mcp_directory. Use this when the requester explicitly asks to connect/authorize/reconnect, or when their task needs an app with no usable personal connection and they have not said they lack underlying app access. Apps we can authorize get a private Connect button; apps needing the requester's own API key come back as a setup link for you to share instead. Put every needed app in slugs in one call; slug remains supported for a single app. If the requester says they cannot use their own app account, use the temporary-access path instead and do not call this again.`,
			inputSchema: deps.z
				.object({
					slugs: deps.z
						.array(deps.z.string())
						.min(1)
						.max(10)
						.optional()
						.describe(
							`All app slugs requested by the user. Built-in: ${catalogSlugs.join(", ")}. Anything else must be a slug from search_mcp_directory.`,
						),
					slug: deps.z
						.string()
						.optional()
						.describe("Backward-compatible single app slug."),
				})
				.refine((input) => Boolean(input.slug?.trim() || input.slugs?.length), {
					message: "Provide slug or slugs.",
				}),
			execute: async ({ slug, slugs }) => {
				const requested = [...(slugs ?? []), ...(slug ? [slug] : [])]
				const normalized = [
					...new Set(
						requested
							.map((value) => value.trim().toLowerCase())
							.filter(Boolean),
					),
				]
				const buttonable: string[] = []
				const manual: Array<{ name: string; slug: string }> = []
				const unknown: string[] = []
				for (const value of normalized) {
					if (isMcpCatalogSlug(value)) {
						buttonable.push(value)
						continue
					}
					const entry = getDirectoryEntryBySlug(value)
					if (!entry) {
						unknown.push(value)
						continue
					}
					if (connectModeFor(entry) === "oauth") buttonable.push(value)
					else manual.push({ name: entry.name, slug: value })
				}
				if (!normalized.length) {
					return { error: "At least one app slug is required." }
				}
				if (unknown.length && !buttonable.length && !manual.length) {
					return {
						error: `Unknown app${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Use search_mcp_directory to get a valid slug, or use one of: ${catalogSlugs.join(", ")}.`,
					}
				}
				const allowed = buttonable.filter(
					(value) => !capture.blockedConnectSlugs?.has(value),
				)
				const skipped = buttonable.filter((value) => !allowed.includes(value))
				capture.connect = [...new Set([...(capture.connect ?? []), ...allowed])]
				if (!capture.connect.length) capture.connect = null
				console.log(
					`[company-brain][${traceId}] connect_app slugs=${allowed.join(",") || "-"} manual=${manual.map((m) => m.slug).join(",") || "-"} blocked=${skipped.join(",") || "-"} unknown=${unknown.join(",") || "-"}`,
				)
				return {
					connecting: allowed,
					...(manual.length && options?.env
						? {
								setupLinks: manual.map((app) => ({
									name: app.name,
									url: mcpSetupUrl(options.env as Env, app.slug),
								})),
								setupReason:
									"These apps need the requester's own API key, which only they can enter. Share each link; it opens that app's setup form already filled in. Do not imply a Connect button exists for them.",
							}
						: {}),
					...(unknown.length ? { unknown } : {}),
					...(skipped.length
						? {
								skipped,
								reason:
									"The requester already chose the temporary-access path for these apps, so do not offer another connection button.",
							}
						: {}),
				}
			},
		})
	}
	return tools
}

export function reportLegacyStructuredReply(
	text: string,
	traceId: string,
): void {
	const t = text.trim()
	if (!t.startsWith("{") || !t.endsWith("}")) return
	let parsed: unknown
	try {
		parsed = JSON.parse(t)
	} catch {
		return
	}
	if (!parsed || typeof parsed !== "object") return
	const o = parsed as Record<string, unknown>
	if (typeof o.reply !== "string") return
	captureException(new Error("Model emitted legacy structured reply JSON"), {
		tags: {
			component: "company-brain",
			feature: "legacy-structured-reply",
		},
		extra: {
			traceId,
			hasMemory: o.memory != null,
			hasConnect: typeof o.connect === "string" || Array.isArray(o.connect),
			keys: Object.keys(o),
			textLength: t.length,
			replyLength: o.reply.length,
		},
	})
}
