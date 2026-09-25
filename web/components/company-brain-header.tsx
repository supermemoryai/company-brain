import { GraphIcon } from "@/components/integration-icons"
import { BACKEND } from "@lib/api"
import { useAuth } from "@lib/auth-context"
import { dmSansClassName } from "@lib/fonts"
import { Link } from "@lib/navigation"
import { cn } from "@lib/utils"
import { useViewMode } from "@lib/view-mode-context"
import { Button } from "@ui/components/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip"
import { useQuery } from "@tanstack/react-query"
import {
	Building2,
	ExternalLink,
	Home,
	LogOut,
	MenuIcon,
	Settings2,
	Wrench,
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { SlackMark } from "@/components/brain-connector-icons"

type SlackStatus = { connected: boolean; teamName: string | null }

const menuItemClass =
	"gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-white/85 hover:bg-white/[0.06] focus:bg-white/[0.06] focus:text-white cursor-pointer"

const menuContentStyle = {
	background: "linear-gradient(180deg, #0A0E14 0%, #05070A 100%)",
}

const circleNavClass = (active: boolean) =>
	cn(
		"flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-colors",
		active
			? "border-[#2261CA33] bg-[#00173C] text-white"
			: "border-[#161F2C] bg-muted text-muted-foreground hover:bg-white/5",
		dmSansClassName(),
	)

const tabClass = (active: boolean) =>
	cn(
		"inline-flex h-[calc(100%-1px)] min-h-0 cursor-pointer snap-start items-center justify-center gap-1 rounded-full border border-transparent px-2.5 text-xs font-medium whitespace-nowrap transition-colors sm:gap-1.5 sm:px-3 sm:text-sm",
		active
			? "border-[#2261CA33] bg-[#00173C] text-white"
			: "text-foreground hover:bg-white/5",
		dmSansClassName(),
	)

function useIsMobile(): boolean {
	const query = "(max-width: 767px)"
	const [mobile, setMobile] = useState(() => window.matchMedia(query).matches)
	useEffect(() => {
		const media = window.matchMedia(query)
		const update = () => setMobile(media.matches)
		media.addEventListener("change", update)
		return () => media.removeEventListener("change", update)
	}, [])
	return mobile
}

function useSlackStatus() {
	return useQuery({
		queryKey: ["brain-slack-status"],
		queryFn: async (): Promise<SlackStatus> => {
			const res = await fetch(`${BACKEND}/brain/slack/status`, {
				credentials: "include",
			})
			if (!res.ok) return { connected: false, teamName: null }
			return (await res.json()) as SlackStatus
		},
		staleTime: 30_000,
	})
}

export function CompanyBrainHeader() {
	const { org } = useAuth()
	const { viewMode, setViewMode } = useViewMode()
	const isMobile = useIsMobile()
	const { data: slackStatus } = useSlackStatus()

	const orgLabel = org?.name.replace(/\s*organizations?\s*$/i, "").trim()
	const brandLabel = orgLabel || "Workspace"

	const isOverview = viewMode === "dashboard"
	const isConfigure = viewMode === "configure"
	const isGraph = viewMode === "graph"
	const slackConnected = slackStatus?.connected ?? false

	const goOverview = useCallback(() => setViewMode("dashboard"), [setViewMode])
	const goConfigure = useCallback(() => setViewMode("configure"), [setViewMode])
	const goGraph = useCallback(() => setViewMode("graph"), [setViewMode])

	return (
		<div className="relative z-10 flex shrink-0 items-center justify-between gap-1 px-2 py-2 md:grid md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-2 md:p-3">
			<div className="z-10! flex min-w-0 flex-1 shrink items-center justify-start gap-1.5 md:justify-self-start md:gap-3">
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							className="relative flex min-w-0 max-w-[31vw] shrink cursor-pointer items-center rounded-lg px-1 py-1 transition-colors hover:bg-white/5 outline-none focus-visible:outline-none min-[380px]:max-w-[9rem] sm:max-w-[min(52vw,240px)] md:-ml-2 md:max-w-[min(52vw,240px)] md:shrink-0 md:px-1.5 before:absolute before:-inset-x-1 before:-inset-y-2 before:content-[''] md:before:-inset-x-2 md:before:-inset-y-2.5"
						>
							<div
								className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-[8px] border border-[rgba(82,89,102,0.2)] bg-[#14161A] sm:size-8"
								style={{
									boxShadow:
										"0px 1px 2px 0px rgba(0,43,87,0.1), inset 0px 0px 0px 1px rgba(43,49,67,0.08)",
								}}
							>
								{org?.logo ? (
									<img
										src={org.logo}
										alt=""
										className="size-6 object-contain"
									/>
								) : (
									<Building2 className="size-4 text-[#737373]" />
								)}
							</div>
							<div className="ml-1.5 min-w-0 flex flex-col items-start justify-center max-[340px]:hidden sm:ml-2">
								<p className="max-w-full truncate text-[10px] leading-tight text-[#6B6B6B] sm:text-[11px]">
									Company Brain
								</p>
								<p className="-mt-0.5 max-w-full truncate text-sm leading-none font-semibold text-white/90 sm:text-[15px]">
									{brandLabel}
								</p>
							</div>
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="start"
						alignOffset={12}
						className={cn(
							"min-w-[244px] p-1.5 rounded-xl border border-white/[0.08] shadow-[0px_1.5px_20px_0px_rgba(0,0,0,0.65)]",
							dmSansClassName(),
						)}
						style={menuContentStyle}
					>
						<DropdownMenuItem asChild className={menuItemClass}>
							<Link href="/">
								<Home className="size-4 text-[#737373]" />
								Home
							</Link>
						</DropdownMenuItem>
						<DropdownMenuItem onClick={goConfigure} className={menuItemClass}>
							<Settings2 className="size-4 text-[#737373]" />
							Configure
						</DropdownMenuItem>
						<DropdownMenuItem asChild className={menuItemClass}>
							<a href="/setup">
								<Wrench className="size-4 text-[#737373]" />
								Deployment setup
							</a>
						</DropdownMenuItem>
						<DropdownMenuSeparator className="mx-1 my-1.5 bg-white/[0.06]" />
						<DropdownMenuItem asChild className={menuItemClass}>
							<a
								href="https://console.supermemory.ai"
								target="_blank"
								rel="noreferrer"
							>
								<ExternalLink className="size-4 text-[#737373]" />
								supermemory console
							</a>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			{!isMobile && (
				<div className="z-10! flex min-w-0 max-w-full items-center justify-center gap-1.5 overflow-hidden px-1 md:justify-self-center">
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-label="Overview"
								aria-current={isOverview ? "page" : undefined}
								onClick={goOverview}
								className={circleNavClass(isOverview)}
							>
								<Home className="size-4" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="bottom" className={dmSansClassName()}>
							Overview
						</TooltipContent>
					</Tooltip>
					<div
						role="tablist"
						aria-label="Content"
						aria-orientation="horizontal"
						className="text-muted-foreground z-10! inline-flex h-10 w-fit min-w-0 max-w-full items-center justify-center gap-0.5 overflow-x-auto snap-x snap-mandatory scroll-fade-x rounded-full border border-[#161F2C] bg-muted p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
					>
						<button
							type="button"
							role="tab"
							aria-selected={isGraph}
							onClick={goGraph}
							className={tabClass(isGraph)}
						>
							<GraphIcon className="size-3.5 shrink-0 sm:size-4" />
							Graph
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={isConfigure}
							onClick={goConfigure}
							className={tabClass(isConfigure)}
						>
							<Settings2 className="size-3.5 shrink-0 sm:size-4" />
							Configure
						</button>
					</div>
					<SlackNavButton
						connected={slackConnected}
						teamName={slackStatus?.teamName ?? null}
						active={isConfigure && slackConnected}
						onManage={goConfigure}
					/>
				</div>
			)}

			<div className="z-10! flex min-w-0 shrink-0 items-center gap-1.5 md:justify-self-end">
				{isMobile && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="headers"
								aria-label="Open navigation menu"
								className="size-9! min-h-9 min-w-9 rounded-full px-0! text-base"
							>
								<MenuIcon className="size-4" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent
							align="end"
							className={cn(
								"min-w-[200px] p-1.5 rounded-xl border border-[#2E3033] shadow-[0px_1.5px_20px_0px_rgba(0,0,0,0.65)]",
								dmSansClassName(),
							)}
							style={menuContentStyle}
						>
							<DropdownMenuItem onClick={goOverview} className={menuItemClass}>
								<Home className="size-4 text-[#737373]" />
								Overview
							</DropdownMenuItem>
							<DropdownMenuItem onClick={goGraph} className={menuItemClass}>
								<GraphIcon className="size-4 text-[#737373]" />
								Graph
							</DropdownMenuItem>
							<DropdownMenuItem
								onClick={goConfigure}
								className={menuItemClass}
							>
								<Settings2 className="size-4 text-[#737373]" />
								Configure
							</DropdownMenuItem>
							{slackConnected && (
								<DropdownMenuItem
									onClick={goConfigure}
									className={menuItemClass}
								>
									<SlackMark className="size-4" />
									Slack connected
								</DropdownMenuItem>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
				)}
				<UserMenu />
			</div>
		</div>
	)
}

function SlackNavButton({
	connected,
	teamName,
	active,
	onManage,
}: {
	connected: boolean
	teamName: string | null
	active: boolean
	onManage: () => void
}) {
	const label = `Slack${teamName ? ` · ${teamName}` : ""}`

	if (!connected) return null

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={label}
					onClick={onManage}
					className={cn(circleNavClass(active), "relative")}
				>
					<SlackMark className="size-4" />
					<span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-[#2EB67D] ring-2 ring-[#00173C]" />
				</button>
			</TooltipTrigger>
			<TooltipContent side="bottom" className={dmSansClassName()}>
				{label}
			</TooltipContent>
		</Tooltip>
	)
}

const AVATAR_PALETTE = [
	"#0e2244",
	"#1a1a3e",
	"#1e1030",
	"#0d2e2e",
	"#2a1020",
	"#1a2a10",
	"#2e1a0a",
	"#0a1e2e",
]

function initialsFor(name: string, email: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean)
	const first = parts[0]
	const last = parts[parts.length - 1]
	if (first && last && parts.length >= 2) {
		return `${first[0]}${last[0]}`.toUpperCase()
	}
	if (first) return first.slice(0, 2).toUpperCase()
	return email.slice(0, 2).toUpperCase() || "CB"
}

function avatarColorFor(seed: string): string {
	let hash = 0
	for (let i = 0; i < seed.length; i++)
		hash = seed.charCodeAt(i) + ((hash << 5) - hash)
	const index =
		((hash % AVATAR_PALETTE.length) + AVATAR_PALETTE.length) %
		AVATAR_PALETTE.length
	return AVATAR_PALETTE[index] ?? "#0e2244"
}

// The hosted account menu, minus plans, onboarding replays and settings modal.
function UserMenu() {
	const { user, role, signOut } = useAuth()
	const [imageFailed, setImageFailed] = useState(false)
	if (!user) return null

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label="Account menu"
					className="relative inline-flex shrink-0 cursor-pointer rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
				>
					<span
						className="flex size-9 items-center justify-center overflow-hidden rounded-full border border-[#161F2C] text-xs font-medium text-white"
						style={{ background: avatarColorFor(user.email || user.name) }}
					>
						{user.image && !imageFailed ? (
							<img
								src={user.image}
								alt=""
								className="size-full object-cover"
								onError={() => setImageFailed(true)}
							/>
						) : (
							initialsFor(user.name, user.email)
						)}
					</span>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className={cn(
					"min-w-[240px] p-1.5 rounded-xl border border-white/[0.08] shadow-[0px_1.5px_20px_0px_rgba(0,0,0,0.65)]",
					dmSansClassName(),
				)}
				style={menuContentStyle}
			>
				<div className="px-2.5 py-2">
					<p className="truncate text-sm font-medium text-white">
						{user.name || user.email}
					</p>
					<p className="truncate text-xs text-[#737B87]">{user.email}</p>
					{role && (
						<p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#5B6675]">
							{role}
						</p>
					)}
				</div>
				<DropdownMenuSeparator className="mx-1 my-1.5 bg-white/[0.06]" />
				<DropdownMenuItem
					onClick={() => void signOut()}
					className={menuItemClass}
				>
					<LogOut className="size-4 text-[#737373]" />
					Sign out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
