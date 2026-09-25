# Acting in tools

List open PRs, create Linear issues. Actions run under your own account.

## The scenario

You don't just want to *know* something; you want Company Brain to do the next step in GitHub or Linear for you.

## What happens

### Read from a tool

> **#eng**
>
> **You:** @company-brain what are my open PRs in the web repo?
>
> **Company Brain:** You have **3 open PRs** on `supermemory/web`:
> - `#1199` staff custom MCP connection cards (review requested)
> - `#1197` company brain onboarding research UI (changes requested)
> - `#1181` brain connections board (approved, not merged)

### Write to a tool

> **#eng**
>
> **You:** @company-brain create a Linear issue: fix the onboarding redirect
>
> **Company Brain:** Created **ENG-842**, *Fix the onboarding redirect* in Engineering, assigned to you. [Open in Linear](https://linear.app)

## What's really going on

Both turns use [tool connectors](../connectors.md) (GitHub, Linear). Reads use your **personal** connection when you have one and fall back to the org-shared one. **Writes always run under your own account**, so the Linear issue is attributed to you, never silently as "the org". Org-shared connections are read-only, so if only the org has Linear connected, the bot asks you to connect it personally before it creates anything.

If you haven't connected the tool and neither has the org, Company Brain can ask a teammate to [lease](../permissions.md#leasing-borrowing-access-for-one-request) temporary access for that one request.

Next:

- **[Permissions](../permissions.md):** personal vs org tools, and how leasing works.
- **[Connectors](../connectors.md):** connect GitHub, Linear, and the rest.
