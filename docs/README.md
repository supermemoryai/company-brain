# Company Brain

Company Brain is Supermemory’s **org-scoped agent**: a Cloudflare Worker receives Slack (and related) HTTP traffic, then an Agents SDK **Durable Object per org** owns turns, memory, tools, rollout, and background work.

**Feature flag:** `features.companyBrain`  
- Cloud default: **on** (`apps/api/src/config/defaults.ts`)  
- Self-hosted default: **off**

**Mount:** `/brain/*` from `apps/api/src/cloud-extras.ts` → `apps/api/src/routes/brain/index.ts`

## User guide

For how Company Brain behaves day to day (memory and permissions, connectors, automations, proactivity, and walkthroughs), see the [user guide](./guide/README.md).

## Docs in this folder

| Doc | What it’s for |
|-----|----------------|
| [architecture.md](./architecture.md) | End-to-end map, privacy + tools summary |
| [slack.md](./slack.md) | Install, events, turns, triage/chime, rollout, UX |
| [agent.md](./agent.md) | DO surface, models, billing, data pointers |
| [spec.md](./spec.md) | Full technical spec: beachhead, signup research, turn finalization, `finish_turn`, recovery, gateway health, effort levels |
| [local-dev.md](./local-dev.md) | Run it locally: Slack sandbox, tunnel, env vars, `/brain` install |
| [do-split-runbook.md](./do-split-runbook.md) | Moving `CompanyBrainAgent` to its own worker: `exports` transfer, four deploys, risks |
| [slack-app-manifest.yaml](./slack-app-manifest.yaml) | Manifest for creating a personal Slack app |

The first three pages are the short orientation; `spec.md` is the long-form detail
they summarize. `spec.md` predates recent work and still has stale passages, so
treat neither as authoritative over the code.

**Rule:** code is source of truth. If these pages disagree with `apps/api/src/lib/brain/**`, fix the docs in the same change.

## Quick verify (against code)

```bash
rg -n 'export const BRAIN_MODEL' apps/api/src/lib/brain/turn/model-profile.ts
rg -n 'SHARED_TEAM_BRAIN_CONTAINER_TAG' apps/api/src/lib/spaces/provisioning.ts
rg -n 'personalConnectionsOnly: true' apps/api/src/lib/brain/slack/turn.ts
rg -n 'limit: 40' apps/api/src/lib/brain/memory/search-brain.ts
rg -n 'companyBrain: true' apps/api/src/config/defaults.ts
```

## Primary code roots

- `apps/api/src/routes/brain/` — HTTP
- `apps/api/src/lib/brain/slack/` — Slack orchestration
- `apps/api/src/lib/brain/turn/` — DO agent + model loop
- `apps/api/src/lib/brain/memory/` — search / writeback / tags
- `apps/api/src/lib/brain/tools/` — MCP, sandbox, scheduling
- `apps/api/src/lib/spaces/provisioning.ts` — container tag constants
- `packages/db/schema/slack.ts`, `packages/db/schema/brain/` — Postgres
