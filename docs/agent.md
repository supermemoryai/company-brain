# Company Brain — Agent runtime

**Anchors:** `apps/api/src/lib/brain/turn/agent.ts`, `agent.impl.ts`, `model-profile.ts`, `billing/*`, DB schemas.

## Durable Object

- Class: `CompanyBrainAgent` extends Agents SDK `Agent`
- Binding: `COMPANY_BRAIN_AGENT`
- **Id:** Supermemory `orgId` via `getAgentByName(..., orgId)`
- Shell stays thin; heavy logic lazy-loads `agent.impl.ts` (worker startup budget)

Explicit Slack turns use **fibers** (`startFiber` + `slack-turn-fiber.ts`) for idempotency, keep-alive, and one recovery attempt after eviction.

## What the DO does (surface)

Grouped public methods on `CompanyBrainAgent` (not exhaustive of internals):

| Area | Examples |
|------|----------|
| Slack turns | `onSlackEvent`, `onSlackChimeIn`, `onSlackContextEvent`, `onSlackReaction`, `onSlackMembershipEvent` |
| Approvals / leases | `onApprovalDecision`, `onLeaseDecision`, `runLeaseEscalation`, connection revoked/changed |
| Connect | `onSlackConnectComplete` |
| Home / install | `setHomeChannel`, `ensurePublicChannelRolloutCard`, `start/runPublicChannelRollout`, install nudge |
| Team lifecycle | automatic invite rollout steps, `onSlackTeamJoin`, `onSlackUserChange` (+ retries) |
| Trial | `claimTrialGrant`, trial reminder arm/run |
| Memory admin | `resetMemoryRegistry`, `get/setWorkspacePrompt` |
| Slack lifecycle | `resetSlackWorkspaceState` (disconnect teardown) |
| Research | `researchCompanyOnSignup`, `runResearchTask`, `getResearchState` |
| Observe | `runChannelObserve` |
| Scheduling | `runScheduledTask`, automations CRUD + `runAutomationNow` |
| Reflect | `runPostTurnReflect` |
| Debug | `debugTurn` |

HTTP that is **not** Slack-events still often targets the same DO (models/settings/research/automations/mcp callback completion).

`resetSlackWorkspaceState` is the disconnect counterpart to install bootstrap. It
clears every Slack-derived table (home/observe, public-channel rollout, team
invite, welcome/notified, channel membership + backfill) and cancels the schedules
those tables own, so a later reinstall starts clean instead of resuming old jobs
against the new token. It is idempotent. Customer disconnect posts a farewell before
reset and uninstall. Operator retirement sends the deprecation notice in an
announcement-only run, then uses a separate removal run for reset and uninstall.
A reset failure still leaves the token in Postgres and the call stays retryable.

## Models

**File:** `apps/api/src/lib/brain/turn/model-profile.ts`  
**API:** `GET/PATCH /brain/models/` → `organization.metadata.brainModels`

| Role | Default model | Default effort |
|------|---------------|----------------|
| Main | `grok-4.5` | `high` |
| Triage | `claude-haiku-4.5` | `low` |
| Research | `grok-4.5` | `high` |

**Main choices:** `claude-sonnet-5`, `claude-opus-4.8`, `claude-sonnet-4.6`, `grok-4.5`, `gpt-5.6`, `gpt-5.5`  
**Triage choices:** `claude-haiku-4.5`, `claude-sonnet-5`  
**Research choices:** `grok-4.5`, `grok-4.3`  
**Effort:** `low` \| `medium` \| `high` \| `xhigh` (provider-mapped). Main effort also accepts `auto`, which uses the effort triage recommended for the turn.

**Step limits:** `MAX_STEPS = 60`, `CONTINUATION_MAX_STEPS = 30`

**Cross-provider fallback**: non-Anthropic main → `claude-sonnet-5`; Anthropic main → `gpt-5.6`. `getBrainModel` installs it as the second gateway candidate on *every* request, and it receives the same tools as the primary.

Workspace prompt: stored on DO, injected as untrusted `<workspace_prompt>` (size-capped) for turns.

## Billing

- LLM usage accumulated on a per-turn ledger (`brain/billing/cost.ts`)
- Charged post-hoc to Autumn **`sm_operations`** (does not block Slack reply)
- Prefer provider-reported USD; else token × list rates (`model-prices.ts`)
- Active trial can mark exhausted on `no_balance` and block further runs via product gates
- Trial helpers: `payments/company-brain-trial.ts`

## Tools assembly (pointer)

`turn/tools.ts` `assembleTurnTools` builds the AI SDK toolset for a turn (memory search, Slack search, MCP runtime, connect, schedule, sandbox, …).  
Slack path forces personal MCP connections only. Approvals + leases: `turn/approval.ts`, `lib/brain/lease/*`, `tools/mcp/*`.

## Data

### Postgres (shared)

Start here:

- `packages/db/schema/slack.ts` — workspace, members, account link, provisioning fields
- `packages/db/schema/brain/mcp.ts` — connections, oauth state, embedded grants
- Org metadata — `brainModels`, product entitlements (`company_brain`)

### Durable Object SQL

Local tables are created across modules (`CREATE TABLE IF NOT EXISTS brain_…`). Inventory with:

```bash
rg -n 'CREATE TABLE IF NOT EXISTS brain_' apps/api/src/lib/brain
```

Important groups: thread turns & approvals, bot threads, event store, chime budget, public-channel rollout, team invite, channel observe, MCP catalog cache, memory tag registry, research, leases, post-turn reflect.

Do not treat DO SQL as cross-org shared state — it is per org DO instance.

### KV

- `slack:oauth:{state}`
- `slack:evt:{event_id}` (and related chime/dedupe keys)

## Configuration (minimum)

| Name | Purpose |
|------|---------|
| `SLACK_SIGNING_SECRET` | Event/interaction verify |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | Install OAuth |
| `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` | Token encryption material / public origin |
| `AUTH_KV` | OAuth + dedupe |
| `HYPERDRIVE` / DB | Workspace & MCP rows |
| `COMPANY_BRAIN_AGENT` | DO namespace |
| `CLOUDFLARE_ACCOUNT_ID` + `COMPANY_BRAIN_AI_GATEWAY_NAME` + `COMPANY_BRAIN_AI_GATEWAY_TOKEN` | **All three required.** Every model call routes through this gateway; `brainGatewayConfig` returns `null` unless all three are set, and `wrapBrainGateway` then throws before the call |
| `COMPANY_BRAIN_GOOGLE_WORKSPACE_CLIENT_ID/SECRET` | Embedded Google (Gmail) |
| Optional GitHub MCP client id/secret | Catalog GitHub connect without DCR |

Feature: `features.companyBrain` (cloud on, self-hosted off).

## Observability

- Sentry on worker; PostHog AI spans for turns + `company_brain_triage`
- Triage capture is best-effort after route is fixed; failures must not include raw Slack/prompt text in local warnings
- Product event catalog: `docs/product/product-analytics.md`

## Related

- [architecture.md](./architecture.md) — system map + memory/tools summary  
- [slack.md](./slack.md) — Slack-specific behavior  
- `apps/api/AGENTS.md` — cloud vs self-hosted boundary for the API app  
