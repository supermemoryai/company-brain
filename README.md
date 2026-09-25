<img width="4000" height="1405" alt="Site BG" src="https://github.com/user-attachments/assets/9ee4f71f-0612-452a-8d58-862aee510086" />
# Company Brain

**A teammate in your Slack that truly knows and understands your company, and can do anything.**

A few weeks ago, we discontinued our [Company brain product](https://x.com/supermemory/status/2081781184980246897?s=20) at [supermemory](https://supermemory.ai).

It was a paid product, with thousands of users. Now, it's free and open source!

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/supermemoryai/company-brain)

Features:
- **Remembers.** Decisions, projects, owners and context from the channels it's in, kept current as people talk. No one has to write anything down.
- **Answers from what your team actually said.** Not from the internet and not from guesswork: from your own conversations and connected tools.
- **Acts in your tools.** Connect GitHub, Linear, Notion, Google Workspace and hundreds of other MCP servers. It opens issues, reads PRs, searches docs, and does the actual task instead of describing it.
- **Speaks up on its own.** It chimes in when a conversation needs something it knows. You decide how chatty it is, org-wide and per channel.
- **Runs code.** It gets its own sandbox: it clones a repo, runs commands and scripts, and hands back files like charts, CSVs and PDFs right in Slack.
- **Works while you sleep.** Scheduled automations post digests and summaries to a channel or your DMs, and it researches topics on its own when it decides something is worth looking into.
- **Learns your team's way of doing things.** Skills teach it your repeatable processes, formats and voice. A workspace prompt sets how it behaves everywhere.

> **#product**
>
> **You:** @brain what did we decide about pricing for the enterprise plan?
>
> **Company Brain:** You and Mahesh landed on usage-based only, no seat fees, in yesterday's #product huddle. Sam still owes the updated pricing page.

> **#eng**
>
> **Alex:** is prod down? a couple of customers are pinging me
>
> **Company Brain:** Not fully down. `api/search` is elevated, 42 errors in the last 15 minutes, and Kush is already on it. Probably this morning's deploy.

Nobody mentioned the bot in that second thread. It spoke up because it knew the answer.

## Private by design

Memory isn't one big bucket. It's a permissions graph:

- **Public channels** feed a shared brain the whole org can draw on.
- **Private channels** get their own memory, visible only to people in them.
- **Your DMs** build a personal memory that only you can reach.

The bot only ever reads with the asker's own access, so it can't leak something you couldn't see yourself. Tool access works the same way: writes always run under your own connection, and when a request needs a tool only a teammate has connected, it asks them first with an approve or deny card. Nothing is granted silently.

TLDR: The brain inherits the employee's permission models, and is aware of channels and when to not disclose information.

## Yours to run

- **Your infrastructure.** It runs on your Cloudflare account. Your memory lives in your own supermemory account.
- **Your model.** Bring an Anthropic, OpenAI, Google or xAI key and pay the provider directly. No markup.
- **Your app.** A web app at `/` shows the brain's home, a live graph of what it remembers, and settings for tools, models, proactivity, automations and skills. Everyone signs in with Slack. Only owners and admins can change org-wide settings.

## Deploy

Click **Deploy to Cloudflare** above. It asks for two secrets:

- `SUPERMEMORY_API_KEY`: where the brain reads and writes memory. Get one at [console.supermemory.ai](https://console.supermemory.ai).
- One model key: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` or `XAI_API_KEY`. The prompts were tuned against Anthropic and xAI models, and any of the four works.

Everything else is provisioned for you: D1, KV, the Durable Objects, Workers AI, and the sandbox container the brain runs code in. The database sets itself up on the first request, and every deploy after that migrates it automatically. Containers need the Workers Paid plan.

Then:

1. Open `/setup` on your new worker. It checks what's configured, hands you a Slack app manifest with your URLs already filled in, and takes the three Slack values back.
2. **Sign in with Slack.** The first person to sign in owns the deployment.
3. **Install to Slack**, and say hi to the bot.

## Learn more

The [user guide](docs/guide/README.md) covers the permissions graph, proactivity, automations, connectors and a set of real use cases. The [architecture notes](docs/README.md) go deeper on how the agent works.

## Local development

```sh
bun install
cp .dev.vars.example .dev.vars   # fill in the two keys
bun run dev
```

Docker has to be running, since the sandbox is a container. Slack has to reach your machine, so point a tunnel at the dev server, set `PUBLIC_URL` in `.dev.vars` to the tunnel's URL, and create the Slack app from the tunnel's `/setup` page.

After changing the schema in `src/db/schema`, run `bun run db:generate`. It writes the migration and bundles it into the worker, which applies it on its next request.
