import { useInfiniteQuery } from "@tanstack/react-query"
import { useEffect, useMemo } from "react"
import { BACKEND } from "@lib/api"
import type {
	GraphApiDocument,
	GraphApiMemory,
	MemoryRelation,
} from "@supermemory/memory-graph"

const PAGE_SIZE = 200

interface UseGraphApiOptions {
	enabled?: boolean
	maxNodes?: number
}

interface ApiMemoryEntry {
	id: string
	memory: string
	content?: string | null
	spaceId: string
	isStatic?: boolean
	isLatest?: boolean
	isForgotten?: boolean
	forgetAfter?: string | null
	forgetReason?: string | null
	version?: number
	parentMemoryId?: string | null
	rootMemoryId?: string | null
	createdAt: string
	updatedAt: string
	relation?: MemoryRelation | null
	updatesMemoryId?: string | null
	nextVersionId?: string | null
	memoryRelations?: Record<string, MemoryRelation> | null
	spaceContainerTag?: string | null
}

interface ApiDocument {
	id: string
	title: string | null
	summary?: string | null
	type: string
	createdAt: string
	updatedAt: string
	memoryEntries: ApiMemoryEntry[]
}

interface ApiDocumentsResponse {
	documents: ApiDocument[]
	pagination: {
		currentPage: number
		limit: number
		totalItems: number
		totalPages: number
	}
}

function getGraphNodeCount(documents: ApiDocument[]): number {
	return documents.reduce(
		(total, doc) => total + 1 + (doc.memoryEntries?.length ?? 0),
		0,
	)
}

function toGraphMemory(mem: ApiMemoryEntry): GraphApiMemory {
	return {
		id: mem.id,
		memory: mem.memory ?? mem.content ?? "",
		isStatic: mem.isStatic ?? false,
		spaceId: mem.spaceId ?? "",
		isLatest: mem.isLatest ?? true,
		isForgotten: mem.isForgotten ?? false,
		forgetAfter: mem.forgetAfter ?? null,
		forgetReason: mem.forgetReason ?? null,
		version: mem.version ?? 1,
		parentMemoryId: mem.parentMemoryId ?? null,
		rootMemoryId: mem.rootMemoryId ?? null,
		createdAt: mem.createdAt,
		updatedAt: mem.updatedAt,
		relation: mem.relation ?? null,
		updatesMemoryId: mem.updatesMemoryId ?? null,
		nextVersionId: mem.nextVersionId ?? null,
		memoryRelations: mem.memoryRelations ?? null,
		spaceContainerTag: mem.spaceContainerTag ?? null,
	}
}

// The server already narrowed memory entries to what this person may see.
function toGraphDocument(doc: ApiDocument): GraphApiDocument {
	return {
		id: doc.id,
		title: doc.title,
		summary: doc.summary ?? null,
		documentType: doc.type,
		createdAt: doc.createdAt,
		updatedAt: doc.updatedAt,
		memories: (doc.memoryEntries ?? []).map(toGraphMemory),
	}
}

/**
 * Pages of documents with their memories from /brain/graph, which scopes them
 * to the shared team brain plus the viewer's own private container.
 */
export function useGraphApi(options: UseGraphApiOptions = {}) {
	const { enabled = true, maxNodes } = options

	const {
		data,
		error,
		isPending,
		isFetchingNextPage,
		hasNextPage,
		fetchNextPage,
	} = useInfiniteQuery<ApiDocumentsResponse, Error>({
		queryKey: ["brain", "graph", maxNodes],
		initialPageParam: 1,
		queryFn: async ({ pageParam }) => {
			const res = await fetch(`${BACKEND}/brain/graph`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ page: pageParam, limit: PAGE_SIZE }),
			})
			if (!res.ok) throw new Error("Failed to load the memory graph")
			return res.json()
		},
		getNextPageParam: (lastPage, allPages) => {
			if (maxNodes != null) {
				const loadedNodes = allPages.reduce(
					(total, page) => total + getGraphNodeCount(page.documents ?? []),
					0,
				)
				if (loadedNodes >= maxNodes) return undefined
			}

			const { currentPage, totalPages } = lastPage.pagination
			return currentPage < totalPages ? currentPage + 1 : undefined
		},
		staleTime: 5 * 60 * 1000,
		enabled,
	})

	const loadedNodeCount = useMemo(() => {
		if (!data?.pages) return 0
		return data.pages.reduce(
			(total, page) => total + getGraphNodeCount(page.documents ?? []),
			0,
		)
	}, [data])

	useEffect(() => {
		if (!enabled) return
		if (!hasNextPage || isFetchingNextPage) return
		if (maxNodes != null && loadedNodeCount >= maxNodes) return
		fetchNextPage()
	}, [
		enabled,
		hasNextPage,
		isFetchingNextPage,
		loadedNodeCount,
		maxNodes,
		fetchNextPage,
	])

	const documents = useMemo(() => {
		if (!data?.pages) return []
		return data.pages.flatMap((page) => page.documents.map(toGraphDocument))
	}, [data])

	const totalCount = data?.pages[0]?.pagination.totalItems ?? 0

	return {
		documents,
		isLoading: isPending,
		isLoadingMore: isFetchingNextPage,
		error: error ?? null,
		hasMore: hasNextPage ?? false,
		loadMore: fetchNextPage,
		totalCount,
	}
}
