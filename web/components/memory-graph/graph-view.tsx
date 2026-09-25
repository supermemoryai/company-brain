import {
	type GraphThemeColors,
	MemoryGraph as MemoryGraphBase,
} from "@supermemory/memory-graph"
import { Loader2 } from "lucide-react"
import { dmSansClassName } from "@lib/fonts"
import { useGraphApi } from "./use-graph-api"

const MAX_NODES = 4000

// The brain's memories as a graph: documents it wrote and the memories
// supermemory derived from them, for the shared brain and your own container.
export function GraphView() {
	const { documents, isLoading, isLoadingMore, error, hasMore, loadMore, totalCount } =
		useGraphApi({ maxNodes: MAX_NODES })

	return (
		<div className="relative flex min-h-0 w-full flex-1 flex-col">
			<div className="absolute inset-0 [&>div]:!h-full [&>div]:!bg-none">
				<MemoryGraphBase
					documents={documents}
					isLoading={false}
					isLoadingMore={false}
					onLoadMore={hasMore && !isLoadingMore ? () => loadMore() : undefined}
					hasMore={hasMore}
					error={error}
					variant="consumer"
					maxNodes={MAX_NODES}
					totalCount={totalCount}
					colors={
						{
							bg: "transparent",
							edgeDerives: "#9ca3af",
						} satisfies Partial<GraphThemeColors>
					}
				>
					<div className="flex h-full items-center justify-center px-6">
						<p
							className={dmSansClassName(
								"max-w-sm text-center text-[13px] text-[#8B929E]",
							)}
						>
							Nothing in the brain yet. Once it starts remembering what your
							team says in Slack, the memories show up here.
						</p>
					</div>
				</MemoryGraphBase>
				{isLoading && (
					<div className="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center gap-3">
						<Loader2 className="size-6 animate-spin text-[#4BA0FA]" />
						<span className={dmSansClassName("text-[13px] text-slate-100")}>
							Loading memory graph...
						</span>
					</div>
				)}
			</div>
		</div>
	)
}
