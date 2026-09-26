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
	/** The installed Slack workspace's name, or null before the bot is installed. */
	installedTeam: string | null
	manifest: object
}

type StepState = "done" | "current" | "upcoming"

const PROVIDER_NAMES: Record<string, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	google: "Google",
	xai: "xAI",
}

const SECRET_HOW =
	"Add it in the Cloudflare dashboard under your worker → <em>Settings → Variables and Secrets</em> (type: Secret), or run <code>wrangler secret put NAME</code>, then reload this page."

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

function step(
	id: string,
	n: number,
	state: StepState,
	title: string,
	summary: string,
	body: string,
): string {
	const mark = state === "done" ? "✓" : String(n)
	return `<section class="step ${state}" id="step-${id}">
	<div class="num">${mark}</div>
	<div class="content">
		<h2>${title}</h2>
		${state === "done" ? `<p class="summary">${summary}</p>` : ""}
		${state === "current" ? `<div class="body">${body}</div>` : ""}
	</div>
</section>`
}

function keysBody(params: PageParams): string {
	const rows: string[] = []
	if (!params.hasMemoryKey) {
		rows.push(
			`<li><strong><code>SUPERMEMORY_API_KEY</code></strong> is missing. This is where the brain keeps its memory; get a key at <a href="https://console.supermemory.ai" target="_blank" rel="noreferrer">console.supermemory.ai</a>.</li>`,
		)
	}
	if (params.providers.length === 0) {
		rows.push(
			params.modelKeyUnrecognized
				? "<li><strong><code>MODEL_API_KEY</code></strong> is set, but it doesn't look like an Anthropic (<code>sk-ant-</code>), OpenAI (<code>sk-</code>), Google (<code>AIza</code>) or xAI (<code>xai-</code>) key. Check it, or set the provider's own variable, like <code>ANTHROPIC_API_KEY</code>.</li>"
				: "<li><strong><code>MODEL_API_KEY</code></strong> is missing. Use an Anthropic, OpenAI, Google or xAI key, whichever you have.</li>",
		)
	}
	return `<ul class="todo">${rows.join("")}</ul><p>${SECRET_HOW}</p>`
}

function slackAppBody(params: PageParams): string {
	const manifestUrl = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(params.manifest))}`
	return `<ol>
		<li><a class="btn" href="${escapeHtml(manifestUrl)}" target="_blank" rel="noreferrer">Create the Slack app</a><br>This opens Slack with the app already filled in for this deployment. Pick your workspace, then click <strong>Next</strong> and <strong>Create</strong>.</li>
		<li>In the app Slack just created, stay on <strong>Basic Information</strong>. Scroll down to <strong>Display Information</strong> and upload the app icon, so the bot has its face in Slack: <a class="icon-download" href="/slack-icon.png" download="supermemory-company-brain.png"><img src="/slack-icon.png" alt="" width="40" height="40">Download the icon</a> Then click <strong>Save Changes</strong>.</li>
		<li>Scroll back up to <strong>App Credentials</strong> and copy the three values below into this form.</li>
	</ol>
	<p class="warn">Don't click <em>Install to Workspace</em> in Slack. You'll install from this page in step 4, which is how the brain learns about your workspace and sets itself up.</p>
	<form method="post" action="/setup/slack">
		<label for="clientId">Client ID</label>
		<input id="clientId" name="clientId" autocomplete="off" required>
		<label for="clientSecret">Client Secret <span>(click Show in Slack)</span></label>
		<input id="clientSecret" name="clientSecret" type="password" autocomplete="off" required>
		<label for="signingSecret">Signing Secret <span>(click Show in Slack)</span></label>
		<input id="signingSecret" name="signingSecret" type="password" autocomplete="off" required>
		<button type="submit">Save and continue</button>
	</form>`
}

function databaseBanner(params: PageParams): string {
	if (params.databaseReady) return ""
	const pending = params.pendingMigrations.length
	const detail = params.migrationError
		? `Setting up the database failed: <code>${escapeHtml(params.migrationError)}</code>`
		: `The database has ${pending} migration${pending === 1 ? "" : "s"} waiting to run. This normally happens on its own.`
	return `<div class="banner"><p>${detail}</p><form method="post" action="/setup/migrate" class="inline"><button type="submit">Set up the database</button></form></div>`
}

function extras(params: PageParams): string {
	const sandbox =
		params.sandbox === "daytona"
			? "On, running on Daytona."
			: params.sandbox === "container"
				? "On, running on a Cloudflare container in your account."
				: "Off, so the brain can't run code or work in repos. Set the <code>DAYTONA_API_KEY</code> secret to use Daytona on any plan. On Workers Paid you can use a built-in container instead: uncomment the <strong>Workers Paid</strong> block in <code>wrangler.jsonc</code>, set <code>CONTAINER_SANDBOX</code> to <code>\"on\"</code>, and redeploy."
	return `<details class="extras">
	<summary>Optional: code sandbox, web search and plan</summary>
	<p><strong>Code sandbox.</strong> ${sandbox}</p>
	<p><strong>Web search.</strong> On, using <a href="https://www.firecrawl.dev" target="_blank" rel="noreferrer">Firecrawl</a>'s free tier, no key needed (1,000 searches and page reads a month). Set <code>FIRECRAWL_API_KEY</code> for more.</p>
	<p><strong>Plan.</strong> The brain runs on Cloudflare's free plan. <a href="https://developers.cloudflare.com/workers/platform/pricing/" target="_blank" rel="noreferrer">Workers Paid</a> ($5/mo) is better if your team leans on it: the free plan allows 50 outbound calls per request, which can cut long, multi-step answers short, and Paid can run the sandbox on a built-in container.</p>
</details>`
}

export function setupPage(params: PageParams): string {
	const keysDone = params.hasMemoryKey && params.providers.length > 0
	const installed = params.installedTeam !== null

	// Each step unlocks the next. Signing in uses the Slack app, so it comes
	// after the app exists, and installing needs someone signed in to own it.
	const states: Record<"keys" | "slack" | "signin" | "install", StepState> = {
		keys: keysDone ? "done" : "current",
		slack: params.slackConfigured ? "done" : keysDone ? "current" : "upcoming",
		signin: params.signedIn
			? "done"
			: params.slackConfigured
				? "current"
				: "upcoming",
		install: installed
			? "done"
			: params.signedIn && params.slackConfigured
				? "current"
				: "upcoming",
	}
	const allDone = keysDone && params.slackConfigured && installed

	const providerNames = params.providers
		.map((p) => PROVIDER_NAMES[p] ?? p)
		.join(", ")

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Company Brain setup</title>
<style>
	:root { color-scheme: light dark; --bg:#fbfbfa; --fg:#1a1a18; --muted:#6b6b66; --line:#e4e4e0; --accent:#000b36; --ok:#2f9e5f; --warn:#b4541a; }
	@media (prefers-color-scheme: dark) { :root { --bg:#111110; --fg:#f2f2ef; --muted:#9a9a93; --line:#2a2a28; --accent:#c9d1ff; --ok:#4cc38a; --warn:#f0a36a; } }
	body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif; }
	main { max-width:40rem; margin:0 auto; padding:3rem 1rem 6rem; }
	h1 { font-size:1.6rem; margin:0 0 .25rem; letter-spacing:-.02em; }
	.sub { color:var(--muted); margin:0 0 2rem; }
	a { color:inherit; }
	code { background:color-mix(in srgb, var(--fg) 8%, transparent); padding:.1rem .35rem; border-radius:.25rem; font-size:.85em; }
	.step { display:flex; gap:1rem; padding:1.1rem 0; border-top:1px solid var(--line); }
	.num { flex:none; width:1.9rem; height:1.9rem; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:.9rem; border:1.5px solid var(--line); color:var(--muted); box-sizing:border-box; }
	.current .num { background:var(--accent); border-color:var(--accent); color:var(--bg); }
	.done .num { border-color:var(--ok); color:var(--ok); }
	.content { flex:1; min-width:0; }
	h2 { font-size:1.05rem; margin:.2rem 0 0; letter-spacing:-.01em; }
	.upcoming h2 { color:var(--muted); font-weight:600; }
	.summary { margin:.15rem 0 0; color:var(--muted); font-size:.92rem; }
	.body { margin-top:.6rem; font-size:.95rem; }
	.body p, .body li { color:var(--muted); }
	.body strong { color:var(--fg); }
	.body ol { padding-left:1.2rem; margin:.4rem 0; }
	.body ol li { margin:.2rem 0 1rem; }
	ul.todo { padding-left:1.2rem; margin:.3rem 0 .6rem; }
	.warn { border-left:3px solid var(--warn); padding:.1rem 0 .1rem .8rem; margin:.4rem 0 1rem; }
	form { border:1px solid var(--line); border-radius:.6rem; padding:1.1rem 1.25rem 1.25rem; }
	form.inline { border:0; padding:0; margin:.5rem 0 0; }
	label { display:block; font-size:.85rem; font-weight:600; margin:.8rem 0 .3rem; color:var(--fg); }
	label span { font-weight:400; color:var(--muted); }
	input { width:100%; box-sizing:border-box; padding:.6rem .7rem; border:1px solid var(--line); border-radius:.4rem; background:transparent; color:inherit; font:inherit; }
	button, .btn { display:inline-block; margin:1rem 0 .4rem; padding:.6rem 1rem; border:0; border-radius:.4rem; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; text-decoration:none; }
	@media (prefers-color-scheme: dark) { button, .btn { color:#111110; } }
	.body ol .btn { margin:0 0 .4rem; }
	.icon-download { display:flex; align-items:center; gap:.6rem; width:max-content; margin:.6rem 0; padding:.35rem .8rem .35rem .35rem; border:1px solid var(--line); border-radius:.6rem; text-decoration:none; color:var(--fg); font-weight:600; font-size:.9rem; }
	.icon-download img { border-radius:.45rem; display:block; }
	.banner { border:1px solid var(--warn); border-radius:.6rem; padding:.9rem 1.1rem; margin-bottom:1.5rem; }
	.banner p { margin:0; }
	.finished { border:1px solid var(--ok); border-radius:.6rem; padding:1rem 1.25rem; margin-top:1.5rem; }
	.finished p { margin:.3rem 0 0; color:var(--muted); }
	.extras { margin-top:2rem; border-top:1px solid var(--line); padding-top:1rem; color:var(--muted); font-size:.92rem; }
	.extras summary { cursor:pointer; font-weight:600; color:var(--fg); }
	.extras strong { color:var(--fg); }
</style>
</head>
<body>
<main>
	<h1>Set up Company Brain</h1>
	<p class="sub">${escapeHtml(params.origin)}</p>
	${databaseBanner(params)}
	${step(
		"keys",
		1,
		states.keys,
		"Add your API keys",
		`Memory on supermemory, model on ${escapeHtml(providerNames || "your provider")}.`,
		keysBody(params),
	)}
	${step(
		"slack",
		2,
		states.slack,
		"Create a Slack app",
		"Slack app connected.",
		slackAppBody(params),
	)}
	${step(
		"signin",
		3,
		states.signin,
		"Sign in with Slack",
		"You're signed in.",
		`<p>Sign in with your Slack account. The first person to sign in owns this deployment and can change its settings.</p><a class="btn" href="/auth/slack/login">Sign in with Slack</a>`,
	)}
	${step(
		"install",
		4,
		states.install,
		"Add the bot to your workspace",
		`Installed in ${escapeHtml(params.installedTeam ?? "")}. If the bot never greeted you, <a href="/brain/slack/oauth/install">add it again</a> to rerun its setup.`,
		`<p>Slack asks you to approve the bot's permissions. Once you do, it DMs you to say hi, joins your public channels and introduces itself, and offers to invite your teammates.</p><a class="btn" href="/brain/slack/oauth/install">Add to Slack</a>`,
	)}
	${
		allDone
			? `<div class="finished"><strong>You're all set.</strong><p>Say hi to the bot in Slack, or open the app to connect tools and tune how it behaves.</p><a class="btn" href="/">Open the app</a></div>`
			: ""
	}
	${extras(params)}
</main>
</body>
</html>`
}
