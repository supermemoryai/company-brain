import { runInDbScope } from "@repo/db"
import {
	getBrainDocument,
	updateBrainDocumentMetadata,
} from "../../memory/documents"
import { documentStatuses } from "../../memory/memories"
import type { CompanyBrainAgent } from "../turn/agent"
import {
	BRAIN_TAG_LABELS_METADATA_KEY,
	BRAIN_TAGS_METADATA_KEY,
	type BrainMemoryTag,
	ensureBrainMemoryTagTable,
	listBrainMemoryTags,
	NODE_PATH_DELIM,
	nodeLabel,
	nodePathSegments,
	normalizeBrainTagKey,
} from "./tags"

const OUTLINE_TAG_LIMIT = 500
const MAPPING_PAGE_SIZE = 500
const HYDRATION_DOCUMENT_ID_CHUNK = 100
const POSTGRES_QUERY_CONCURRENCY = 4
const TOPIC_TREE_TAG_KINDS = new Set<BrainMemoryTag["kind"]>([
	"topic",
	"project",
	"customer",
	"team",
])

function isTopicTreeTag(tag: BrainMemoryTag): boolean {
	return TOPIC_TREE_TAG_KINDS.has(tag.kind)
}

function normalizeContainerTag(containerTag: string): string | null {
	return containerTag.trim() || null
}

function chunksOf<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = []
	for (let offset = 0; offset < items.length; offset += size) {
		chunks.push(items.slice(offset, offset + size))
	}
	return chunks
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	mapper: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length)
	let nextIndex = 0
	let failed = false
	let failure: unknown
	const run = async (): Promise<void> => {
		if (failed) return
		const index = nextIndex++
		if (index >= items.length) return
		try {
			results[index] = await mapper(items[index] as T)
		} catch (error) {
			if (!failed) failure = error
			failed = true
			return
		}
		return run()
	}
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, () =>
			runInDbScope(run),
		),
	)
	if (failed) throw failure
	return results
}

export type BrainTreeNode = {
	path: string
	label: string
	depth: number
	subtagCount: number
	children: BrainTreeNode[]
}

export type BrainNodeMapping = {
	documentId: string
	containerTag: string
	nodePath: string
}

export type HydratedBrainNodeMemory = {
	documentId: string
	memoryId: string
	memory: string
	updatedAt: Date
}

export function ensureBrainMemoryStateTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_memory_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			reset_epoch INTEGER NOT NULL
		)
	`
	agent.sql`
		INSERT OR IGNORE INTO brain_memory_state (id, reset_epoch) VALUES (1, 0)
	`
}

export function getBrainMemoryResetEpoch(agent: CompanyBrainAgent): number {
	ensureBrainMemoryStateTable(agent)
	return (
		agent.sql<{ reset_epoch: number }>`
			SELECT reset_epoch FROM brain_memory_state WHERE id = 1
		`[0]?.reset_epoch ?? 0
	)
}

export function isBrainMemoryResetEpochCurrent(
	agent: CompanyBrainAgent,
	epoch: number,
): boolean {
	return getBrainMemoryResetEpoch(agent) === epoch
}

export function advanceBrainMemoryResetEpoch(agent: CompanyBrainAgent): number {
	ensureBrainMemoryStateTable(agent)
	return (
		agent.sql<{ reset_epoch: number }>`
		UPDATE brain_memory_state
		SET reset_epoch = reset_epoch + 1
		WHERE id = 1
		RETURNING reset_epoch
	`[0]?.reset_epoch ?? 0
	)
}

export function ensureBrainMemoryNodeTable(agent: CompanyBrainAgent): void {
	const columns = agent.sql<{
		name: string
		pk: number
	}>`PRAGMA table_info(brain_memory_node)`
	const tableExists = columns.length > 0
	const hasCustomId = columns.some((column) => column.name === "custom_id")
	// node_path now joins the PK so one document can live under several topic nodes.
	const nodePathInPk = columns.some(
		(column) => column.name === "node_path" && column.pk > 0,
	)
	if (tableExists && hasCustomId) {
		// Legacy custom_id schema predates node_path and can't be migrated.
		agent.sql`DROP TABLE brain_memory_node`
	} else if (tableExists && !nodePathInPk) {
		// Old single-node PK — add node_path to the PK WITHOUT dropping existing
		// mappings (a drop would make upgraded orgs' tree reads empty).
		agent.sql`ALTER TABLE brain_memory_node RENAME TO brain_memory_node_legacy`
		agent.sql`
			CREATE TABLE brain_memory_node (
				document_id TEXT NOT NULL,
				container_tag TEXT NOT NULL,
				node_path TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (document_id, container_tag, node_path)
			)
		`
		agent.sql`
			INSERT OR IGNORE INTO brain_memory_node (document_id, container_tag, node_path, created_at, updated_at)
			SELECT document_id, container_tag, node_path, created_at, updated_at
			FROM brain_memory_node_legacy
		`
		agent.sql`DROP TABLE brain_memory_node_legacy`
	}
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_memory_node (
			document_id TEXT NOT NULL,
			container_tag TEXT NOT NULL,
			node_path TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (document_id, container_tag, node_path)
		)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS idx_brain_memory_node_path
		ON brain_memory_node (container_tag, node_path)
	`
}

export function upsertBrainMemoryNode(
	agent: CompanyBrainAgent,
	mapping: BrainNodeMapping,
	expectedResetEpoch: number,
): boolean {
	const documentId = mapping.documentId.trim()
	const containerTag = normalizeContainerTag(mapping.containerTag)
	const nodePath = normalizeBrainTagKey(mapping.nodePath)
	if (!documentId || !containerTag || nodePath === "other") return false
	if (!isBrainMemoryResetEpochCurrent(agent, expectedResetEpoch)) return false
	ensureBrainMemoryNodeTable(agent)
	const now = Date.now()
	agent.sql`
		INSERT INTO brain_memory_node (document_id, container_tag, node_path, created_at, updated_at)
		VALUES (${documentId}, ${containerTag}, ${nodePath}, ${now}, ${now})
		ON CONFLICT(document_id, container_tag, node_path) DO UPDATE SET
			updated_at = excluded.updated_at
	`
	return true
}

export function listBrainMemoryNodeMappings(
	agent: CompanyBrainAgent,
	params: {
		containerTags: string[]
		nodePath: string
		descendants: boolean
	},
): BrainNodeMapping[] {
	const nodePath = normalizeBrainTagKey(params.nodePath)
	if (nodePath === "other") return []
	const containerTags = [
		...new Set(
			params.containerTags.flatMap((tag) => {
				const normalized = normalizeContainerTag(tag)
				return normalized ? [normalized] : []
			}),
		),
	]
	if (!containerTags.length) return []
	ensureBrainMemoryNodeTable(agent)
	const descendantPattern = `${nodePath}${NODE_PATH_DELIM}*`
	type Row = {
		document_id: string
		container_tag: string
		node_path: string
	}
	const rows: Row[] = []
	for (const containerTag of containerTags) {
		for (let offset = 0; ; offset += MAPPING_PAGE_SIZE) {
			const page = params.descendants
				? agent.sql<Row>`
						SELECT document_id, container_tag, node_path
						FROM brain_memory_node
						WHERE container_tag = ${containerTag}
							AND (node_path = ${nodePath} OR node_path GLOB ${descendantPattern})
						ORDER BY document_id
						LIMIT ${MAPPING_PAGE_SIZE} OFFSET ${offset}
					`
				: agent.sql<Row>`
						SELECT document_id, container_tag, node_path
						FROM brain_memory_node
						WHERE container_tag = ${containerTag} AND node_path = ${nodePath}
						ORDER BY document_id
						LIMIT ${MAPPING_PAGE_SIZE} OFFSET ${offset}
					`
			rows.push(...page)
			if (page.length < MAPPING_PAGE_SIZE) break
		}
	}
	return rows.map((row) => ({
		documentId: row.document_id,
		containerTag: row.container_tag,
		nodePath: row.node_path,
	}))
}

function deleteBrainMemoryNodeMappings(
	agent: CompanyBrainAgent,
	mappings: BrainNodeMapping[],
): void {
	for (const mapping of mappings) {
		agent.sql`
			DELETE FROM brain_memory_node
			WHERE document_id = ${mapping.documentId}
				AND container_tag = ${mapping.containerTag}
		`
	}
}

export async function reconcileBrainMemoryNodeMappings(
	env: Env,
	orgId: string,
	agent: CompanyBrainAgent,
	mappings: BrainNodeMapping[],
): Promise<BrainNodeMapping[]> {
	const valid = new Set<string>()
	const byId = new Map(mappings.map((mapping) => [mapping.documentId, mapping]))
	const documentIds = [...byId.keys()]
	const pages = await mapWithConcurrency(
		chunksOf(documentIds, HYDRATION_DOCUMENT_ID_CHUNK),
		POSTGRES_QUERY_CONCURRENCY,
		(chunk) => documentStatuses(env, chunk),
	)
	for (const statuses of pages) {
		for (const row of statuses.values()) {
			if (row.status !== "failed") valid.add(row.id)
		}
	}
	const stale = mappings.filter((mapping) => !valid.has(mapping.documentId))
	deleteBrainMemoryNodeMappings(agent, stale)
	return mappings.filter((mapping) => valid.has(mapping.documentId))
}

export function repointBrainMemoryNodes(
	agent: CompanyBrainAgent,
	containerTag: string,
	documentIds: string[],
	expectedPath: string,
	newPath: string,
	expectedResetEpoch: number,
): string[] {
	const scope = normalizeContainerTag(containerTag)
	const parentPath = normalizeBrainTagKey(expectedPath)
	const nodePath = normalizeBrainTagKey(newPath)
	const ids = [
		...new Set(
			documentIds.flatMap((id) => {
				const normalized = id.trim()
				return normalized ? [normalized] : []
			}),
		),
	]
	if (!scope || !ids.length || parentPath === "other" || nodePath === "other") {
		return []
	}
	if (!isBrainMemoryResetEpochCurrent(agent, expectedResetEpoch)) return []
	ensureBrainMemoryNodeTable(agent)
	const moved: string[] = []
	const now = Date.now()
	for (const documentId of ids) {
		// node_path is part of the PK; OR REPLACE drops a pre-existing child row
		// for this document instead of failing the move.
		const updated = agent.sql<{ document_id: string }>`
			UPDATE OR REPLACE brain_memory_node
			SET node_path = ${nodePath}, updated_at = ${now}
			WHERE document_id = ${documentId}
				AND container_tag = ${scope}
				AND node_path = ${parentPath}
			RETURNING document_id
		`
		if (updated[0]) moved.push(updated[0].document_id)
	}
	return moved
}

// Keep tag-based recall (sm_brain_tags) in sync with node repoints from a split.
// ADD the child key rather than replacing the parent: a memory can have several
// source documents, so removing the parent could strip a tag another still-parent
// source justifies. Adds commute, so overlapping child updates don't race.
export async function repointBrainMemoryMetadata(
	env: Env,
	orgId: string,
	documentIds: string[],
	oldNodePath: string,
	newPath: string,
	newLabel: string,
): Promise<void> {
	const ids = [
		...new Set(
			documentIds.flatMap((id) => {
				const trimmed = id.trim()
				return trimmed ? [trimmed] : []
			}),
		),
	]
	const oldKey = normalizeBrainTagKey(oldNodePath)
	const newKey = normalizeBrainTagKey(newPath)
	if (!ids.length || oldKey === newKey) return
	// Tags live on the documents the brain wrote, so a split re-tags those
	// rather than the memories supermemory derived from them.
	const rows = (
		await mapWithConcurrency(ids, POSTGRES_QUERY_CONCURRENCY, (id) =>
			getBrainDocument(env, id),
		)
	).filter((row): row is NonNullable<typeof row> => row !== null)
	const updates = rows.flatMap((row) => {
		const metadata = (row.metadata ?? {}) as Record<string, unknown>
		const keys = metadata[BRAIN_TAGS_METADATA_KEY]
		if (!Array.isArray(keys)) return []
		// Only augment memories actually under the parent node; skip if already
		// carrying the child (idempotent across retries and re-splits).
		if (!keys.includes(oldKey) || keys.includes(newKey)) return []
		const nextKeys = [...keys, newKey]
		const labels = metadata[BRAIN_TAG_LABELS_METADATA_KEY]
		const nextLabels = Array.isArray(labels) ? [...labels, newLabel] : null
		return [
			{
				id: row.id,
				metadata: {
					...metadata,
					[BRAIN_TAGS_METADATA_KEY]: nextKeys,
					...(nextLabels
						? { [BRAIN_TAG_LABELS_METADATA_KEY]: nextLabels }
						: {}),
				},
			},
		]
	})
	await mapWithConcurrency(updates, POSTGRES_QUERY_CONCURRENCY, (update) =>
		updateBrainDocumentMetadata(env, update.id, update.metadata),
	)
}

export function clearBrainMemoryRegistry(agent: CompanyBrainAgent): void {
	ensureBrainMemoryTagTable(agent)
	ensureBrainMemoryNodeTable(agent)
	agent.sql`DELETE FROM brain_memory_node`
	agent.sql`DELETE FROM brain_memory_tag`
}

// Every topic-tree tag is its own node, so a memory spanning e.g. a project and a
// customer is retrievable under both branches, not just the deepest.
export function pickNodePaths(tags: BrainMemoryTag[]): string[] {
	return [
		...new Set(tags.flatMap((tag) => (isTopicTreeTag(tag) ? [tag.key] : []))),
	]
}

type BuildNode = {
	path: string
	label: string
	depth: number
	subtagCount: number
	children: Map<string, BuildNode>
}

export function outlineBrainTree(
	agent: CompanyBrainAgent,
	params: { currentContainerTags?: string[] | null } = {},
): BrainTreeNode[] {
	const tags = listBrainMemoryTags(agent, {
		currentContainerTags: params.currentContainerTags,
		limit: OUTLINE_TAG_LIMIT,
	}).filter(isTopicTreeTag)
	const roots = new Map<string, BuildNode>()
	const ensure = (
		level: Map<string, BuildNode>,
		path: string,
		depth: number,
	): BuildNode => {
		let node = level.get(path)
		if (!node) {
			node = {
				path,
				label: nodeLabel(path),
				depth,
				subtagCount: 0,
				children: new Map(),
			}
			level.set(path, node)
		}
		return node
	}
	for (const tag of tags) {
		const segs = nodePathSegments(tag.key)
		let level = roots
		let prefix = ""
		for (let i = 0; i < segs.length; i++) {
			const seg = segs[i]
			if (!seg) continue
			prefix = prefix ? `${prefix}${NODE_PATH_DELIM}${seg}` : seg
			const node = ensure(level, prefix, i)
			node.subtagCount += 1
			if (prefix === tag.key) node.label = tag.label
			level = node.children
		}
	}
	const toOut = (n: BuildNode): BrainTreeNode => ({
		path: n.path,
		label: n.label,
		depth: n.depth,
		subtagCount: n.subtagCount,
		children: [...n.children.values()]
			.sort((a, b) => b.subtagCount - a.subtagCount)
			.map(toOut),
	})
	return [...roots.values()]
		.sort((a, b) => b.subtagCount - a.subtagCount)
		.map(toOut)
}

export function renderBrainTreeOutline(
	nodes: BrainTreeNode[],
	opts?: { maxRoots?: number; maxChildren?: number },
): string {
	const maxRoots = opts?.maxRoots ?? 20
	const maxChildren = opts?.maxChildren ?? 6
	const lines: string[] = []
	for (const root of nodes.slice(0, maxRoots)) {
		const kids = root.children.slice(0, maxChildren).map((c) => c.label)
		const more =
			root.children.length > maxChildren
				? `, +${root.children.length - maxChildren}`
				: ""
		lines.push(
			`- ${root.label}${kids.length ? ` › ${kids.join(", ")}${more}` : ""}`,
		)
	}
	if (nodes.length > maxRoots) {
		lines.push(`- (+${nodes.length - maxRoots} more topics)`)
	}
	return lines.join("\n")
}

export async function hydrateLiveBrainNodeMappings(
	env: Env,
	orgId: string,
	mappings: BrainNodeMapping[],
	limitPerChunk: number,
	range?: { before?: Date; after?: Date },
): Promise<HydratedBrainNodeMemory[]> {
	const byContainer = new Map<string, BrainNodeMapping[]>()
	for (const mapping of mappings) {
		const scoped = byContainer.get(mapping.containerTag) ?? []
		scoped.push(mapping)
		byContainer.set(mapping.containerTag, scoped)
	}
	const batches = [...byContainer].flatMap(([containerTag, scopedMappings]) =>
		chunksOf(scopedMappings, HYDRATION_DOCUMENT_ID_CHUNK).map((chunk) => ({
			containerTag,
			documentIds: chunk.map((mapping) => mapping.documentId),
		})),
	)
	// A node's content used to be the memory entries derived from its documents.
	// The public API does not expose that derivation, so a node hydrates from
	// the documents the brain wrote under it — the same substance, one level up.
	const pages = await mapWithConcurrency(
		batches,
		POSTGRES_QUERY_CONCURRENCY,
		async ({ documentIds }) => {
			const documents = await mapWithConcurrency(
				documentIds,
				POSTGRES_QUERY_CONCURRENCY,
				(id) => getBrainDocument(env, id),
			)
			return documents
				.flatMap((doc) => {
					const text = doc?.content?.trim()
					if (!doc || !text) return []
					const updatedAt = new Date(doc.createdAt)
					if (range?.before && updatedAt >= range.before) return []
					if (range?.after && updatedAt < range.after) return []
					return [
						{
							documentId: doc.id,
							memoryId: doc.id,
							memory: text,
							updatedAt,
						},
					]
				})
				.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
				.slice(0, Math.max(1, limitPerChunk))
		},
	)
	const rows = pages.flat()
	return rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
}

export async function hydrateLiveBrainNodeDocuments(
	env: Env,
	orgId: string,
	mappings: BrainNodeMapping[],
): Promise<HydratedBrainNodeMemory[]> {
	const byContainer = new Map<string, BrainNodeMapping[]>()
	for (const mapping of mappings) {
		const scoped = byContainer.get(mapping.containerTag) ?? []
		scoped.push(mapping)
		byContainer.set(mapping.containerTag, scoped)
	}
	const batches = [...byContainer].flatMap(([containerTag, scopedMappings]) =>
		chunksOf(scopedMappings, HYDRATION_DOCUMENT_ID_CHUNK).map((chunk) => ({
			containerTag,
			documentIds: chunk.map((mapping) => mapping.documentId),
		})),
	)
	const pages = await mapWithConcurrency(
		batches,
		POSTGRES_QUERY_CONCURRENCY,
		async ({ documentIds }) => {
			const documents = await mapWithConcurrency(
				documentIds,
				POSTGRES_QUERY_CONCURRENCY,
				(id) => getBrainDocument(env, id),
			)
			return documents.flatMap((doc) => {
				const text = doc?.content?.trim()
				if (!doc || !text) return []
				return [
					{
						documentId: doc.id,
						memoryId: doc.id,
						memory: text,
						updatedAt: new Date(doc.createdAt),
					},
				]
			})
		},
	)
	const rows = pages.flat()
	return rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
}

export async function fetchSubtreeBrainMemories(
	env: Env,
	agent: CompanyBrainAgent,
	params: {
		orgId: string
		containerTags: string[]
		nodePath: string
		limit: number
		before?: Date
		after?: Date
	},
): Promise<Array<{ memory: string; updatedAt: Date }>> {
	const mappings = await reconcileBrainMemoryNodeMappings(
		env,
		params.orgId,
		agent,
		listBrainMemoryNodeMappings(agent, {
			containerTags: params.containerTags,
			nodePath: params.nodePath,
			descendants: true,
		}),
	)
	if (!mappings.length) return []
	const rows = await hydrateLiveBrainNodeMappings(
		env,
		params.orgId,
		mappings,
		params.limit,
		{ before: params.before, after: params.after },
	)
	const seen = new Set<string>()
	const memories: Array<{ memory: string; updatedAt: Date }> = []
	for (const row of rows) {
		const memory = row.memory.trim()
		if (!memory || seen.has(row.memoryId)) continue
		seen.add(row.memoryId)
		memories.push({ memory, updatedAt: row.updatedAt })
		if (memories.length >= params.limit) break
	}
	return memories
}
