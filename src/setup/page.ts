type PageParams = {
	origin: string
	hasMemoryKey: boolean
	providers: string[]
	slackConfigured: boolean
	manifest: object
}

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(char) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[char] as string,
	)
}

function check(done: boolean, label: string, detail: string): string {
	return `<li class="${done ? "done" : "todo"}"><span class="mark">${done ? "✓" : "○"}</span><div><strong>${label}</strong><p>${detail}</p></div></li>`
}

export function setupPage(params: PageParams): string {
	const manifestUrl = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(params.manifest))}`
	const ready =
		params.hasMemoryKey && params.providers.length > 0 && params.slackConfigured
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Company Brain setup</title>
<style>
	:root { color-scheme: light dark; --bg:#fbfbfa; --fg:#1a1a18; --muted:#6b6b66; --line:#e4e4e0; --accent:#000b36; }
	@media (prefers-color-scheme: dark) { :root { --bg:#111110; --fg:#f2f2ef; --muted:#9a9a93; --line:#2a2a28; --accent:#c9d1ff; } }
	body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif; }
	main { max-width:44rem; margin:0 auto; padding:3rem 1rem 6rem; }
	h1 { font-size:1.6rem; margin:0 0 .25rem; letter-spacing:-.02em; }
	.sub { color:var(--muted); margin:0 0 2.5rem; }
	ul { list-style:none; padding:0; margin:0 0 2.5rem; }
	li { display:flex; gap:.9rem; padding:1rem 0; border-top:1px solid var(--line); }
	li p { margin:.2rem 0 0; color:var(--muted); font-size:.9rem; }
	.mark { font-size:1.1rem; width:1.2rem; }
	.done .mark { color:#2f9e5f; }
	.todo .mark { color:var(--muted); }
	form { border:1px solid var(--line); border-radius:.6rem; padding:1.25rem; }
	label { display:block; font-size:.85rem; font-weight:600; margin:.9rem 0 .3rem; }
	input { width:100%; box-sizing:border-box; padding:.6rem .7rem; border:1px solid var(--line); border-radius:.4rem; background:transparent; color:inherit; font:inherit; }
	button, .btn { display:inline-block; margin-top:1.2rem; padding:.6rem 1rem; border:0; border-radius:.4rem; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; text-decoration:none; }
	@media (prefers-color-scheme: dark) { button, .btn { color:#111110; } }
	code { background:color-mix(in srgb, var(--fg) 8%, transparent); padding:.1rem .35rem; border-radius:.25rem; font-size:.85em; }
	.ready { border:1px solid #2f9e5f; border-radius:.6rem; padding:1rem 1.25rem; }
</style>
</head>
<body>
<main>
	<h1>Company Brain</h1>
	<p class="sub">${escapeHtml(params.origin)}</p>
	<ul>
		${check(params.hasMemoryKey, "Memory", params.hasMemoryKey ? "Connected to supermemory." : "Set <code>SUPERMEMORY_API_KEY</code> as a Worker secret and redeploy.")}
		${check(params.providers.length > 0, "Model", params.providers.length > 0 ? `Using ${escapeHtml(params.providers.join(", "))}.` : "Set one of <code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code>, <code>GOOGLE_GENERATIVE_AI_API_KEY</code> or <code>XAI_API_KEY</code>.")}
		${check(params.slackConfigured, "Slack", params.slackConfigured ? "Credentials stored. Install the app to your workspace." : "Create the Slack app below, then paste its credentials.")}
	</ul>
	${
		params.slackConfigured
			? `<div class="ready"><strong>${ready ? "Ready." : "Slack is configured."}</strong><p>Install to your workspace and say hello to the bot.</p><a class="btn" href="/slack/install">Install to Slack</a></div>`
			: `<p>Create a Slack app with this deployment's URLs already filled in, then copy its credentials back here.</p>
	<a class="btn" href="${escapeHtml(manifestUrl)}" target="_blank" rel="noreferrer">Create the Slack app</a>
	<form method="post" action="/setup/slack">
		<label for="clientId">Client ID</label>
		<input id="clientId" name="clientId" autocomplete="off" required>
		<label for="clientSecret">Client secret</label>
		<input id="clientSecret" name="clientSecret" type="password" autocomplete="off" required>
		<label for="signingSecret">Signing secret</label>
		<input id="signingSecret" name="signingSecret" type="password" autocomplete="off" required>
		<button type="submit">Save</button>
	</form>`
	}
</main>
</body>
</html>`
}
