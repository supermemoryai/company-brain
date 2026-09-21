# Company Brain

An agent that lives in your Slack, remembers what your team says, and answers
from that memory. It reads the channels it is in, keeps a shared brain plus a
private one per person, connects to your other tools over MCP, and does
research on its own when it decides something is worth looking into.

This ran as a paid product at supermemory until September 2026. This repository
is that agent, rebuilt to stand on its own: memory goes to the public
supermemory API, state goes to D1, and it deploys to your own Cloudflare
account.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/supermemoryai/company-brain)

The deploy asks for two secrets:

- `SUPERMEMORY_API_KEY` — where the brain reads and writes memory. Get one at
  [console.supermemory.ai](https://console.supermemory.ai).
- One model key: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GOOGLE_GENERATIVE_AI_API_KEY` or `XAI_API_KEY`. The prompts were tuned
  against Anthropic and xAI models; any of the four works.

Everything else — D1, KV, the Durable Object, Workers AI — is provisioned for
you.

When the deploy finishes, open `/setup` on your new worker. It checks what is
configured, hands you a Slack app manifest with your URLs already in it, and
takes the three Slack values back. Then install to your workspace.

After the first deploy, apply the database migrations once:

```sh
bun run db:migrate
```

## Local development

```sh
bun install
cp .dev.vars.example .dev.vars   # fill in the two keys
bun run db:migrate:local
bun run dev
```

Slack has to reach your machine, so point a tunnel at the dev server and use
that hostname when you create the Slack app.

## How it works

- **`src/brain/turn`** — one turn of the agent: context assembly, tool loop,
  finalization, and the durable state that lets a turn resume.
- **`src/brain/slack`** — everything Slack: events, threads, reactions,
  channel policy, and when to speak unprompted.
- **`src/brain/memory`** — what gets remembered, under which container tag, and
  how it is recalled.
- **`src/brain/tools/mcp`** — connecting to MCP servers, brokering their OAuth,
  and deciding which of their tools the agent may call.
- **`src/compat`** — the seam where this repository meets what used to be
  supermemory's private backend. Memory calls go to the public API from here.

The agent itself is a Durable Object, one per organization, so a conversation
has somewhere to live between messages.

## What changed in the open

Three things the hosted version could do are not available through the public
API, and the brain does something slightly different instead:

- **Listing memories.** The API exposes memories through search, so reads that
  were "every memory in this container, newest first" are now "every memory in
  this container about X", ranked by relevance. Each read says what it is
  looking for.
- **Space configuration.** Names, visibility and profile buckets have no public
  equivalent. Entity context does, per document, so the brain records what a
  container is about and attaches it to every write into that container.
- **Node contents.** A memory node hydrates from the documents the brain wrote
  under it, rather than from the memories supermemory derived from them.

Also worth knowing: D1 has no interactive transactions or row locks. The writes
that relied on them are idempotent upserts or use a claim token, and they run
sequentially now.

## Status

Extracted and rebuilt in the open: it type-checks, builds, and boots, but it
has not yet been run against a live Slack workspace end to end. See `docs/` for
the original architecture notes. Issues and pull requests welcome; this is not
a supported product.
