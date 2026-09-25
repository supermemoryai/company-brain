import { useCallback } from "react"
import { usePathname, useRouter } from "@lib/navigation"

// The hosted app had many views; the brain keeps its home, the memory graph
// and Configure.
export type ViewMode = "dashboard" | "graph" | "configure"

export function useViewMode() {
	const pathname = usePathname()
	const router = useRouter()
	const viewMode: ViewMode = pathname.startsWith("/configure")
		? "configure"
		: pathname.startsWith("/graph")
			? "graph"
			: "dashboard"
	const setViewMode = useCallback(
		(mode: ViewMode | string) => {
			router.push(
				mode === "configure" ? "/configure" : mode === "graph" ? "/graph" : "/",
			)
		},
		[router],
	)
	return { viewMode, setViewMode, isInitialized: true }
}
