# Sandbox debugging

Hand it a failing test: it runs the code in an isolated workspace and reports back.

## The scenario

A test is failing and the stack trace alone isn't enough. You want Company Brain to actually run the code, not just describe what it *would* do.

## What happens

> **#eng**
>
> **You:** @company-brain the `permissions.lease` unit test is failing on main, can you reproduce and tell me why?
>
> **Company Brain:** Reproduced in a sandbox against `main`.
>
> **Failure:** `permissions.lease` expects temporary access to expire in 15 minutes, but the fixture still asserts 30.
> **Cause:** the default was shortened in `#1188`; the unit test wasn't updated.
> **Fix:** point the assertion at the shared default so it can't drift again.

## What's really going on

Company Brain spins up an **isolated workspace**, clones what it needs, runs the command, and reads the output. It's not guessing from static code alone; it's executing. It can also produce files (a chart, a PDF, a CSV) and upload them to the thread.

The workspace is a [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) container running in your own Cloudflare account, with git and Python (numpy, pandas, matplotlib) available. It sleeps after 30 minutes idle, and a fresh one starts the next time it's needed. Containers need the Workers Paid plan: uncomment the Workers Paid block in `wrangler.jsonc` to enable them, and have Docker running for local development. On the free plan, or if you prefer it, set `DAYTONA_API_KEY` and workspaces run on Daytona instead. With neither, the sandbox tools stay hidden.

Guardrails are intentional, so it's safe to hand real tasks to:

- Only public `https` repositories, and never with credentials in the URL
- No `git push`, no deploys
- No `sudo`, no `curl ... | sh`, no destructive root removal
- No long-running dev or HTTP servers
- Commands time out (30 seconds by default, 2 minutes at most)

Think of it as a sealed workbench: useful for reproduce / inspect / explain loops, not for shipping changes on your behalf.

Next:

- **[Acting in tools](acting-in-tools.md):** when the next step is a Linear issue or a PR lookup.
- **[What you can do](overview.md):** all the scenario walkthroughs.
