# Meeting recall

Ask what was decided in a meeting and get the answer from your notes.

## The scenario

Someone missed the Acme call, or was there and forgot the outcome. They ask in Slack and get the decision, with a path back to the source notes.

## What happens

> **#sales**
>
> **You:** @company-brain what did we decide in the meeting with Acme?
>
> **Company Brain:** Acme is moving to annual billing at the current rate, with a 90-day pilot on the enterprise SSO add-on. Follow-up owned by **Priya**, due Friday. *(from Granola notes, Acme QBR, Jun 11)*

## What's really going on

Meeting notes come in through a [connector](../connectors.md): Granola for meeting notes, or Notion if notes land there. The bot reads them live when you ask, and what gets discussed about them in a public channel lands in [public channel memory](../permissions.md), so anyone on the team can ask about it later. The answer cites the source so you can open the original notes and verify.

Ask about a decision, an owner, a date, or "what did we promise them"; plain language is fine.

Next:

- **[Permissions](../permissions.md):** where what's said about a meeting ends up, and who can read it.
- **[Connectors](../connectors.md):** connect Granola or Notion.
