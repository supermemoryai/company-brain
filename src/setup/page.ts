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
	/** OrcaRouter status, or null when the deployment has no database yet. */
	orca: OrcaSetupView | null
}

/** Everything the OrcaRouter step may render. Never contains a key or verifier. */
export type OrcaSetupView = {
	configured: boolean
	needsReauth: boolean
	/** Last four characters of the stored key, for recognition only. */
	hint: string
	sourceLabel: string
	credentialLabel: string
	/** Consent URL of an attempt waiting for a code. Public values only. */
	authorizeUrl?: string
	/** Device-grant instructions, when one is in flight. */
	device?: {
		verificationUri: string
		verificationUriComplete?: string
		userCode?: string
	}
	message?: string
	error?: boolean
}

type StepState = "done" | "current" | "upcoming"

const PROVIDER_NAMES: Record<string, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	google: "Google",
	xai: "xAI",
	orcarouter: "OrcaRouter",
}

const ORCA_LOGO_URL = "https://www.orcarouter.ai/orca-logo-classic.png"

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
				? "<li><strong><code>MODEL_API_KEY</code></strong> is set, but it doesn't look like an Anthropic (<code>sk-ant-</code>), OpenAI (<code>sk-</code>), Google (<code>AIza</code>), xAI (<code>xai-</code>), OpenRouter (<code>sk-or-</code>) or OrcaRouter (<code>sk-orca-</code>) key. Check it, or set the provider's own variable, like <code>ANTHROPIC_API_KEY</code>.</li>"
				: "<li><strong><code>MODEL_API_KEY</code></strong> is missing. Use an Anthropic, OpenAI, Google, xAI, OpenRouter or OrcaRouter key, whichever you have.</li>",
		)
	}
	return `<ul class="todo">${rows.join("")}</ul><p>${SECRET_HOW}</p>`
}

/**
 * OrcaRouter, offered as its own step because either credential source works
 * on its own: operators who already hold a key paste it, and operators who do
 * not can authorize with their OrcaRouter account instead.
 */
function orcaBody(status: OrcaSetupView): string {
	const state = !status.configured
		? `<p class="muted">Not connected yet. Pick either method below.</p>`
		: status.needsReauth
			? `<p class="warn">OrcaRouter rejected the stored key, so it has to be replaced. Connect again below.</p>`
			: `<p class="summary-line">Connected<strong>${status.sourceLabel ? ` via ${escapeHtml(status.sourceLabel)}` : ""}</strong>${
					status.hint ? ` · key ending <code>…${escapeHtml(status.hint)}</code>` : ""
				}. Replacing it below overwrites the stored key.</p>`

	const notice = status.message
		? `<p class="${status.error ? "warn" : "summary-line"}">${escapeHtml(status.message)}</p>`
		: ""

	const authorizeUrl = status.authorizeUrl
		? `<p class="hint">Your browser didn't open? <a href="${escapeHtml(status.authorizeUrl)}" target="_blank" rel="noreferrer">Open the consent screen</a>.</p>
<form method="post" action="/setup/orca/complete" class="orca-method">
	<h3>Finish authorizing</h3>
	<p class="hint">The consent screen shows a code. Paste it here.</p>
	<label for="orcaCode">Code</label>
	<input id="orcaCode" name="code" autocomplete="off" required>
	<button type="submit">Connect</button>
</form>`
		: ""

	const deviceBlock = status.device
		? `<div class="banner"><p>On another device, open <a href="${escapeHtml(
				status.device.verificationUriComplete ?? status.device.verificationUri,
			)}" target="_blank" rel="noreferrer">${escapeHtml(
				status.device.verificationUriComplete ?? status.device.verificationUri,
			)}</a>${
				status.device.userCode
					? ` and enter <code>${escapeHtml(status.device.userCode)}</code>`
					: ""
			}.</p>
<form method="post" action="/setup/orca/device/poll" class="inline"><button type="submit">I've approved — check now</button></form></div>`
		: ""

	return `${state}${notice}
<div class="methods">
	<form method="post" action="/setup/orca/key" class="orca-method" data-method="api-key">
		<h3><img src="${ORCA_LOGO_URL}" alt="" width="18" height="18"> OrcaRouter - API</h3>
		<p class="hint">You already have an <code>sk-orca-…</code> key. Create or copy one from the <a href="https://www.orcarouter.ai/console/authorized-apps" target="_blank" rel="noreferrer">OrcaRouter console</a>.</p>
		<label for="orcaKey">API key</label>
		<input id="orcaKey" name="key" type="password" autocomplete="off" placeholder="sk-orca-…" required>
		<button type="submit">Save key</button>
	</form>
	<form method="post" action="/setup/orca/authorize" class="orca-method" data-method="pkce">
		<h3><img src="${ORCA_LOGO_URL}" alt="" width="18" height="18"> OrcaRouter - Auth</h3>
		<p class="hint">No key yet? Sign in with your OrcaRouter account using OAuth 2.0 + PKCE. We mint a key that belongs to you and store it here.</p>
		<button type="submit" name="flow" value="oob" class="btn-secondary">Connect with OrcaRouter</button>
	</form>
</div>
${authorizeUrl}${deviceBlock}${
		status.configured
			? `<form method="post" action="/setup/orca/clear" class="inline"><button type="submit" class="linkish">Disconnect OrcaRouter</button></form>`
			: ""
	}
<details class="extras">
	<summary>Headless install (no browser)?</summary>
	<form method="post" action="/setup/orca/authorize" class="orca-method">
		<p class="hint">Use a device code: approve on your phone, nothing to paste back.</p>
		<button type="submit" name="flow" value="device" class="btn-secondary">Start device authorization</button>
	</form>
</details>`
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
	const states: Record<
		"keys" | "slack" | "signin" | "install" | "orca",
		StepState
	> = {
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
		// Optional and never blocks another step, so it shows its body as soon
		// as the page can talk to the deployment: both credential methods are
		// reachable without finishing Slack first.
		orca: params.orca?.configured
			? params.orca.needsReauth
				? "current"
				: "done"
			: "current",
	}
	const allDone = keysDone && params.slackConfigured && installed

	const providerNames = params.providers
		.map((p) => PROVIDER_NAMES[p] ?? p)
		.join(", ")

	const orcaStepHtml = params.orca
		? step(
				"orca",
				5,
				states.orca,
				"Connect OrcaRouter (optional)",
				`Models run through OrcaRouter${
					params.orca.hint
						? ` · key ending <code>…${escapeHtml(params.orca.hint)}</code>`
						: ""
				}, via ${escapeHtml(params.orca.credentialLabel)}.`,
				orcaBody(params.orca),
			)
		: ""

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
	.methods { display:grid; gap:.85rem; grid-template-columns:1fr; margin-top:.4rem; }
	@media (min-width:34rem) { .methods { grid-template-columns:1fr 1fr; } }
	.orca-method { display:flex; flex-direction:column; margin:0; }
	.orca-method h3 { display:flex; align-items:center; gap:.45rem; font-size:.92rem; margin:0 0 .35rem; color:var(--fg); }
	.orca-method h3 img { border-radius:.25rem; display:block; }
	.orca-method .hint { margin:0 0 .2rem; font-size:.85rem; color:var(--muted); }
	.orca-method button { margin-top:auto; align-self:flex-start; }
	.orca-method button.btn-secondary, .btn-secondary { background:transparent; color:var(--fg); border:1px solid var(--line); }
	.linkish { background:none; border:0; padding:0; margin:0; color:var(--muted); font-weight:500; text-decoration:underline; cursor:pointer; }
	.summary-line { margin:.2rem 0 .6rem; color:var(--muted); }
	.summary-line strong { color:var(--fg); }
	.hint { color:var(--muted); font-size:.88rem; }
	.muted { color:var(--muted); }
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
	${orcaStepHtml}
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
