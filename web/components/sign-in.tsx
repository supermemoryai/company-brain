import { dmSans125ClassName, dmSansClassName } from "@lib/fonts"
import { cn } from "@lib/utils"

const cardStyle = {
	boxShadow:
		"0 2.842px 14.211px 0 rgba(0, 0, 0, 0.25), 0.711px 0.711px 0.711px 0 rgba(255, 255, 255, 0.10) inset",
}

// Shown to anyone without a session. Sign-in goes through the deployment's
// own Slack app; /setup is where that app gets configured in the first place.
export function SignIn() {
	return (
		<main className="flex min-h-screen items-center justify-center bg-[#05080D] px-4">
			<div
				className="w-full max-w-sm rounded-[14px] bg-[#14161A] p-6"
				style={cardStyle}
			>
				<h1
					className={dmSans125ClassName(
						"text-[20px] font-semibold text-[#FAFAFA]",
					)}
				>
					Company Brain
				</h1>
				<p className={dmSansClassName("mt-2 text-[13px] text-[#8B929E]")}>
					Sign in with the Slack workspace this brain belongs to.
				</p>
				<a
					href="/auth/slack/login"
					className={cn(
						dmSansClassName(),
						"mt-6 flex h-10 w-full items-center justify-center gap-2 rounded-[10px] bg-[#FAFAFA] text-[14px] font-medium text-[#0B0E13] transition-colors hover:bg-white",
					)}
				>
					Sign in with Slack
				</a>
				<a
					href="/setup"
					className={dmSansClassName(
						"mt-4 block text-center text-[12px] text-[#737B87] hover:text-[#FAFAFA]",
					)}
				>
					Setting this deployment up? Go to setup
				</a>
			</div>
		</main>
	)
}
