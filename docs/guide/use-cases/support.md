# Automatic support

Company Brain chimes in on customer questions with answers from docs and tickets.

## The scenario

A customer question lands in `#support`. Nobody has to @mention the bot: it already has the answer from past tickets and what the team has said before.

## What happens

> **#support**
>
> **Maya:** customer on the Pro plan is asking if they can export their full memory graph as CSV, do we support that?
>
> **Company Brain:** Yes: **Settings → Export → Full graph (CSV)**. Available on Pro and above. Same answer went out on ticket PLN-1842 last week if you want the exact wording.

## What's really going on

This is [proactiveness (chime-in)](../automations.md#proactiveness-chime-in) plus a connected support tool (Plain) and public channel memory. The bot is already a member of `#support` (an admin rolled it out to public channels, or someone invited it). It decided the answer was clear enough to speak without being asked, pulled the export path from what's in public channel memory, and cited a recent ticket from Plain.

Same channel scope rules apply: a public support channel writes durable learnings back to public channel memory; a private support channel keeps them scoped to that room's own memory. See [Permissions](../permissions.md).

If you'd rather it only answer when asked in `#support`, mark the channel **Quiet** under Configure → Proactivity.

Next:

- **[Automations and proactiveness](../automations.md):** how chime-in decides when to speak.
- **[Connectors](../connectors.md):** wire up Plain.
