# Using outside Slack

Reaching Company Brain's knowledge from somewhere other than Slack.

In the hosted product, Company Brain spoke MCP: the same permissions graph was reachable from Claude Code, ChatGPT, Cursor, or any MCP client, through supermemory's MCP server.

**This self-hosted build doesn't have that yet.** It doesn't expose an MCP server or an API for asking the brain questions, so there's no endpoint to point a coding agent at. Slack is the way to ask it, and the app UI on your deployment (Home, Graph, Configure) is the way to look at and configure it.

## What works today

- **The app UI.** Sign in with Slack on your deployment. The **Graph** page shows the brain's memories (public channel memory plus your own employee memory), following the same [permissions graph](permissions.md) as Slack.
- **A Markdown export.** On **Home**, **Export as Markdown** (next to *Recent memories*) downloads the same memories the Graph shows, public channel memory plus your own employee memory, as one `.md` file: newest first, dated, with their tags. It never includes a teammate's employee memory.
- **Your supermemory account.** Everything the brain remembers lives in the supermemory account your deployment's API key belongs to, under the container tags described in [the permissions graph](permissions.md). supermemory's own tools (its console, API and MCP server) can read that account directly.

> [!WARNING]
> Reading the supermemory account directly is **not** the permissions graph. An API key for that account sees every container: every private channel's memory and every person's employee memory. Treat it as admin-level access and don't hand it to your team as a way to "ask the brain".

Next:

- **[The permissions graph](permissions.md):** what each container tag actually is, and who can read it.
- **[What is Company Brain?](overview.md):** back to the overview.
