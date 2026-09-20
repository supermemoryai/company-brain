import type { ToolSet } from "ai"
import { buildBrainProfileContext } from "../memory/profile-recall"
import { resolveBrainReadContainerTags } from "../memory/read-scope"
import { BRAIN_MEMORY_TAG_KINDS, listBrainMemoryTags } from "../memory/tags"
import { fetchSubtreeBrainMemories, outlineBrainTree } from "../memory/tree"
import type { SlackMemoryScope } from "../memory/writeback"
import { logPreview } from "../observability/log-utils"
import { formatThreadHistoryEntries } from "../prompt/build"
import type { SlackLookupContext } from "../slack/channel-lookup"
import {
	getSlackThreadHistory,
	type SlackMember,
	type SlackThreadMessage,
} from "../slack/client"
import type { CompanyBrainAgent } from "./agent"
import { selectThreadHistoryEntries } from "./context-state"
import type { TurnDeps } from "./deps"
import { createPeopleDirectoryTools } from "./people-codemode"
import type { TurnThreadHistory } from "./types"

function mergeThreadMessages(
	current: SlackThreadMessage[],
	incoming: SlackThreadMessage[],
): SlackThreadMessage[] {
	const byTs = new Map<string, SlackThreadMessage>()
	const withoutTs: SlackThreadMessage[] = []
	for (const message of [...current, ...incoming]) {
		if (message.ts) byTs.set(message.ts, message)
		else withoutTs.push(message)
	}
	return [...byTs.values(), ...withoutTs].sort((a, b) =>
		(a.ts ?? "").localeCompare(b.ts ?? ""),
	)
}

export function createContextDiscoveryTools(args: {
	deps: TurnDeps
	env: Env
	agent: CompanyBrainAgent
	orgId: string
	directory: SlackMember[]
	threadHistory?: TurnThreadHistory
	slackLookup?: SlackLookupContext
	askerSlackUserId?: string
	mentionedSlackUserIds?: string[]
	memoryScope?: SlackMemoryScope
	/** Explicit read surface (admin console); replaces what memoryScope implies. */
	memoryContainerTags?: string[]
	traceId: string
}): ToolSet {
	const {
		deps,
		env,
		agent,
		orgId,
		directory,
		threadHistory,
		slackLookup,
		askerSlackUserId,
		mentionedSlackUserIds = [],
		memoryScope,
		memoryContainerTags,
		traceId,
	} = args
	const knownSlackIds = new Set(directory.map((member) => member.id))
	if (askerSlackUserId) knownSlackIds.add(askerSlackUserId)
	for (const id of mentionedSlackUserIds) knownSlackIds.add(id)

	const peopleDirectoryTools = createPeopleDirectoryTools({
		deps,
		env,
		directory,
		traceId,
	})

	const recall_tagged_memories = deps.tool({
		description:
			"Fetch compact, previously tagged durable memories about a person, project, customer, team, or recurring topic. Use when those latest known facts would help; use search_company_brain for a full evidence-backed investigation. Resolve people with inspect_people_directory when a stable Slack id matters.",
		inputSchema: deps.z.object({
			query: deps.z
				.string()
				.min(1)
				.describe("The person, project, team, customer, or topic to recall."),
			includeAsker: deps.z
				.boolean()
				.optional()
				.describe("Include memories tagged to the current asker."),
			slackUserIds: deps.z
				.array(deps.z.string())
				.max(20)
				.optional()
				.describe("Resolved Slack ids for other relevant people."),
		}),
		execute: async ({ query, includeAsker, slackUserIds }) => {
			const resolvedIds = [
				...mentionedSlackUserIds,
				...(slackUserIds ?? []).filter((id) => knownSlackIds.has(id)),
			]
			const context = await buildBrainProfileContext(agent, {
				orgId,
				query,
				senderSlackUserId: includeAsker ? askerSlackUserId : undefined,
				mentionedSlackUserIds: [...new Set(resolvedIds)],
				scope: memoryScope,
				containerTags: memoryContainerTags,
			})
			console.log(
				`[company-brain][${traceId}] recall_tagged_memories query="${logPreview(query)}" found=${context ? "yes" : "no"}`,
			)
			return context
				? { found: true, context }
				: { found: false, context: "No matching tagged memories found." }
		},
	})

	const list_memory_tags = deps.tool({
		description:
			"List existing Company Brain memory tags on demand before save_memory when reusing canonical person, project, customer, team, or topic tags matters. Do not call for ordinary retrieval questions.",
		inputSchema: deps.z.object({
			kinds: deps.z.array(deps.z.enum(BRAIN_MEMORY_TAG_KINDS)).optional(),
			limit: deps.z.number().int().min(1).max(80).optional(),
		}),
		execute: async ({ kinds, limit }) => {
			const outputLimit = limit ?? 80
			const tags = listBrainMemoryTags(agent, {
				currentContainerTags: resolveBrainReadContainerTags(
					agent,
					memoryScope,
					memoryContainerTags,
				),
				kinds,
				limit: outputLimit,
			})
			console.log(
				`[company-brain][${traceId}] list_memory_tags count=${tags.length}`,
			)
			return { tags }
		},
	})

	const outline_memory_tree = deps.tool({
		description:
			"Show the Company Brain topic tree: the hierarchy of durable-memory subjects (paths like supermemory/company_brain/memory) with rough sizes. Use it to see what is known and decide which node to read, then call read_memory_node. Cheap navigation, not the deep evidence search.",
		inputSchema: deps.z.object({}),
		execute: async () => {
			const tree = outlineBrainTree(agent, {
				currentContainerTags: resolveBrainReadContainerTags(
					agent,
					memoryScope,
					memoryContainerTags,
				),
			})
			console.log(
				`[company-brain][${traceId}] outline_memory_tree roots=${tree.length}`,
			)
			return { tree }
		},
	})

	const READ_NODE_PAGE = 250
	const read_memory_node = deps.tool({
		description:
			"Read the durable memories under a topic-tree node — the node and all its descendants — newest-updated first, 250 per page. Pass a path from outline_memory_tree (e.g. supermemory/company_brain). To read a large node in full, call again with `before` set to the returned nextCursor. To target a time window instead of paging, pass `after` (and optionally `before`) as ISO timestamps. Use for browsing a subject; use search_company_brain for a full evidence-backed investigation.",
		inputSchema: deps.z.object({
			path: deps.z
				.string()
				.min(1)
				.describe(
					"A node path from outline_memory_tree, e.g. supermemory/company_brain.",
				),
			before: deps.z
				.string()
				.optional()
				.describe(
					"ISO timestamp; return only memories updated strictly before it. Pass a previous call's nextCursor here to page to older memories.",
				),
			after: deps.z
				.string()
				.optional()
				.describe(
					"ISO timestamp; return only memories updated at or after it. Combine with before to read a specific window without paging.",
				),
		}),
		execute: async ({ path, before, after }) => {
			const beforeDate = before ? new Date(before) : undefined
			const afterDate = after ? new Date(after) : undefined
			if (
				(beforeDate && Number.isNaN(beforeDate.getTime())) ||
				(afterDate && Number.isNaN(afterDate.getTime()))
			) {
				return {
					path,
					memories: [],
					note: "before/after must be ISO timestamps (e.g. the nextCursor from a prior call).",
				}
			}
			// Keyset by updatedAt: fetch one past the page to detect more. No offset, so
			// each page reads only its own window instead of everything preceding it.
			const fetched = await fetchSubtreeBrainMemories(env, agent, {
				orgId,
				containerTags: resolveBrainReadContainerTags(
					agent,
					memoryScope,
					memoryContainerTags,
				),
				nodePath: path,
				limit: READ_NODE_PAGE + 1,
				before: beforeDate,
				after: afterDate,
			})
			const page = fetched.slice(0, READ_NODE_PAGE)
			const hasMore = fetched.length > READ_NODE_PAGE
			const memories = page.map((row) => row.memory)
			const nextCursor = hasMore
				? page[page.length - 1]?.updatedAt.toISOString()
				: undefined
			console.log(
				`[company-brain][${traceId}] read_memory_node path="${logPreview(path)}" before=${before ?? "-"} after=${after ?? "-"} returned=${memories.length} more=${hasMore}`,
			)
			if (!memories.length) {
				return {
					path,
					memories: [],
					note:
						before || after
							? "No memories in this range under the node."
							: "No memories under this node.",
				}
			}
			return nextCursor ? { path, memories, nextCursor } : { path, memories }
		},
	})

	let loadedThreadMessages = [...(threadHistory?.messages ?? [])]
	let threadComplete = threadHistory?.complete ?? true
	let nextThreadCursor = threadHistory?.nextCursor
	const read_current_thread = threadHistory
		? deps.tool({
				description:
					"Load messages omitted from the current Slack thread context. Use it when runtime context reports incomplete history or a follow-up reference cannot be resolved from visible turns. Provide `query` to find a subject anywhere in the thread; omit it to page chronologically. Each call loads another bounded Slack source batch while `sourceComplete` is false. If `continuation.available` is true after a queried miss, call again with `continuation.repeatQuery` to search the next batch.",
				inputSchema: deps.z.object({
					query: deps.z
						.string()
						.optional()
						.describe("Optional person, project, phrase, or subject to find."),
					cursor: deps.z
						.number()
						.int()
						.min(0)
						.optional()
						.describe("Zero-based message offset for chronological paging."),
					limit: deps.z.number().int().min(1).max(80).optional(),
				}),
				execute: async ({ query, cursor, limit }) => {
					if (!threadComplete && slackLookup?.threadTs) {
						const more = await getSlackThreadHistory(
							slackLookup.botToken,
							slackLookup.channel,
							slackLookup.threadTs,
							{
								pageLimit: 200,
								maxMessages: 600,
								maxPages: 4,
								cursor: nextThreadCursor,
							},
						)
						loadedThreadMessages = mergeThreadMessages(
							loadedThreadMessages,
							more.messages,
						)
						threadComplete = more.complete
						nextThreadCursor = more.nextCursor
					}
					const entries = formatThreadHistoryEntries({
						messages: loadedThreadMessages,
						botUserId: threadHistory.botUserId,
						slackBotId: threadHistory.slackBotId,
						excludeTs: threadHistory.excludeTs,
						userNames: slackLookup?.userNames,
						botUserIds: new Set(threadHistory.botUserIds ?? []),
					})
					const outputLimit = limit ?? 40
					const start = cursor ?? 0
					const selected = selectThreadHistoryEntries(entries, {
						query,
						cursor,
						limit: outputLimit,
					})
					console.log(
						`[company-brain][${traceId}] read_current_thread query="${logPreview(query ?? "(page)")}" returned=${selected.length} loaded=${entries.length} complete=${threadComplete ? "yes" : "no"}`,
					)
					return {
						complete: threadComplete,
						sourceComplete: threadComplete,
						loadedMessages: entries.length,
						nextCursor:
							!query?.trim() && start + selected.length < entries.length
								? start + selected.length
								: undefined,
						continuation: threadComplete
							? { available: false as const }
							: {
									available: true as const,
									action: "call_again" as const,
									repeatQuery: query?.trim() || undefined,
									instruction: query?.trim()
										? "Call read_current_thread again with repeatQuery to load and search the next bounded Slack source batch."
										: "Call read_current_thread again to load the next bounded Slack source batch.",
								},
						messages: selected.map((entry) => ({
							ts: entry.ts,
							speaker: entry.speakerLabel,
							kind: entry.speakerKind,
							slackUserId: entry.slackUserId,
							slackBotId: entry.slackBotId,
							slackAppId: entry.slackAppId,
							text: entry.content,
						})),
					}
				},
			})
		: undefined

	return {
		...peopleDirectoryTools,
		recall_tagged_memories,
		list_memory_tags,
		outline_memory_tree,
		read_memory_node,
		...(read_current_thread ? { read_current_thread } : {}),
	}
}
