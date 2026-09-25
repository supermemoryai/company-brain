import { BACKEND } from "@lib/api"
import { useAuth } from "@lib/auth-context"
import { dmSans125ClassName } from "@lib/fonts"
import { cn } from "@lib/utils"
import { useViewMode } from "@lib/view-mode-context"
import { useQuery } from "@tanstack/react-query"
import { ArrowRight, Check, Loader2 } from "lucide-react"
import {
	AskInSlackCard,
	CONNECT_TOOLS_CARD_ID,
	ConnectToolsCard,
	useConnectionsBoard,
} from "./connections-board"

const cardStyle = {
	boxShadow:
		"0 2.842px 14.211px 0 rgba(0, 0, 0, 0.25), 0.711px 0.711px 0.711px 0 rgba(255, 255, 255, 0.10) inset",
}

type RolloutOverview = {
	status: "running" | "done" | "failed"
	discovered: number
	joined: number
	ready: number
	introduced: number
	failed: number
}

type BrainOverview = {
	research: { status: string | null }
	slack: {
		connected: boolean
		teamName: string | null
		rollout: RolloutOverview | null
	}
	connections: { apps: number }
	members: { count: number }
}

// The hosted home also counted memories and listed recent documents through
// the private documents API; the public API has no listing, so those are gone.
function useBrainOverview() {
	const { user, org, isAdmin } = useAuth()
	const enabled = !!user && !!org?.id

	const overview = useQuery({
		queryKey: ["brain-overview", org?.id],
		queryFn: async (): Promise<BrainOverview | null> => {
			const res = await fetch(`${BACKEND}/brain/overview`, {
				credentials: "include",
			})
			if (!res.ok) return null
			return (await res.json()) as BrainOverview
		},
		staleTime: 30_000,
		enabled,
	})

	const slackConnected = overview.data?.slack.connected ?? false
	const appsCount = overview.data?.connections.apps ?? 0

	return {
		loading: overview.isPending,
		connectedCount: appsCount + (slackConnected ? 1 : 0),
		membersCount: overview.data?.members.count ?? 0,
		isAdmin,
		hasApps: appsCount > 0,
		slackConnected,
		teamName: overview.data?.slack.teamName ?? null,
		researchStatus: overview.data?.research.status ?? null,
		rollout: overview.data?.slack.rollout ?? null,
	}
}

export function BrainHomeView() {
	const o = useBrainOverview()
	const board = useConnectionsBoard()
	// Rows with no reported state (older orgs, pre-Slack) don't count or render.
	const milestones = [
		...(o.researchStatus != null ? [o.researchStatus === "done"] : []),
		o.slackConnected,
		...(o.rollout != null ? [o.rollout.status === "done"] : []),
		o.hasApps,
		o.membersCount > 1,
	]
	const milestonesDone = milestones.filter(Boolean).length
	const milestonesTotal = milestones.length

	return (
		<div className="mx-auto max-w-[1080px] space-y-6">
			<StatsRow
				connected={o.connectedCount}
				members={o.membersCount}
				setupDone={milestonesDone}
				setupTotal={milestonesTotal}
				teamName={o.teamName}
			/>
			<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
				<div className="min-w-0 space-y-6">
					{board.showBoard && <ConnectToolsCard board={board} />}
				</div>
				<div className="min-w-0 space-y-6">
					{!o.loading && (
						<BrainTimeline
							researchStatus={o.researchStatus}
							slackConnected={o.slackConnected}
							rollout={o.rollout}
							hasApps={o.hasApps}
							invited={o.membersCount > 1}
							canInstall={o.isAdmin}
							toolsCardVisible={board.showBoard}
						/>
					)}
					<AskInSlackCard board={board} />
				</div>
			</div>
		</div>
	)
}

function StatsRow({
	connected,
	members,
	setupDone,
	setupTotal,
	teamName,
}: {
	connected: number
	members: number
	setupDone: number
	setupTotal: number
	teamName: string | null
}) {
	const tiles: { label: string; mobile?: string; value: string }[] = [
		{ label: "Connected sources", mobile: "Sources", value: String(connected) },
		{ label: "Active members", mobile: "Members", value: String(members) },
		{ label: "Setup", value: `${setupDone}/${setupTotal}` },
		{ label: "Slack", value: teamName ?? "—" },
	]
	return (
		<section
			className="grid grid-cols-4 divide-x divide-white/[0.04] overflow-hidden rounded-[16px] bg-[#1B1F24]"
			style={cardStyle}
		>
			{tiles.map((t) => (
				<div key={t.label} className="relative min-w-0 px-3 py-3 sm:px-5 sm:py-4">
					<p className="min-w-0 truncate text-[8px] font-semibold uppercase leading-tight tracking-[0.08em] text-[#737373] sm:text-[10px] sm:tracking-[0.12em]">
						<span className="sm:hidden">{t.mobile ?? t.label}</span>
						<span className="hidden sm:inline">{t.label}</span>
					</p>
					<p
						className={cn(
							"mt-1 truncate text-[17px] font-semibold leading-none tabular-nums text-[#fafafa] sm:mt-1.5 sm:text-[22px]",
							dmSans125ClassName(),
						)}
					>
						{t.value}
					</p>
				</div>
			))}
		</section>
	)
}

function BrainTimeline({
	researchStatus,
	slackConnected,
	rollout,
	hasApps,
	invited,
	canInstall,
	toolsCardVisible,
}: {
	researchStatus: string | null
	slackConnected: boolean
	rollout: RolloutOverview | null
	hasApps: boolean
	invited: boolean
	canInstall: boolean
	toolsCardVisible: boolean
}) {
	const { setViewMode } = useViewMode()

	const onSetUpApps = () => {
		const card = document.getElementById(CONNECT_TOOLS_CARD_ID)
		if (toolsCardVisible && card) {
			card.scrollIntoView({ behavior: "smooth", block: "center" })
		} else {
			setViewMode("configure")
		}
	}

	const researching =
		researchStatus === "queued" || researchStatus === "running"
	type Step = {
		done: boolean
		busy?: boolean
		title: string
		hint?: string
		action?: { label: string; onClick?: () => void; href?: string }
	}
	// Rows with unreported state are omitted rather than shown as never-started.
	const steps: Step[] = [
		...(researchStatus != null
			? [
					{
						done: researchStatus === "done",
						busy: researching,
						title: researching
							? "Researching your company…"
							: "Company research",
					},
				]
			: []),
		{
			done: slackConnected,
			title: slackConnected ? "Slack connected" : "Install to Slack",
			hint: slackConnected
				? undefined
				: canInstall
					? "Ask your brain from any channel."
					: "Ask a workspace admin to install the bot.",
			action:
				slackConnected || !canInstall
					? undefined
					: { label: "Install", href: `${BACKEND}/brain/slack/oauth/install` },
		},
		...(rollout != null
			? [
					{
						done: rollout.status === "done",
						busy: rollout.status === "running",
						title:
							rollout.status === "running"
								? `Learning from channels… ${rollout.ready}/${rollout.discovered} ready`
								: rollout.status === "done"
									? `Learning from channels · ${rollout.ready} ready`
									: "Learning from channels",
					},
				]
			: []),
		{
			done: hasApps,
			title: "Connect apps",
			hint: hasApps ? undefined : "Linear, Notion, GitHub and more.",
			action: hasApps ? undefined : { label: "Set up", onClick: onSetUpApps },
		},
		{
			done: invited,
			title: "Teammates join",
			hint: invited
				? undefined
				: "People join when they talk to the bot or sign in with Slack.",
		},
	]

	return (
		<section
			className="relative h-fit overflow-hidden rounded-[18px] bg-[#1B1F24] p-5"
			style={cardStyle}
		>
			<div
				aria-hidden
				className="absolute -top-px right-8 left-8 h-px"
				style={{
					background:
						"linear-gradient(to right, transparent, rgba(75,160,250,0.45), transparent)",
				}}
			/>
			<p
				className={cn(
					"text-[15px] font-semibold text-[#fafafa]",
					dmSans125ClassName(),
				)}
			>
				Your Company Brain
			</p>
			<p className="mb-4 mt-0.5 text-[12px] font-medium text-[#737373]">
				How far you've come.
			</p>

			<ul className="space-y-2.5">
				{steps.map((step) => (
					<li key={step.title} className="flex items-start gap-3">
						<span
							aria-hidden
							className={cn(
								"mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border",
								step.done
									? "border-[#4BA0FA] bg-[#4BA0FA]"
									: "border-[rgba(82,89,102,0.4)]",
							)}
						>
							{step.done ? (
								<Check className="size-3 text-white" />
							) : step.busy ? (
								<Loader2 className="size-3 animate-spin text-[#4BA0FA]" />
							) : null}
						</span>
						<div className="min-w-0 flex-1">
							<div className="flex items-center justify-between gap-2">
								<p
									className={cn(
										"text-[13px] font-medium",
										step.done ? "text-[#737373]" : "text-[#fafafa]",
									)}
								>
									{step.title}
								</p>
								{!step.done &&
									step.action &&
									(step.action.href ? (
										<a
											href={step.action.href}
											className="inline-flex shrink-0 items-center gap-0.5 text-[12px] font-medium text-[#4BA0FA] transition-opacity hover:opacity-80"
										>
											{step.action.label}
											<ArrowRight className="size-3" />
										</a>
									) : (
										<button
											type="button"
											onClick={step.action.onClick}
											className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 text-[12px] font-medium text-[#4BA0FA] transition-opacity hover:opacity-80"
										>
											{step.action.label}
											<ArrowRight className="size-3" />
										</button>
									))}
							</div>
							{!step.done && step.hint && (
								<p className="mt-0.5 text-[12px] font-medium leading-[1.4] text-[#737373]">
									{step.hint}
								</p>
							)}
						</div>
					</li>
				))}
			</ul>
		</section>
	)
}
