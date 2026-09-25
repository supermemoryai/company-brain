# What is Company Brain?

A super agent, with all the knowledge and tools of your team.

Company Brain is a super agent with shared memory for your team that you can **ask questions** and that can **act in your tools**. It pulls from the work you already do (Slack threads, docs, GitHub, Linear) and can pretty much act as a real employee on your team.

- **Remembers:** meetings, decisions, projects, and who owns what, kept current as your team talks and your tools change.
- **Acts:** pulls your open PRs, finds a Linear issue, or answers in a Slack channel. Not just reciting text back.

## A quick example of its capabilities

It'll answer a question, actually go do the work, or just jump into a conversation on its own when it's got something worth saying, like a coworker would, not a search bar. You can shape how it talks through the workspace prompt.

### Ask it anything

> **#product**
>
> **You:** @company-brain what did we decide about pricing for the company brain
>
> **Company Brain:** You and mahesh decided yesterday that it stays at **$400/mo**, usage based only. we landed on that in a #product huddle

### Put it to work

> **#eng**
>
> **You:** @company-brain is the Stripe webhook timeout from Sentry already tracked anywhere?
>
> **Company Brain:** nope, nothing yet. just opened **ENG-847** for it, added the sentry issue to it, and put it on @Sam since they were the last one in `webhooks/stripe.ts` and their beautiful code broke it ☠️. [here you go](https://linear.app), should probably fix it asap.

### Let it speak up on its own

> **#eng**
>
> **Alex:** is prod down? a couple of customers are pinging me
>
> **Company Brain:** not fully down. `api/search` is just elevated, 42 errors in the last 15 min (SM-2041), and @Kush is on it. probably that deploy from this morning. Only one user has complained on support and i already replied to them saying it's being investigated.

You don't need to mention it. It speaks up when it has something to add (see [Automations and proactiveness](automations.md) for how it decides, and how to turn it down).

## Same knowledge, useful everywhere

It's your team's knowledge, and Slack is where you reach it. The app UI on your deployment shows the rest: the brain's home, a **Graph** of its memories, and **Configure** for tools, models, skills, automations and proactivity.

Asking the brain from Claude Code, Cursor or other MCP clients was part of the hosted product and isn't in this build yet. See [Using outside Slack](outside-slack.md) for what works today.

## Use it your way

Company Brain isn't locked to one model or one voice. Two things you control directly:

- **Your own model keys, no markup.** It runs on whichever provider keys the deployment has (Anthropic, OpenAI, Google or xAI), and you pay the provider directly. Pick how fast or thorough it should be under **Configure → Models**.
- **Its tonality.** The **Workspace Prompt** (Configure → Workspace Prompt) is persistent guidance for how it works and talks across the workspace, from buttoned-up professional to fully unhinged. **Skills** teach it your team's repeatable processes, formats and voice.

## Where to go next

Company Brain has a handful of ideas worth understanding before you set it up: the permissions graph, how to configure it, proactiveness, automations, and more.

- **[The permissions graph](permissions.md):** what's remembered where, and who can read it.
- **[Setup and onboarding](setup.md):** get your team's workspace running.
