# Long-horizon research

Questions that need many sources synthesized into one answer.

> [!NOTE]
> **Not yet.** This page shows the experience the hosted product was building toward. There's no dedicated long-running research mode in this build; a single turn does its best with the sources it can reach.

## The scenario

Some questions aren't a quick lookup. They need pulling information from a lot of distinct places (docs, tickets, meetings, code, past Slack threads) and synthesizing it into one coherent answer. Closer to a research project than "what's the pricing?"

## What it would look like

> **#product**
>
> **You:** @company-brain prepare a brief on how we've handled enterprise SSO requests over the last two quarters: who asked, what we promised, what's still open, and what engineering thinks the real effort is
>
> **Company Brain:** **Enterprise SSO: two-quarter brief**
>
> - **Demand:** 6 serious asks (Acme, Globex, Initech, …). Three converted to paid pilots.
> - **Promises made:** Okta + Azure AD for pilots; custom SAML called "roadmap" in two decks.
> - **Still open:** Globex blocked on SCIM; Initech waiting on audit-log export.
> - **Eng view:** ~6 weeks for Okta/Azure path (from `#eng` thread Mar 18 + Linear ENG-610); SCIM is the long pole.
>
> Sources: Q1/Q2 enterprise notes, Linear ENG-610, Granola "SSO planning", `#sales` threads. Want this as a Linear doc?

## What's really going on

Today, a single turn can already hit multiple [connectors](../connectors.md) and channel memory in one answer. Long-horizon research is for the cases where that isn't enough: the work needs more time, more parallel digging, and a structured synthesis step before it replies.

Until then, break big questions into smaller ones (docs, then tickets, then "summarize what we have"); Company Brain already handles each of those well.

Next:

- **[Answering from docs](knowledge-recall.md):** what single-turn knowledge recall looks like today.
- **[Meeting recall](meeting-recall.md):** pulling decisions out of meeting notes.
