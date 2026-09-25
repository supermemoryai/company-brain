# Meeting scheduling

Find free time and send a calendar invite from Slack.

> [!NOTE]
> **Not yet.** Calendar scheduling isn't in Company Brain: there's no calendar connector in the catalog. (A marketplace or custom calendar MCP server under Configure → Integrations may get you part of the way, but it isn't a built-in flow.) This page shows the experience the hosted product was building toward.

## The scenario

A teammate needs help and doesn't want to play calendar ping-pong. They ask in Slack; Company Brain checks availability and offers to book the slot.

## What it would look like

> **#eng**
>
> **Sam:** Dhravya are you free this afternoon? need some help with dev setup
>
> **Company Brain:** Dhravya is free at **2:00 PM**. Sending an invite to block **20 mins** on both your calendars.

## What's really going on

It would be a [tool connector](../connectors.md) against the calendar, with the same personal-vs-org rules and [write-under-your-account](../permissions.md#tool-access-follows-you-not-the-connection) attribution as Linear or GitHub. Creating an invite is a write, so it would run as the person who has the calendar connected, or via an explicit [lease](../permissions.md#leasing-borrowing-access-for-one-request) if someone else is lending access for that one request.

Until then: ask Company Brain for *context* around scheduling ("who's the right person for dev setup?" / "when did we last pair on this?") and book the time the usual way. Reminders work today, though: "remind me at 2pm to pair with Sam" is a scheduled run (see [Automations](../automations.md)).

Next:

- **[Permissions](../permissions.md):** how personal tools and leasing apply.
- **[What you can do](overview.md):** back to all scenarios.
