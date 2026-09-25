# Incidents and downtime chatter

Answer "is prod down?" from live Sentry, and post scheduled error digests.

## The scenario

Someone drops a vague "is prod down?" in `#eng`. Company Brain correlates it with what's actually failing right now, and a separate automation keeps a daily error digest flowing without anyone asking.

## What happens

> **#eng**
>
> **Alex:** is prod down? a couple of customers are pinging me
>
> **Company Brain:** Not a full outage: **`api/search` is elevated** (42 errors in the last 15m, mostly `timeout on vectorize`). Sentry issue [SM-2041](https://example.com). Deploy from this morning is the likely culprit; rollback candidate is `af61880`.

Or, without anyone asking, a scheduled automation posts every morning:

> **#eng**
>
> **Company Brain:** **Daily error digest**: 3 issues new since yesterday, 1 still spiking (`api/search` timeout). Full list in Sentry.

## What's really going on

The first exchange is a [chime-in](../automations.md#proactiveness-chime-in) (or an @mention; either works) that hits the **Sentry** [tool connector](../connectors.md) for live error data. The second is an [automation](../automations.md#automations): a recurring prompt on a schedule that posts to a channel using org-shared connections only, so it never runs as a specific person. For that to work, Sentry needs an org-shared connection, not just someone's personal one.

If the channel is private, only an admin can target it with an automation from Configure, and the bot fails closed if it can't verify the destination.

Next:

- **[Connectors](../connectors.md):** connect Sentry (and friends) for live incident context.
- **[Automations](../automations.md):** schedule digests and understand chime-in.
