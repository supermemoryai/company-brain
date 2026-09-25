# From support ticket to code fix

A Plain ticket gets triaged in Slack, and an @mention hands the fix to Cursor.

## The scenario

A customer files a ticket through Plain. It lands in `#support`, gets triaged with context Company Brain already has lying around, and instead of someone manually filing a bug and waiting, an @mention hands the whole thing straight to Cursor.

## What happens

> **#support**
>
> **Plain** (app): New conversation: [rewriteQuery param not working](#)
> **Jordan Alvarez** (acme-corp.io) sent a **new message**.
> > hi team, just tried the `rewriteQuery` param on the v3 search endpoint and it doesn't seem to actually do anything. tried a few different values, results look identical either way. can someone take a look
>
> **Company Brain:** Confirmed, this is a real one. a couple of people have also flagged it on GitHub over the last week.
>
> Quick context: v3 search is deprecated, but we've committed to legacy support through end of year, so it's still worth fixing rather than telling people to migrate. Most likely cause is a change @Adam shipped last week to cut down query-rewrite costs; looks like it short-circuits before `rewriteQuery` gets applied in some cases.
>
> @cursor can you take this one? Full context attached.
>
> 📎 Context.md
>
> **Cursor** (agent): [Agent thread started](#). Reproducing against the v3 search test suite now.
>
> **Cursor** (agent): Fixed. `rewriteQuery` was getting skipped by the new cost short-circuit whenever a query was already cached. Pushed on [#2312](#).
>
> **Resolution:**
> • Scoped the short-circuit to skip only the rewrite step, not the whole `rewriteQuery` path
> • Added a regression test covering `rewriteQuery` against a cache hit
>
> **Repository:** `supermemoryai/mono`
>
> [Open in Web] [Open in Desktop]
>
> **Company Brain:** @Dhravya I'll let you review that and let the customer know we have a fix ready. Please do it ASAP, it's an enterprise customer!

## What's really going on

The first two turns are the same pattern as [Automatic support](support.md): the bot is already a member of `#support`, so it [chimes in](../automations.md#proactiveness-chime-in) unprompted, correlating the ticket against known GitHub issues and whatever it knows about the codebase and the v3 deprecation timeline.

The handoff to Cursor is a different thing. Cursor here is its own Slack app, and Company Brain @mentions it in the thread with the context attached; Cursor's agent picks it up from there and works against the repo. That's an explicit ask, visible to everyone in the thread; nothing happens in the codebase without it. Anything Company Brain itself does in a tool (commenting on the GitHub issue, filing a Linear ticket) follows [Acting in tools](acting-in-tools.md): reads may use an org-shared connection, writes run under the asker's own connection.

Next:

- **[Acting in tools](acting-in-tools.md):** how reads and writes run in connected tools.
- **[Connectors](../connectors.md):** wire up Plain, GitHub, and custom MCP servers.
