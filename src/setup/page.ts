type PageParams = {
	origin: string
	databaseReady: boolean
	pendingMigrations: string[]
	migrationError: string | null
	hasMemoryKey: boolean
	modelKeyUnrecognized: boolean
	sandbox: "daytona" | "container" | null
	providers: string[]
	slackConfigured: boolean
	signedIn: boolean
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

// Optional rows never block setup, so an unset one reads as a choice, not a gap.
function option(on: boolean, label: string, detail: string): string {
	return `<li class="${on ? "done" : "optional"}"><span class="mark">${on ? "✓" : "–"}</span><div><strong>${label}</strong><p>${detail}</p></div></li>`
}

const SECRET_HOW =
	"Add it as a secret in the Cloudflare dashboard (your worker → Settings → Variables and Secrets), or run <code>wrangler secret put NAME</code>. Then reload this page."

const PAID_HOW =
	"Uncomment the <strong>Workers Paid</strong> block in <code>wrangler.jsonc</code>, set <code>CONTAINER_SANDBOX</code> to <code>\"on\"</code>, and redeploy."

const PROVIDER_NAMES: Record<string, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	google: "Google",
	xai: "xAI",
}

function modelDetail(params: PageParams): string {
	if (params.providers.length > 0) {
		return `Using ${escapeHtml(params.providers.map((p) => PROVIDER_NAMES[p] ?? p).join(", "))}.`
	}
	if (params.modelKeyUnrecognized) {
		return "<code>MODEL_API_KEY</code> is set, but it doesn't look like an Anthropic (<code>sk-ant-</code>), OpenAI (<code>sk-</code>), Google (<code>AIza</code>) or xAI (<code>xai-</code>) key. Check it, or set the provider's own variable, like <code>ANTHROPIC_API_KEY</code>."
	}
	return `Set <code>MODEL_API_KEY</code> to an Anthropic, OpenAI, Google or xAI key. ${SECRET_HOW}`
}

function planRows(params: PageParams): string {
	return option(
		params.sandbox !== null,
		"Code sandbox",
		params.sandbox === "daytona"
			? "On, running on Daytona."
			: params.sandbox === "container"
				? "On, running on a Cloudflare container in your account."
				: `Off, so the brain can't run code or work in repos. Set the <code>DAYTONA_API_KEY</code> secret to use Daytona on any plan. On Workers Paid you can use a built-in container instead: ${PAID_HOW.charAt(0).toLowerCase()}${PAID_HOW.slice(1)}`,
	)
}

function databaseDetail(params: PageParams): string {
	if (params.databaseReady) return "Up to date."
	const pending = params.pendingMigrations.length
	const summary = params.migrationError
		? `Migrating failed: <code>${escapeHtml(params.migrationError)}</code>`
		: `${pending} migration${pending === 1 ? "" : "s"} waiting to run.`
	return `${summary}</p><form method="post" action="/setup/migrate" class="inline"><button type="submit">Run migrations</button></form><p>`
}

export function setupPage(params: PageParams): string {
	const manifestUrl = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(params.manifest))}`
	const ready =
		params.databaseReady &&
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
	.mark { font-size:1.1rem; width:1.2rem; flex:none; text-align:center; }
	.done .mark { color:#2f9e5f; }
	.todo .mark { color:var(--muted); }
	.optional .mark { color:var(--muted); }
	.note { color:var(--muted); font-size:.9rem; margin:.4rem 0 .6rem; }
	h2 { font-size:1rem; margin:0 0 .25rem; letter-spacing:-.01em; }
	ol.steps { padding-left:1.2rem; margin:.5rem 0 0; }
	ol.steps li { display:list-item; border:0; padding:.35rem 0; color:var(--muted); font-size:.95rem; }
	ol.steps strong { color:var(--fg); }
	a { color:inherit; }
	form { border:1px solid var(--line); border-radius:.6rem; padding:1.25rem; }
	label { display:block; font-size:.85rem; font-weight:600; margin:.9rem 0 .3rem; }
	input { width:100%; box-sizing:border-box; padding:.6rem .7rem; border:1px solid var(--line); border-radius:.4rem; background:transparent; color:inherit; font:inherit; }
	button, .btn { display:inline-block; margin-top:1.2rem; padding:.6rem 1rem; border:0; border-radius:.4rem; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; text-decoration:none; }
	@media (prefers-color-scheme: dark) { button, .btn { color:#111110; } }
	code { background:color-mix(in srgb, var(--fg) 8%, transparent); padding:.1rem .35rem; border-radius:.25rem; font-size:.85em; }
	form.inline { border:0; padding:0; margin:.4rem 0 0; }
	form.inline button { margin-top:0; }
	.ready { border:1px solid #2f9e5f; border-radius:.6rem; padding:1rem 1.25rem; }
</style>
</head>
<body>
<main>
	<h1>Company Brain</h1>
	<p class="sub">${escapeHtml(params.origin)}</p>
	<h2>Required</h2>
	<ul>
		${check(params.databaseReady, "Database", databaseDetail(params))}
		${check(params.hasMemoryKey, "Memory", params.hasMemoryKey ? "Connected to supermemory." : `Set <code>SUPERMEMORY_API_KEY</code>. Get a key at <a href="https://console.supermemory.ai" target="_blank" rel="noreferrer">console.supermemory.ai</a>. ${SECRET_HOW}`)}
		${check(params.providers.length > 0, "Model", modelDetail(params))}
		${check(params.slackConfigured, "Slack", params.slackConfigured ? "Credentials stored. Install the app to your workspace." : "Create the Slack app below, then paste its credentials.")}
	</ul>
	<h2>Plan and optional features</h2>
	<p class="note">The brain runs on Cloudflare's free plan. <a href="https://developers.cloudflare.com/workers/platform/pricing/" target="_blank" rel="noreferrer">Workers Paid</a> ($5/mo) is better if your team leans on it: the free plan allows 50 outbound calls per request, which can cut long, multi-step answers short, and Paid can run the code sandbox on a built-in container.</p>
	<ul>
		${planRows(params)}
	</ul>
	<h2>Slack</h2>
	${
		params.slackConfigured
			? params.signedIn
				? `<div class="ready"><strong>${ready ? "Ready." : "Slack is configured."}</strong><p>Install to your workspace and say hello to the bot.</p><a class="btn" href="/brain/slack/oauth/install">Install to Slack</a> <a class="btn" href="/">Open the app</a></div>`
				: `<div class="ready"><strong>Slack is configured.</strong><p>Sign in with your Slack account. The first person to sign in owns this deployment; then install the bot to your workspace.</p><a class="btn" href="/auth/slack/login">Sign in with Slack</a></div>`
			: `<ol class="steps">
		<li><strong>Create the Slack app.</strong> The button opens Slack with this deployment's URLs already filled in. Pick your workspace and create it.</li>
		<li><strong>Copy its credentials.</strong> In the new app, open <em>Basic Information → App Credentials</em> and paste the Client ID, Client Secret and Signing Secret below.</li>
		<li><strong>Verify the event URL.</strong> After saving, go back to the app's <em>Event Subscriptions</em> page and click <em>Retry</em> so Slack confirms it can reach this deployment.</li>
	</ol>
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
