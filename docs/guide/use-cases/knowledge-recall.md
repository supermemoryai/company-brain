# Answering from your docs

Ask about roadmaps, specs, and handbooks in plain language.

## The scenario

The Q2 roadmap lives in Notion. Nobody wants to dig for the link mid-conversation; they just ask.

## What happens

> **#product**
>
> **You:** @company-brain what's in our Q2 roadmap?
>
> **Company Brain:** Three themes for Q2:
> 1. **Company Brain GA**: Slack bot, connectors, automations
> 2. **Memory Router v2**: lower latency, better multi-tenant isolation
> 3. **Enterprise SSO + audit log**
>
> Full doc: *Q2 Roadmap* in Notion (last updated Jun 3).

## What's really going on

In this build that's the **Notion** [tool connector](../connectors.md): the bot searches and reads the page live when you ask, so answers stay current when the roadmap changes without anyone re-uploading anything. (The hosted product also synced Drive, Notion and OneDrive into memory in the background; that ingestion isn't part of this build. See [Bringing documents in](../connectors.md#bringing-documents-in).)

Same pattern works for handbooks, design docs, RFCs, and "where do we document X?" style questions, wherever a connected tool can reach them. If it doesn't know, it says so rather than guessing.

Next:

- **[Connectors](../connectors.md):** connect Notion and the rest.
- **[Permissions](../permissions.md):** who can see what.
