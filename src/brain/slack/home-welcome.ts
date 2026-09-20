export const COMPANY_BRAIN_HOME_WELCOME_VERSION = 2

function installerFirstName(value: string | null | undefined): string | null {
	const firstName = value
		?.replace(/[<>&\r\n]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.split(" ")[0]
	return firstName?.slice(0, 80) || null
}

export function companyBrainHomeWelcomeMessages(args: {
	adminName?: string | null
}): string[] {
	const adminName = installerFirstName(args.adminName)
	const thanks = adminName
		? `_Thanks for bringing me in, ${adminName}._`
		: "_Thanks for bringing me in._"

	return [
		[
			"👋 *I'm Supermemory, your Company Brain.*",
			"Ask me what's going on, where something stands, or what the team decided — in here, any channel I'm in, or by DM.",
			thanks,
		].join("\n"),
	]
}

// Customer-initiated; DMs the bot sent cannot be unsent, so the channel is the only goodbye.
export function companyBrainDisconnectMessage(): string {
	return [
		"*Supermemory has been disconnected from this workspace.*",
		"I won't reply here, in other channels, or in DMs anymore. This channel stays, along with everything already in it.",
		"Reinstall from Company Brain settings if you want me back.",
	].join("\n")
}

export const COMPANY_BRAIN_CONSOLE_URL = "https://console.supermemory.ai"

export function companyBrainShutdownMessage(): string {
	return [
		"👋 *Thank you for trying Company Brain*",
		"You were part of the beta, and what we learned here shapes what we build next. Thank you for that.",
		"",
		"*What's changing*",
		"• The Slack agent is being retired. I'll leave this workspace by Tuesday, September 8, 2026.",
		"• After that I won't answer here, in other channels, or in DMs.",
		"",
		"*What stays*",
		"• Everything Company Brain saved is still yours.",
		`• Find it anytime at <${COMPANY_BRAIN_CONSOLE_URL}|console.supermemory.ai>.`,
		"",
		"Questions or feedback? support@supermemory.com. We read every note.",
	].join("\n")
}
