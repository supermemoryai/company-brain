import { generateText } from "ai"
import * as Effect from "effect/Effect"
import { makeAppLayer } from "@/config"
import { captureException } from "@/lib/capture"
import { SHARED_TEAM_BRAIN_CONTAINER_TAG } from "@/lib/spaces/provisioning"
import { addMemorySingle } from "@/routes/memories/handler-effect"
import type { BrainCostLedger } from "../billing/cost"
import { responseBodyFromResult } from "../billing/cost"
import type { CompanyBrainAgent } from "../turn/agent"
import {
	brainXai,
	hasXai,
	hasBrainGateway,
	wrapBrainGateway,
} from "../turn/brain-model"
import { RESEARCH_MODEL } from "../turn/model-profile"
import { listBrainDocuments } from "../../memory/documents"
import { deleteStaleBrainMemoryDocument } from "./cleanup"
import {
	getBrainMemoryResetEpoch,
	isBrainMemoryResetEpochCurrent,
} from "./tree"

const ENTITY_TYPE = "entity"

export type ResolvedEntity = {
	canonical: string
	domain: string | null
	aliases: string[]
	contacts: string[]
	source: "brain" | "web"
}

type EntityMeta = {
	canonical?: string
	domain?: string | null
	aliases?: string[]
	contacts?: string[]
}

function normalize(input: string): string {
	return input.trim().toLowerCase()
}

function normalizeDomain(input: string): string | null {
	const raw = input
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/\/.*$/, "")
		.replace(/^www\./, "")
	return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw) ? raw : null
}

// resetEpoch scopes the id to a generation so an old-generation write can't
// dedupe onto (and then stale-delete) a post-reset entity. Lookup is metadata-
// based (see findEntity), so this doesn't affect dedup reads.
function entityCustomId(
	orgId: string,
	key: string,
	resetEpoch: number,
): string {
	return `entity_${orgId}_${key.replace(/[^a-z0-9]+/g, "-")}_g${resetEpoch}`
}

function matches(ref: string, meta: EntityMeta): boolean {
	const haystack = [meta.canonical, meta.domain, ...(meta.aliases ?? [])]
		.filter(Boolean)
		.map((v) => normalize(String(v)))
	const stem = meta.domain ? normalize(meta.domain.split(".")[0] ?? "") : ""
	return haystack.some((h) => h === ref) || (!!stem && stem === ref)
}

async function findEntity(
	env: Env,
	orgId: string,
	ref: string,
	resetEpoch: number,
): Promise<ResolvedEntity | null> {
	const rows = await listBrainDocuments(env, {
		containerTag: SHARED_TEAM_BRAIN_CONTAINER_TAG,
		metadata: [
			{ key: "type", value: ENTITY_TYPE },
			// Scope reads to the current generation so a reset's batched wipe
			// can't surface a pre-reset entity that isn't deleted yet.
			{ key: "brain_reset_epoch", value: String(resetEpoch) },
		],
		includeContent: false,
		limit: 100,
	})
	for (const row of rows) {
		const meta = (row.metadata ?? {}) as EntityMeta
		if (meta.canonical && matches(ref, meta)) {
			return {
				canonical: meta.canonical,
				domain: meta.domain ?? null,
				aliases: meta.aliases ?? [],
				contacts: meta.contacts ?? [],
				source: "brain",
			}
		}
	}
	return null
}

async function resolveViaWeb(
	env: Env,
	ref: string,
	costLedger?: BrainCostLedger,
): Promise<ResolvedEntity | null> {
	if (!hasXai(env)) return null
	const xai = brainXai(env)
	const result = await generateText({
		model: wrapBrainGateway(env, [xai.responses(RESEARCH_MODEL)]),
		prompt: `Identify the company or organization referred to as "${ref}". Use web search. Return ONLY JSON: {"canonical":"Official Name","domain":"example.com","aliases":["short name"]}. domain is the primary website domain, no protocol or www. Use null for domain if unsure.`,
		tools: { web_search: xai.tools.webSearch() },
	})
	costLedger?.recordFromGeneration({
		model: RESEARCH_MODEL,
		usage: result.usage,
		providerMetadata: result.providerMetadata,
		responseBody: responseBodyFromResult(result),
	})
	const json = result.text.match(/\{[\s\S]*\}/)?.[0]
	if (!json) return null
	try {
		const parsed = JSON.parse(json) as EntityMeta
		const canonical = parsed.canonical?.trim()
		if (!canonical) return null
		return {
			canonical,
			domain: parsed.domain ? normalizeDomain(parsed.domain) : null,
			aliases: (parsed.aliases ?? []).map((a) => a.trim()).filter(Boolean),
			contacts: [],
			source: "web",
		}
	} catch {
		return null
	}
}

async function writeEntity(
	env: Env,
	org: { id: string; name: string; metadata?: unknown },
	userId: string,
	entity: ResolvedEntity,
	agent: CompanyBrainAgent,
	resetEpoch: number,
): Promise<void> {
	if (!isBrainMemoryResetEpochCurrent(agent, resetEpoch)) return
	const key = entity.domain || entity.canonical
	const aliasLine = entity.aliases.length
		? ` Aliases: ${entity.aliases.join(", ")}.`
		: ""
	const content = `${entity.canonical}${entity.domain ? ` (${entity.domain})` : ""}.${aliasLine}`
	const program = addMemorySingle({
		org: { id: org.id, name: org.name, metadata: org.metadata },
		userId,
		source: "company-brain",
		executionCtx: undefined,
		requestParams: {
			content,
			customId: entityCustomId(org.id, key, resetEpoch),
			containerTag: SHARED_TEAM_BRAIN_CONTAINER_TAG,
			metadata: {
				type: ENTITY_TYPE,
				sm_source: "company-brain",
				brain_reset_epoch: resetEpoch,
				title: entity.canonical,
				canonical: entity.canonical,
				...(entity.domain ? { domain: entity.domain } : {}),
				aliases: entity.aliases,
			},
		},
	})
	const result = await Effect.runPromise(
		program.pipe(Effect.provide(makeAppLayer({ env }))),
	)
	if (
		(result.status === "queued" || result.status === "done") &&
		!isBrainMemoryResetEpochCurrent(agent, resetEpoch)
	) {
		await deleteStaleBrainMemoryDocument({
			env,
			orgId: org.id,
			documentId: result.id,
		})
	}
}

// Resolve a name/reference to a canonical entity: brain first, then web (and cache the result back).
export async function resolveEntity(
	env: Env,
	org: { id: string; name: string; metadata?: unknown },
	userId: string,
	reference: string,
	agent: CompanyBrainAgent,
	costLedger?: BrainCostLedger,
	/** Cache the resolved entity in the shared brain. False on read-only turns. */
	persist = true,
): Promise<ResolvedEntity | null> {
	const ref = normalize(reference)
	if (!ref) return null
	const resetEpoch = getBrainMemoryResetEpoch(agent)
	try {
		const known = await findEntity(env, org.id, ref, resetEpoch)
		// A reset may have advanced the epoch mid-query; don't serve a stale entity.
		if (!isBrainMemoryResetEpochCurrent(agent, resetEpoch)) return null
		if (known) return known
		const web = await resolveViaWeb(env, ref, costLedger)
		if (!web) return null
		if (persist) {
			await writeEntity(env, org, userId, web, agent, resetEpoch).catch((err) =>
				captureException(err instanceof Error ? err : new Error(String(err)), {
					tags: { component: "entities" },
				}),
			)
		}
		return web
	} catch (error) {
		captureException(
			error instanceof Error ? error : new Error(String(error)),
			{
				tags: { component: "entities" },
			},
		)
		return null
	}
}
