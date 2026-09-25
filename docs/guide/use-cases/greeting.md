# Greeting new teammates

Welcome DM and first answer: activation on day one.

## The scenario

A new hire joins the Slack workspace. They shouldn't need a web signup form or a long handbook read before Company Brain is useful; the whole first experience happens in Slack.

## What happens

When the bot is installed, it rolls itself out to everyone already in the workspace, and when someone new joins Slack later, it picks them up too. Each person gets a welcome DM:

> **DM with Company Brain**
>
> **Company Brain:** Hey Sam, welcome to *Acme*. I'm Supermemory, I keep track of what the team's working on. Need to get up to speed? Just ask me anything.
>
> **Sam:** What does Acme do?
>
> **Company Brain:** Acme builds memory infrastructure for AI apps: shared context for teams and agents. *(from the company research at install)*

From there they can connect personal tools (Configure → Integrations in the app, after signing in with Slack) so day-two questions can hit live data under their own account.

## What's really going on

This is the member side of [setup](../setup.md). Each teammate gets an account created from their Slack profile (their Slack email), which gives them their own private [employee memory](../permissions.md). There are no seats and no invites to send. The first useful answer can come from the company research the bot did at install.

No web app required for the new hire. They can sign in to the app with Slack whenever they want to connect tools or look at the graph.

Next:

- **[Setup and onboarding](../setup.md):** the full admin flow.
- **[Permissions](../permissions.md):** employee memory vs. public and private channel memory.
