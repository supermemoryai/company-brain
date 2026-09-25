# Automations and proactiveness

Scheduled work Company Brain runs on its own, and when it speaks without being asked.

Company Brain doesn't only answer when you @mention it. It can run recurring work on a schedule, and it can speak in a thread on its own when it has something genuinely worth saying. Both are rate-limited, and both read from exactly the same [permissions graph](permissions.md) as a normal question; neither is a backdoor around it.

## Automations

An automation is a prompt that runs on a schedule and posts the result somewhere. You write it once, in plain language:

> **#product**
>
> **You:** @company-brain every Monday at 9am, post a digest of what shipped last week and what's still open, to #product.
>
> **Company Brain:** Got it, scheduled. First digest posts Monday, 9:00 AM, to #product.

The same scheduler also handles one-off runs and reminders ("in 2 hours remind me to ship", "tomorrow at 10 check whether the migration finished"). A reminder delivers your own message back when it fires; a digest produces a fresh roundup.

How a scheduled digest runs:

1. **Schedule fires.** The automation wakes up at its set time; no one has to trigger it.
2. **Gathers context.** A digest posted to a channel reads using only **org-shared** connections and channel memory, never a person's personal credentials, even if the person who created it has better personal access. This is what keeps a scheduled post from silently acting as a specific teammate. Digests are **read-only**: they can look things up in your tools but never write to them.
3. **Checks the destination.** Before posting, it confirms it can still post to the destination channel.
4. **Posts, or fails closed.** If anything above is unclear (a connection broke, the destination can't be verified), it skips that run rather than posting a guess. Silence beats a wrong digest.

**Who can target what:**

| Destination | Who can create it | Reads from |
|---|---|---|
| Public channel | Any member | Org-shared connections, public channel memory |
| Private channel | Admins only (from Configure); from Slack, members of that channel | Org-shared connections, that channel's memory |
| DM to yourself | You | Your personal + org connections, your employee memory |

Common shapes worth stealing:

- A Monday-morning digest of open items and unanswered questions
- A daily Sentry error recap in `#eng`
- A weekly "what changed across our connected tools" summary

Ask Company Brain in Slack to set one up, or manage them under **Configure → Automations**, where they run daily or weekly and you can **Run now** to test one. Anyone can create and manage their own (members can own up to 20); admins can manage everyone's.

## Proactiveness (chime-in)

Chime-in is different from an automation: there's no schedule, and no one asked. Company Brain is simply present in a channel, and it speaks up when staying quiet would waste someone's time.

**What actually earns a chime-in:**

- It has to add something the room doesn't already have (a fact, a correction, a next step), not agreement or a restatement of what's already visible.
- It has to come from somewhere it's genuinely allowed to look: [connected tools](connectors.md) or that room's own memory, same as any other answer.
- If it isn't confident the answer is actually correct, it says nothing. A wrong guess is worse than silence, so uncertainty resolves to silence, not a hedge.

```text
Worth chiming in:
"is prod down? customers are pinging me"
→ correlates against Sentry, replies with what's actually elevated right now

Not worth it:
"finally shipped this 🎉" (screenshot, no question)
→ stays quiet, there's nothing to add
```

**Guardrails that keep it from becoming noise:**

- **Rate-limited.** It won't speak repeatedly in the same place in a short window (at most a few unprompted replies per hour, with a minimum gap between them), even if it technically could add something each time.
- **Invited rooms only.** It only speaks where it's already a member: public channels an admin rolled it out to, and private channels someone invited it into.
- **Same graph as a normal answer.** A private channel's chime-in only ever draws on that channel's memory and public channel memory, never another private channel, never someone else's employee memory.

An explicit @mention (or a DM) always skips this judgment call entirely: naming it is you deciding it should speak, so it does.

### Turning it up or down

Admins control this under **Configure → Proactivity**:

- **All channels** (the default): it joins any conversation it's been added to when it can help.
- **Only its own channel**: it speaks unprompted only in `#company-brain`; everywhere else it waits for an @mention or DM.
- **Per-channel exceptions**: mark individual channels **Proactive** or **Quiet** to override the default.

`#company-brain` is always proactive, and DMs and @mentions are never affected by these settings.

> [!NOTE]
> Automations and chime-in both write back to memory the same way a normal conversation does: a public channel's automation output lands in public channel memory, a private channel's chime-in stays scoped to that channel's memory.

Next:

- **[What you can do](use-cases/overview.md):** real scenarios: support, incidents, digests, and more.
- **[Connectors](connectors.md):** wire up the tools automations and chime-in draw from.
