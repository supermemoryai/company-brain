type SlackTarget = { teamId: string; channel: string }

const ESCAPE: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (ch) => ESCAPE[ch] ?? ch)
}

function slackDeepLink(t: SlackTarget): string {
	return `slack://channel?team=${encodeURIComponent(t.teamId)}&id=${encodeURIComponent(t.channel)}`
}

function page(title: string, body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-size:15px;line-height:1.6;color:#111;margin:40px}a{color:#111}</style></head><body>${body}</body></html>`
}

function returnLink(slack?: SlackTarget): string {
	if (!slack) return "You can close this tab."
	return `You can close this tab or <a href="${escapeHtml(slackDeepLink(slack))}">return to Slack</a>.`
}

export function renderMcpConnectSuccessPage(args: {
	appName: string
	slack?: SlackTarget
}): string {
	const name = escapeHtml(args.appName)
	return page(
		`${args.appName} connected`,
		`<p>${name} connected.</p><p>${returnLink(args.slack)}</p>`,
	)
}

export function renderMcpConnectErrorPage(args: {
	appName?: string
	message: string
	slack?: SlackTarget
}): string {
	const label = args.appName
		? `${escapeHtml(args.appName)} didn't connect.`
		: "Connection failed."
	return page(
		"Connection failed",
		`<p>${label}</p><p>${escapeHtml(args.message)}</p><p>${returnLink(args.slack)}</p>`,
	)
}
