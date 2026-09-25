# Connectors

Bring knowledge in, and act in live tools with tool connectors.

The hosted product had two kinds of connectors: **data connectors** that synced files into memory, and **tool connectors** that act in live tools. This self-hosted build has tool connectors. The ingestion side isn't part of it; see [Bringing documents in](#bringing-documents-in) for what to do instead.

| | Tool connectors |
|---|---|
| **What they do** | Let the agent read and *act* in the tool |
| **Examples** | GitHub, Linear, Notion, Sentry, Plain, PostHog, Granola, Gmail, plus a marketplace of MCP servers and your own custom servers |
| **Result** | Live reads and writes (list PRs, create issues, check errors) |
| **When it runs** | In the moment you ask, or when an automation runs |

## Tool connectors

Tool connectors are live integrations (MCP under the hood). They don't just index past content; they read and act in the tool *right now*:

- **GitHub:** open PRs, recent commits, repo context
- **Linear:** find or create issues, check status
- **Notion:** search and read pages
- **Sentry:** what's actually erroring in prod
- **Plain:** customer support tickets and history
- **PostHog:** product analytics
- **Granola:** meeting notes and decisions
- **Gmail:** your own inbox (personal connections only; it can't be shared org-wide or leased)
- **Marketplace:** hundreds more MCP servers in the directory on Configure → Integrations
- **Custom servers:** wire up your own MCP endpoint with **Add custom MCP** when the catalog doesn't cover a tool

Connect them from **Configure → Integrations** in the app, or from the buttons in the bot's welcome DM.

You can connect tools at two scopes: **Organization (shared)** or **Personal (yours)**. Adding an org-shared connection needs an owner or admin. The full rule of thumb lives on [The permissions graph](permissions.md): reads use your personal connection when you have one and fall back to the org one; writes only ever run under your own account, so the action is attributed to you.

If neither you nor the org has a tool connected, but a teammate does, Company Brain can ask them to **lease** temporary access for that one request. See [Leasing](permissions.md#leasing-borrowing-access-for-one-request).

## Bringing documents in

There's no background sync from Google Drive, OneDrive or similar in this build. What the brain knows comes from:

- **Slack:** what's said in the channels it's in and in DMs with it, written to the right memory per the [permissions graph](permissions.md).
- **Live tools:** anything a tool connector can read at the moment you ask (Notion pages, Granola notes, GitHub, and so on).
- **Your supermemory account:** memory lives in the account your deployment's API key belongs to. Documents you add there under the public channel memory tag (`sm_org_shared`), through supermemory's API or console, are searchable by the brain like anything else in public channel memory. Keep in mind the whole org can read that tag.

> [!NOTE]
> Tool connectors are only as useful as what you point them at. Start with the handful of sources people actually re-read (product specs, the handbook, the latest roadmap) rather than connecting everything at once.

## Which one do I need?

- **"What's in our Q2 roadmap?"** → the Notion connector, if that's where the roadmap lives, or a document in public channel memory
- **"What are my open PRs?"** or **"Create a Linear issue"** → GitHub / Linear
- **"What did we decide in the Acme call?"** → Granola, or wherever your notes live

Next:

- **[Automations and proactiveness](automations.md):** scheduled digests and unprompted replies that use these connections.
- **[What you can do](use-cases/overview.md):** walkthroughs of support, incidents, PRs, meetings, and more.
