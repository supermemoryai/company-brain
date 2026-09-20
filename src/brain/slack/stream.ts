import type { TurnCardSource, TurnProgress } from "../turn"
import {
	appendSlackStreamChunks,
	appendSlackStreamReply,
	clearAssistantThreadStatus,
	deleteSlackMessage,
	getSlackMessagePermalink,
	postSlackMessage,
	postSlackReply,
	postSlackReplyDelivery,
	type StreamChunk,
	startSlackStream,
	stopSlackStream,
	updateSlackMessage,
} from "./client"
import {
	markdownReplyBlocks,
	mrkdwnReplyBlocks,
	splitSlackMarkdown,
} from "./format"

type StreamSession = {
	progress: TurnProgress
	finalize: (
		reply: string,
		failed: boolean,
		paused?: boolean,
		settled?: boolean,
	) => Promise<{ streamed: boolean; messageTs?: string }>
	discard: (reply?: string) => Promise<void>
	postFallback: (reply: string) => Promise<string | undefined>
	rewriteLastNarration: (text: string) => Promise<boolean>
}

type TaskStatus = "in_progress" | "complete" | "error"

type ReplyDelivery = {
	ok: boolean
	messageTs?: string
}

type TaskSlot = {
	slackId: string
	title: string
	status: TaskStatus
	detail?: string
	output?: string
	sources?: TurnCardSource[]
	activeToolCallIds: Set<string>
	hadError: boolean
}

export const CONTEXT_FOOTER_BLOCK_ID = "brain_context_footer"

/** Slack `task_card` details/output field: a single rich_text entity. */
export function richTextEntity(text: string): unknown {
	return {
		type: "rich_text",
		elements: [
			{
				type: "rich_text_section",
				elements: [{ type: "text", text: text.slice(0, 300) }],
			},
		],
	}
}

function formatElapsed(ms: number): string {
	const s = Math.round(ms / 1000)
	if (s < 60) return `${s}s`
	const m = Math.floor(s / 60)
	const rem = s % 60
	return rem ? `${m}m ${rem}s` : `${m}m`
}

export function taskCardSources(
	sources?: TurnCardSource[],
): unknown[] | undefined {
	if (!sources?.length) return undefined
	return sources.slice(0, 3).map((s) => ({
		type: "url",
		url: s.url,
		text: s.text.slice(0, 150),
	}))
}

const MAX_VISIBLE_TASKS = 8
const OVERFLOW_TASK_TITLE = "Continuing research"

function publicProgressBlocks(
	slots: TaskSlot[],
	title: string,
	blockId: string,
	opts: { final?: boolean } = {},
): unknown[] {
	return [
		{
			type: "plan",
			block_id: blockId,
			title: title.slice(0, 150),
			tasks: slots.map((slot) => {
				const sources = taskCardSources(slot.sources)
				return {
					type: "task_card",
					task_id: slot.slackId,
					title: slot.title.slice(0, 150),
					status:
						opts.final || slot.status === "error" ? slot.status : "in_progress",
					...(slot.detail ? { details: richTextEntity(slot.detail) } : {}),
					...(slot.output ? { output: richTextEntity(slot.output) } : {}),
					...(sources ? { sources } : {}),
				}
			}),
		},
	]
}

export function createSlackStreamSession(args: {
	botToken: string
	channel: string
	threadTs: string
	recipientUserId?: string
	teamId: string
	orgId: string
	publicProgress?: boolean
	existingPublicProgressTs?: string
	clearAssistantStatusOnProgress?: boolean
	contextFooter?: () => string
	prepareReply?: (reply: string) => Promise<string>
	onDeliveryCheckpoint?: (update: {
		progressMessageTs?: string | null
		replyMessageTs?: string
	}) => void
}): StreamSession {
	const {
		botToken,
		channel,
		threadTs,
		recipientUserId,
		teamId,
		orgId,
		publicProgress = false,
		existingPublicProgressTs,
		clearAssistantStatusOnProgress = false,
		contextFooter,
		prepareReply,
		onDeliveryCheckpoint,
	} = args
	const footerBlocks = (): unknown[] =>
		contextFooter
			? [
					{
						type: "context",
						block_id: CONTEXT_FOOTER_BLOCK_ID,
						elements: [{ type: "mrkdwn", text: contextFooter() }],
					},
				]
			: []
	const taskSlots = new Map<string, TaskSlot>()
	const toolCallSlots = new Map<string, TaskSlot>()
	let nextTaskIndex = 1
	let streamHeaderShown = false
	let streamTs: string | undefined
	let publicProgressTs = existingPublicProgressTs
	// Stable for this card's lifetime so each chat.update mutates the same plan
	// block in place rather than re-rendering a brand-new block every tick.
	const planBlockId = `plan_${threadTs}_${Date.now()}`
	const startedAt = Date.now()
	// Serializes public-card writes (see syncPublicProgress).
	let publicProgressPosting: Promise<unknown> = Promise.resolve()
	let streamDead = false
	let assistantStatusCleared = false
	// Set once the stream has been finalized or discarded. Guards against a turn
	// closing its own stream twice (e.g. the explicit finalize on the approval
	// suspend path plus the finalize in the caller's `finally`) and against a
	// late steering `discard` clobbering an already-delivered answer.
	let closed = false

	const checkpointDelivery = (update: {
		progressMessageTs?: string | null
		replyMessageTs?: string
	}): void => {
		try {
			onDeliveryCheckpoint?.(update)
		} catch (error) {
			console.warn("[company-brain] delivery checkpoint failed:", error)
		}
	}

	const prepareOutgoingReply = async (reply: string): Promise<string> => {
		if (!prepareReply || !reply.trim()) return reply
		try {
			return await prepareReply(reply)
		} catch (error) {
			console.warn("[company-brain] Slack reply preparation failed:", error)
			return reply
		}
	}

	const taskSlotFor = (title: string): TaskSlot => {
		const visibleTitle =
			taskSlots.has(title) || taskSlots.size < MAX_VISIBLE_TASKS
				? title
				: OVERFLOW_TASK_TITLE
		const existing = taskSlots.get(visibleTitle)
		if (existing) return existing
		const slackId = `task-${nextTaskIndex}`
		nextTaskIndex += 1
		const slot: TaskSlot = {
			slackId,
			title: visibleTitle,
			status: "in_progress",
			activeToolCallIds: new Set(),
			hadError: false,
		}
		taskSlots.set(visibleTitle, slot)
		return slot
	}

	const resetTasks = (): void => {
		taskSlots.clear()
		toolCallSlots.clear()
		nextTaskIndex = 1
		streamHeaderShown = false
	}

	const ensureStream = async (): Promise<string | undefined> => {
		if (publicProgress) return undefined
		if (streamDead) return undefined
		if (streamTs) return streamTs
		streamTs = await startSlackStream(
			botToken,
			channel,
			threadTs,
			recipientUserId,
			teamId,
			"plan",
		)
		if (!streamTs) {
			streamDead = true
			console.warn(
				`[company-brain] stream unavailable for org=${orgId}; answering without a card`,
			)
		}
		return streamTs
	}

	const clearAssistantStatus = async (): Promise<void> => {
		if (!clearAssistantStatusOnProgress || assistantStatusCleared) return
		assistantStatusCleared = await clearAssistantThreadStatus(
			botToken,
			channel,
			threadTs,
		)
	}

	const renderPublicProgress = async (): Promise<void> => {
		const slots = [...taskSlots.values()]
		const text = slots.map((slot) => slot.title).join("\n") || "Working on it"
		// Latest phase, not last in-progress: between tools no slot is in_progress.
		const header = slots.at(-1)?.title ?? "Working on it"
		const blocks = [
			...publicProgressBlocks(slots, header, planBlockId),
			...footerBlocks(),
		]
		if (publicProgressTs) {
			const ok = await updateSlackMessage(
				botToken,
				channel,
				publicProgressTs,
				text,
				blocks,
			)
			if (!ok) streamDead = true
			return
		}
		publicProgressTs = await postSlackMessage(
			botToken,
			channel,
			text,
			threadTs,
			blocks,
		)
		if (publicProgressTs) {
			checkpointDelivery({ progressMessageTs: publicProgressTs })
		}
		if (!publicProgressTs) streamDead = true
	}

	const syncPublicProgress = (): Promise<void> => {
		const next = publicProgressPosting.then(renderPublicProgress)
		publicProgressPosting = next.catch(() => {})
		return next
	}

	const updatePublicCardWithReply = async (
		ts: string,
		text: string,
		planBlocks: unknown[],
		reply?: string,
	): Promise<ReplyDelivery> => {
		if (!reply?.trim()) {
			const ok = await updateSlackMessage(botToken, channel, ts, text, [
				...planBlocks,
				...footerBlocks(),
			])
			return { ok, ...(ok ? { messageTs: ts } : {}) }
		}
		const replyChunks = splitSlackMarkdown(reply)
		if (replyChunks.length > 1) {
			// Slack caps all markdown blocks in one payload at 12k characters. Close
			// the progress card, then send sentence-aligned continuation messages.
			const cardOk = await updateSlackMessage(botToken, channel, ts, text, [
				...planBlocks,
				...footerBlocks(),
			])
			if (!cardOk) return { ok: false }
			const messageTs = await postSlackReply(
				botToken,
				channel,
				reply,
				threadTs,
				footerBlocks(),
			)
			return {
				ok: Boolean(messageTs),
				...(messageTs ? { messageTs } : {}),
			}
		}
		const markdownOk = await updateSlackMessage(botToken, channel, ts, text, [
			...planBlocks,
			...markdownReplyBlocks(replyChunks[0] ?? reply),
			...footerBlocks(),
		])
		if (markdownOk) return { ok: true, messageTs: ts }

		const mrkdwnOk = await updateSlackMessage(botToken, channel, ts, text, [
			...planBlocks,
			...mrkdwnReplyBlocks(reply),
			...footerBlocks(),
		])
		if (mrkdwnOk) return { ok: true, messageTs: ts }

		const plainOk = await updateSlackMessage(botToken, channel, ts, reply)
		return { ok: plainOk, ...(plainOk ? { messageTs: ts } : {}) }
	}

	const finalizePublicCard = (
		ts: string,
		slots: TaskSlot[],
		title: string,
		terminalStatus: TaskStatus,
		reply?: string,
		renameInProgress?: string,
	): Promise<ReplyDelivery> => {
		for (const slot of slots) {
			if (slot.status === "in_progress") {
				if (renameInProgress) slot.title = renameInProgress
				slot.status = terminalStatus
			}
		}
		const blocks = publicProgressBlocks(slots, title, planBlockId, {
			final: true,
		})
		return updatePublicCardWithReply(ts, reply?.trim() || title, blocks, reply)
	}

	let narrationCount = 0
	let lastNarration = ""
	// Runaway backstop only; narration is a deliberate post_update tool call.
	const MAX_NARRATIONS = 10
	// Serialized: parallel posts land out of order and interleave chunks.
	let narrationPosting: Promise<unknown> = Promise.resolve()
	let lastNarrationTs: string | undefined

	const progress: TurnProgress = {
		narrate: async (text) => {
			if (closed) return false
			const line = text.trim()
			if (!line || line === lastNarration || narrationCount >= MAX_NARRATIONS) {
				return false
			}
			narrationCount += 1
			lastNarration = line
			const delivery = narrationPosting.then(async () => {
				if (closed) return false
				const outgoingLine = await prepareOutgoingReply(line)
				if (closed) return false
				// Only a fully posted update counts as surfaced: on a later-chunk
				// failure the tail was never seen, so it has to stay eligible for
				// the final reply.
				return await postSlackReplyDelivery(
					botToken,
					channel,
					outgoingLine,
					threadTs,
				)
					.then((delivery) => {
						if (delivery.complete) lastNarrationTs = delivery.ts
						return delivery.complete
					})
					.catch(() => false)
			})
			narrationPosting = delivery.catch(() => {})
			return await delivery
		},
		card: async (id, title, status, extra) => {
			if (closed || streamDead) return
			const existing = toolCallSlots.get(id)
			if (status !== "in_progress" && !existing) return
			const slot = existing ?? taskSlotFor(title)
			if (extra?.detail) slot.detail = extra.detail
			if (extra?.output) slot.output = extra.output
			if (extra?.sources?.length) slot.sources = extra.sources
			if (status === "in_progress") {
				toolCallSlots.set(id, slot)
				slot.activeToolCallIds.add(id)
				if (slot.status !== "in_progress") return
				if (slot.activeToolCallIds.size > 1 || existing) return
			} else {
				toolCallSlots.delete(id)
				slot.activeToolCallIds.delete(id)
				if (status === "error") slot.hadError = true
				if (slot.activeToolCallIds.size > 0) return
				const nextStatus = slot.hadError ? "error" : "complete"
				if (slot.status === nextStatus) return
				slot.status = nextStatus
			}

			if (publicProgress) {
				await syncPublicProgress()
				if (publicProgressTs && !streamDead) await clearAssistantStatus()
				return
			}

			const ts = await ensureStream()
			if (!ts || streamDead) return
			const chunks: StreamChunk[] = []
			if (!streamHeaderShown) {
				chunks.push({ type: "plan_update", title: "Working on it" })
				streamHeaderShown = true
			}
			chunks.push({
				type: "task_update",
				id: slot.slackId,
				title: slot.title,
				status: slot.status,
				...(slot.detail ? { details: slot.detail } : {}),
				...(slot.output ? { output: slot.output } : {}),
				...(slot.sources?.length
					? {
							sources: slot.sources.slice(0, 3).map((s) => ({
								type: "url" as const,
								url: s.url,
								text: s.text,
							})),
						}
					: {}),
			})
			const ok = await appendSlackStreamChunks(botToken, channel, ts, chunks)
			if (!ok) streamDead = true
			if (ok) await clearAssistantStatus()
		},
	}

	return {
		progress,
		rewriteLastNarration: async (text) => {
			await narrationPosting
			const ts = lastNarrationTs
			if (!ts || !text.trim()) return false
			return await updateSlackMessage(botToken, channel, ts, text).catch(
				() => false,
			)
		},
		finalize: async (reply, failed, paused, settled) => {
			if (closed) return { streamed: false }
			closed = true
			const outgoingReply = await prepareOutgoingReply(reply)
			let streamedReply = false

			const elapsed = formatElapsed(Date.now() - startedAt)
			const closingTitle = failed
				? `Ran into a problem (${elapsed})`
				: paused
					? `Taking longer than expected — reply to pick this back up (${elapsed})`
					: outgoingReply.trim()
						? `Answer ready (${elapsed})`
						: settled
							? `Done (${elapsed})`
							: `Paused (${elapsed})`

			// Public progress cards are temporary. A fresh reply owns the final
			// message ts so Slack keeps the answer in chronological order.
			let answerTs: string | undefined
			try {
				await publicProgressPosting
				await narrationPosting
				await clearAssistantStatus()
				if (publicProgressTs) {
					const progressTs = publicProgressTs
					const terminalStatus = failed ? "error" : "complete"
					const slots = [...taskSlots.values()]
					const renameInProgress = paused ? "Interrupted" : undefined
					const collapsePublicCard = () =>
						finalizePublicCard(
							progressTs,
							slots,
							closingTitle,
							terminalStatus,
							undefined,
							renameInProgress,
						)
					if (outgoingReply.trim()) {
						const freshAnswerTs = await postSlackReply(
							botToken,
							channel,
							outgoingReply,
							threadTs,
							footerBlocks(),
						)
						if (freshAnswerTs) {
							streamedReply = true
							answerTs = freshAnswerTs
							checkpointDelivery({ replyMessageTs: freshAnswerTs })
							const deleted = await deleteSlackMessage(
								botToken,
								channel,
								progressTs,
							)
							if (deleted) {
								checkpointDelivery({ progressMessageTs: null })
							}
							if (!deleted) {
								const permalink = await getSlackMessagePermalink(
									botToken,
									channel,
									freshAnswerTs,
								)
								const linked = await finalizePublicCard(
									progressTs,
									slots,
									closingTitle,
									terminalStatus,
									permalink
										? `[View final answer](${permalink})`
										: "Final answer posted as the newest reply below.",
									renameInProgress,
								)
								if (!linked.ok) await collapsePublicCard()
							}
						} else {
							const delivery = await finalizePublicCard(
								progressTs,
								slots,
								closingTitle,
								terminalStatus,
								outgoingReply,
								renameInProgress,
							)
							streamedReply = delivery.ok
							if (delivery.ok) {
								answerTs = delivery.messageTs ?? progressTs
								checkpointDelivery({ replyMessageTs: answerTs })
							} else {
								streamDead = true
								await collapsePublicCard()
							}
						}
					} else {
						const delivery = await collapsePublicCard()
						if (delivery.ok) {
							answerTs = delivery.messageTs ?? progressTs
						}
					}
					resetTasks()
				}

				if (outgoingReply.trim()) await ensureStream()
				if (streamTs) {
					if (!streamDead) {
						const finalStatus = failed ? "error" : "complete"
						const closing: StreamChunk[] = []
						for (const slot of taskSlots.values()) {
							if (slot.status !== "in_progress") continue
							slot.status = finalStatus
							closing.push({
								type: "task_update" as const,
								id: slot.slackId,
								title: paused ? "Interrupted" : slot.title,
								status: finalStatus,
							})
						}
						closing.push({ type: "plan_update", title: closingTitle })
						await appendSlackStreamChunks(botToken, channel, streamTs, closing)
						if (outgoingReply.trim()) {
							const ok = await appendSlackStreamReply(
								botToken,
								channel,
								streamTs,
								outgoingReply,
							)
							streamedReply = ok
							if (!ok) streamDead = true
						}
					}
					answerTs = streamTs
					if (streamTs && streamedReply) {
						checkpointDelivery({ replyMessageTs: streamTs })
					}
					resetTasks()
					await stopSlackStream(botToken, channel, streamTs)
				}
			} catch (err) {
				console.warn("[company-brain] stream finalize failed:", err)
			}
			return { streamed: streamedReply, messageTs: answerTs }
		},
		discard: async (reply) => {
			if (closed) return
			closed = true
			const outgoingReply = reply
				? await prepareOutgoingReply(reply)
				: undefined
			await publicProgressPosting
			await narrationPosting
			await clearAssistantStatus()
			const ts = streamTs
			const publicTs = publicProgressTs
			const slots = [...taskSlots.values()]
			// Captured before finalizePublicCard flips in-progress slots to error.
			const interruptedCards = slots.map((slot) => ({
				type: "task_update" as const,
				id: slot.slackId,
				title: slot.status === "in_progress" ? "Interrupted" : slot.title,
				status: "complete" as const,
			}))
			const interruptedChunks: StreamChunk[] = [
				...interruptedCards,
				{ type: "plan_update", title: "Interrupted" },
			]
			streamDead = true
			streamTs = undefined
			publicProgressTs = undefined
			checkpointDelivery({ progressMessageTs: null })
			if (publicTs) {
				const delivery = await finalizePublicCard(
					publicTs,
					slots,
					"Interrupted",
					"error",
					outgoingReply,
				)
				resetTasks()
				if (delivery.ok) return
			} else {
				resetTasks()
			}
			if (ts) {
				const stopped = await stopSlackStream(botToken, channel, ts, {
					chunks: interruptedChunks,
					markdownText: outgoingReply?.trim() ? outgoingReply : undefined,
				})
				if (stopped) return
				const replacement = outgoingReply?.trim()
					? outgoingReply
					: "Interrupted"
				const updated = await updateSlackMessage(
					botToken,
					channel,
					ts,
					replacement,
					[],
				)
				if (updated) return
			}
			if (outgoingReply?.trim()) {
				await postSlackReply(botToken, channel, outgoingReply, threadTs)
			}
		},
		postFallback: async (reply) => {
			await narrationPosting
			const outgoingReply = await prepareOutgoingReply(reply)
			const ts = await postSlackReply(
				botToken,
				channel,
				outgoingReply,
				threadTs,
			)
			if (ts) checkpointDelivery({ replyMessageTs: ts })
			if (!ts) {
				console.warn(
					`[company-brain] reply not delivered org=${orgId} channel=${channel} thread=${threadTs}`,
				)
			}
			return ts
		},
	}
}
