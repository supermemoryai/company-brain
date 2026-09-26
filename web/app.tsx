import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Redirect, Route, Switch } from "wouter"
import { AnimatedGradientBackground } from "@/components/animated-gradient-background"
import { BrainHomeView } from "@/components/brain-home/brain-home-view"
import { CompanyBrainHeader } from "@/components/company-brain-header"
import { ConfigureView } from "@/components/configure-view"
import { ErrorBoundary } from "@/components/error-boundary"
import { GraphView } from "@/components/memory-graph/graph-view"
import { SlackHandoff } from "@/components/onboarding-brain/slack-handoff"
import { SignIn } from "@/components/sign-in"
import { useAuth } from "@lib/auth-context"
import { useViewMode } from "@lib/view-mode-context"
import { cn } from "@lib/utils"

function ViewErrorFallback() {
	return (
		<p className="py-10 text-center text-[13px] text-[#8B929E]">
			Something went wrong loading this view. Reload to try again.
		</p>
	)
}

// ?slack=connected is where the Slack install flow lands; take over the screen
// once to point people at Slack, and surface install failures as a toast.
function useSlackHandoff() {
	const [handoff, setHandoff] = useState<{ team: string | null } | null>(null)
	useEffect(() => {
		const params = new URLSearchParams(window.location.search)
		const slack = params.get("slack")
		if (slack !== "connected" && slack !== "error") return
		if (slack === "connected") setHandoff({ team: params.get("team") })
		else
			toast.error(
				params.get("reason") === "expired"
					? "That Slack connect link expired. Try connecting again."
					: "Slack connection failed. Try again.",
				{ duration: 10000 },
			)
		for (const key of ["slack", "team", "reason"]) params.delete(key)
		const qs = params.toString()
		window.history.replaceState(
			null,
			"",
			window.location.pathname + (qs ? `?${qs}` : ""),
		)
	}, [])
	return [handoff, () => setHandoff(null)] as const
}

export function App() {
	const { user, org, isRestoring, setupComplete } = useAuth()
	const { viewMode } = useViewMode()
	const [handoff, dismissHandoff] = useSlackHandoff()

	if (isRestoring) return <div className="min-h-dvh bg-[#05080D]" />
	if (!user || !org) {
		// A fresh deploy lands here first; setup is where it needs to go.
		if (setupComplete === false) {
			window.location.replace("/setup")
			return <div className="min-h-dvh bg-[#05080D]" />
		}
		return <SignIn />
	}

	return (
		<>
			{handoff && (
				<SlackHandoff teamName={handoff.team} onDismiss={dismissHandoff} />
			)}
			<div className="relative flex min-h-dvh flex-col bg-[#05080D]">
				{viewMode === "dashboard" && (
					<div className="pointer-events-none fixed inset-0 z-0">
						<AnimatedGradientBackground animateFromBottom={false} />
						<div className="absolute inset-0 bg-[#05080D]/50" aria-hidden />
						<div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(105,167,240,0.25)_1px,transparent_1px)] bg-size-[32px_32px] mask-[radial-gradient(ellipse_at_center,black_60%,transparent_100%)]" />
					</div>
				)}
				<CompanyBrainHeader />
				<main className="relative z-10 flex min-h-0 flex-1 flex-col">
					<div className="relative z-10 flex min-h-0 flex-1 flex-col md:flex-row">
						<ErrorBoundary key={viewMode} fallback={<ViewErrorFallback />}>
							<Switch>
								<Route path="/">
									<div
										className={cn(
											"min-h-0 min-w-0 flex-1 overflow-y-auto p-4 pt-2! pb-[180px] md:p-6",
										)}
									>
										<BrainHomeView />
									</div>
								</Route>
								<Route path="/graph">
									<div className="relative flex min-h-[calc(100dvh-64px)] min-w-0 flex-1">
										<GraphView />
									</div>
								</Route>
								<Route path="/configure/*?">
									<div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 pt-2! md:p-6">
										<ConfigureView />
									</div>
								</Route>
								<Route>
									<Redirect to="/" replace />
								</Route>
							</Switch>
						</ErrorBoundary>
					</div>
				</main>
			</div>
		</>
	)
}
