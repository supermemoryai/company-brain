<img width="4000" height="1405" alt="Company Brain" src="https://github.com/user-attachments/assets/9ee4f71f-0612-452a-8d58-862aee510086" />

<h1 align="center">Company Brain</h1>

<p align="center">
  <strong>A teammate in your Slack that truly knows and understands your company, and can do anything.</strong>
</p>

<p align="center">
  <a href="#deploy-in-five-minutes">Deploy</a> ·
  <a href="docs/guide/README.md">User guide</a> ·
  <a href="docs/guide/permissions.md">Permissions</a> ·
  <a href="docs/guide/use-cases/overview.md">Use cases</a> ·
  <a href="https://supermemory.link/discord">Discord</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" alt="Apache 2.0" /></a>
  <a href="https://supermemory.ai"><img src="https://img.shields.io/badge/memory-supermemory-blue?style=flat-square" alt="Memory by supermemory" /></a>
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-f38020?style=flat-square" alt="Runs on Cloudflare Workers" /></a>
</p>

<p align="center">
  <strong>Used to be a paid product with thousands of users. Now it's free and open source.</strong><br/>
  <a href="https://x.com/supermemory/status/2081781184980246897?s=20">Read the announcement →</a>
</p>

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/supermemoryai/company-brain"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" /></a>
</p>

---

A few weeks ago, we discontinued our [Company Brain product](https://x.com/supermemory/status/2081781184980246897?s=20) at [supermemory](https://supermemory.ai). This is that product, the whole thing, open sourced and rebuilt to run on your own Cloudflare account.

Your team's knowledge is scattered across Slack threads, docs, tickets and people's heads. Company Brain sits in Slack, remembers what your team says, and answers from it. Then it goes and does the work: opens the issue, reads the PR, digs into the repo. And when a conversation needs something it knows, it speaks up on its own.

> **#eng**
>
> **Alex:** is prod down? a couple of customers are pinging me
>
> **Company Brain:** Not fully down. `api/search` is elevated, 42 errors in the last 15 minutes, and Kush is already on it. Probably this morning's deploy.

Nobody mentioned the bot. It spoke up because it knew the answer.

| | |
|---|---|
| 🧠 **Remembers** | Decisions, projects, owners and context from the channels it's in, kept current as people talk. No one has to write anything down. |
| 💬 **Answers from your team** | Not from the internet, not from guesswork: from your own conversations and connected tools. |
| 🛠️ **Acts in your tools** | GitHub, Linear, Notion, Google Workspace and hundreds more over MCP. It opens the issue instead of telling you to. |
| 📣 **Speaks up** | Chimes in when a conversation needs something it knows. You decide how chatty it is, org-wide and per channel. |
| 💻 **Runs code** | Its own sandbox: clones repos, runs scripts, and hands back charts, CSVs and PDFs right in Slack. |
| 🌙 **Works while you sleep** | Scheduled digests to a channel or your DMs, plus research it kicks off on its own. |
| 🎓 **Learns your way** | Skills teach it your processes, formats and voice. A workspace prompt sets how it behaves everywhere. |

---

## Private by design

Memory isn't one big bucket. It's a permissions graph, and the brain only ever reads with the asker's own access.

| Where you ask | What it can draw on |
|---|---|
| **A public channel** | The shared brain everyone in the org can see |
| **A private channel** | That channel's memory, plus the shared brain |
| **Your DMs** | Your personal memory, every private channel you're in, and the shared brain |

So it can't leak something you couldn't see yourself. Tool access works the same way: writes always run under your own connection, and when a request needs a tool only a teammate has connected, it asks them first with an approve or deny card. Nothing is granted silently.

---

## Get started

<table>
<tr>
<td width="50%" valign="top">

<h3>💬 I want it in my Slack</h3>

One click to deploy, two API keys, and a setup page that walks you through the Slack app. The database sets itself up.

**[→ Deploy in five minutes](#deploy-in-five-minutes)**

</td>
<td width="50%" valign="top">

<h3>🔧 I want to hack on it</h3>

TypeScript on Cloudflare Workers, Durable Objects and D1, with memory on [supermemory](https://supermemory.ai). Run it all locally.

**[→ Local development](#local-development)**

</td>
</tr>
</table>

---

## Deploy in five minutes

**1. Click deploy.** It asks for two secrets:

- `SUPERMEMORY_API_KEY`: where the brain keeps its memory. Get one at [console.supermemory.ai](https://console.supermemory.ai).
- `MODEL_API_KEY`: an Anthropic, OpenAI, Google or xAI key, whichever you have. The brain works out the provider from the key. You pay the provider directly, no markup.

Everything else is provisioned for you: D1, KV, Durable Objects, Workers AI, and the container the brain runs code in. Containers need the Workers Paid plan.

**2. Open `/setup`** on your new worker. It checks your keys, hands you a Slack app manifest with your URLs already filled in, and takes the Slack credentials back.

**3. Sign in with Slack.** The first person to sign in owns the deployment.

**4. Install to Slack**, and say hi. 👋

Your team signs in with Slack at `/` to see the brain's home, a live graph of everything it remembers, and settings for tools, models, proactivity, automations and skills.

---

## Local development

```sh
bun install
cp .dev.vars.example .dev.vars   # fill in the two keys
bun run dev
```

Docker has to be running, since the sandbox is a container. Slack has to reach your machine, so point a tunnel at the dev server, set `PUBLIC_URL` in `.dev.vars` to the tunnel's URL, and create the Slack app from the tunnel's `/setup` page.

After changing the schema in `src/db/schema`, run `bun run db:generate`. It writes the migration and bundles it into the worker, which applies it on its next request.

---

<p align="center">
  <a href="docs/guide/README.md">User guide</a> ·
  <a href="docs/README.md">Architecture notes</a> ·
  <a href="https://supermemory.ai">supermemory</a>
</p>

<p align="center">
  Built by <a href="https://supermemory.ai">supermemory</a>. Apache 2.0.
</p>
