# Moving the Company Brain to its own worker

The brain (`CompanyBrainAgent`) currently lives inside the `supermemory` worker, so
it loads every HTTP route and library before doing any work. This moves it into its
own worker, `supermemory-brain`.

| | Code loaded |
|---|---|
| Now | 12.9 MB |
| After | 6.5 MB |

Cloudflare allows 128 MB. On 2026-08-19 the brain sat at 96.6 MB before doing
anything, so halving the code buys real room.

## The data does not move

A Durable Object is two things: the **code** (lives in a worker) and the **data**
(one SQLite database per org, stored on Cloudflare's side).

Only the code moves. Same orgs, same databases, nothing copied, nothing wiped.
Cloudflare just changes which worker may open them.

## Three steps, in this order

```
0. run:   bun run secrets:sync:brain                 ← push dotenvx secrets to the brain worker
1. run:   cd apps/api && bun run deploy:brain     ← the move happens here
2. merge: this PR to main                          ← CI deploys supermemory
```

**Steps 0 and 1 must happen before the merge.** `supermemory` auto-deploys on every merge
to `main`, so merging first would point it at a worker that does not exist yet.

### Step 0 — put the brain's secrets on the new worker

Secrets are per Worker script; nothing is inherited from `supermemory`. Until this
runs, the brain has none and fails on its first model call.

`wrangler.brain.jsonc` declares the 50 the brain actually needs (the 13 dropped are
Stripe, Autumn, Plain, Composio and other HTTP-route concerns it never runs, plus
`DATABASE_URL`, which it reaches through the `HYPERDRIVE` binding). Push the values
from the committed dotenvx `.env.production` (same source as `bun run deploy`):

```bash
cd apps/api && bun run secrets:sync:brain
```

Keep this separate from `deploy:brain`. Workers Builds for `supermemory-brain`
runs `bun run deploy:brain` and does not have `DOTENV_PRIVATE_KEY_PRODUCTION`, so
baking sync into that script would fail the build. Re-run `secrets:sync:brain`
whenever `.env.production` gains keys the brain needs.

### Step 1 — deploy the new worker

`wrangler.brain.jsonc` is already written. It carries the instruction that moves
the brain:

```jsonc
"migrations": [{
  "tag": "transfer-company-brain-agent",
  "transferred_classes": [{
    "from": "CompanyBrainAgent",
    "from_script": "supermemory",
    "to": "CompanyBrainAgent"
  }]
}]
```

```bash
cd apps/api && bun run deploy:brain
```

This first run is manual because it carries the transfer migration and should land
in a quiet hour. Wire up the Workers Build for it after step 2 (see Risks) so later
brain changes deploy on their own.

Use `bun run build` for a local dry run of both workers. Do not append `--dry-run`
to a script that chains commands: extra args reach only the last command in the
chain, so the earlier ones would still run for real.

Cloudflare creates `supermemory-brain` and hands it the brain's data. The old
worker keeps serving until step 2.

### Step 2 — merge this PR

Two changes are already made:

- `wrangler.jsonc` — the binding now says `"script_name": "supermemory-brain"`
  (in both the main block and `previews`), so `supermemory` calls the new worker.
- `worker.ts` — the export is now **type-only**:
  ```ts
  export type { CompanyBrainAgent } from "./src/lib/brain/turn/agent"
  ```
  Keep the word `type`. Without it the brain stays in this worker and the split
  does nothing.

Merging deploys `supermemory`.

## Check afterwards

- Ask the brain something in Slack and get an answer — proves the data came along.
- A `run_app_code` call works — it needs `CodemodeRuntime`, exported from `worker-brain.ts`.
- A scheduled reminder fires — proves alarms survived.
- Brain memory on the Durable Objects metrics page, against 96.6 MB.

## Running it locally after the split

Nothing changes for you — `bun dev` still starts everything:

```bash
cd apps/api && bun dev
```

It now launches the brain worker in the background and portless in the foreground,
and stops both on Ctrl+C. Wrangler wires them together on its own. Look for:

```
env.COMPANY_BRAIN_AGENT (CompanyBrainAgent, defined in supermemory-brain)  local [connected]
```

`[not connected]` on the first print is normal — the API starts before the brain
finishes booting, then reconnects. If it stays that way, the brain failed to start.

### Why local dev uses a generated config

The production config moves the class with `transferred_classes`. Locally there is
no source worker to move from, so wrangler would create `CompanyBrainAgent` on the
pre-SQLite backend and every `agent.sql()` would throw:

```
SqlError: SQL is not enabled for this Durable Object class.
```

`dev:brain` therefore runs `scripts/brain-dev-config.mjs` first, which copies
`wrangler.brain.jsonc` into a gitignored `wrangler.brain.dev.json` with the
migration swapped for `new_sqlite_classes`. Nothing to maintain — it is derived on
every start.

If you hit that error once, delete the local state wrangler already wrote for the
class, or it stays on the old backend:

```bash
rm -rf apps/api/.wrangler/state/v3/do/supermemory-brain-CompanyBrainAgent
```

### Ports

Two ports are in play, which is expected: portless assigns the API's port as usual,
and the brain takes a random free one. You never call the brain over HTTP — its
`fetch` returns 404 — so its port only matters to wrangler's local discovery. It is
deliberately not fixed, because several worktrees often run `dev` at once and a
hardcoded port would collide.

Other scripts:

- `bun run dev:brain` — brain only (random port; set `BRAIN_PORT` to pin one)
- `bun run dev:api-only` — API only, brain binding stays `[not connected]`

Two `wrangler dev` processes are required. Passing both configs to a single process
(`wrangler dev -c wrangler.jsonc -c wrangler.brain.jsonc`) fails on wrangler 4.103.0
with `Failed to start the remote proxy session`.

## Measured on a rehearsal

Cloudflare does not document what a transfer does to live traffic, so it was run
end to end on 2026-08-19 with two throwaway workers (`sm-do-rehearsal-a` / `-b`,
personal account, since deleted): a SQLite-backed DO with 10 rows, transferred
A → B and then B → A. It used the same `migrations` / `transferred_classes` flow as
step 1 above, not `exports`.

- **Data survives.** All 10 rows read back intact through the new worker, in both
  directions. Nothing copied, nothing lost.
- **The old worker keeps serving.** After the transfer, worker A still returned all
  10 rows (HTTP 200) even though the class had moved. Cloudflare forwards the old
  binding, so `supermemory` keeps working before its config points at the new worker.
- **In-flight requests fail at the end, not at the switchover.** A 60-second request
  was held open and the transfer landed 11 seconds in. It ran its **full 60 seconds**,
  then returned `HTTP 500, error code 1101` when it touched storage that had moved:

  ```
  start=13:12:41
  error code: 1101
  HTTP=500  total=60.106375s  end=13:13:41
  ```

  So a brain turn running during step 1 does its whole 2–15 minutes of work and
  spends the tokens before failing, rather than stopping early.

## Risks

- **All at once.** Cloudflare will not roll this out gradually.
- **Turns running during step 1** lose their answer at the end — see above.
- **Give `supermemory-brain` its own Workers Build after step 2**, or brain code
  changes will never reach production. `worker.ts` exports the class type-only now,
  so `src/lib/brain/**` edits ship to `supermemory` where they are unused. Add a
  build in the dashboard: same repo, branch `main`, deploy command
  `cd apps/api && bun run deploy:brain`. This matches how `console-v2` and the
  observatory workers are wired. **Preview (non-`main`) builds must use the same
  wrangler config path** (`apps/api/wrangler.brain.jsonc`). If the
  preview trigger falls back to `apps/api/wrangler.jsonc`, Cloudflare fails the
  Workers name check (`supermemory` ≠ `supermemory-brain`) and every brain-touching
  PR stays red while `main` stays green.
- **API Previews share the production brain.** `COMPANY_BRAIN_AGENT` uses
  `script_name: "supermemory-brain"`. Cross-worker Durable Object bindings resolve
  to that Worker's **production** namespace, not a matching Preview — a current
  Preview limitation. AUTH_KV, Hyperdrive, and Workflow names in `previews` are
  isolated test resources. Same-worker brain Previews (`wrangler.brain.jsonc`)
  get isolated DO state automatically.
- **Previews replay Durable Object migrations from scratch.** The
  `company-brain-agent` tag still lists `CompanyBrainAgent` as a new SQLite
  class, so `worker.ts` exports an empty `DurableObject` stub under that name.
  Without it, `wrangler preview` fails with 10070. Keep the stub empty — the
  real class must stay in `worker-brain.ts`.

## Notes

`wrangler` 4.103.0 does not support Cloudflare's newer `exports` config — it warns
`Unexpected fields found in top-level field: "exports"` and silently ignores it,
which would deploy with no Durable Object config at all. Stay on `migrations`
until wrangler is upgraded.
