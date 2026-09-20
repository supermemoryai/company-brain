# Company Brain Slack Bot Technical Spec

## Purpose

The Company Brain Slack bot is the Slack-facing interface for an organization's shared Supermemory knowledge. It answers Slack mentions, DMs, and bot-owned threads by combining:

- persisted company memory search,
- live app tools exposed through connected MCP servers,
- Slack streaming responses,
- selective write-back of durable facts into the company brain.

The current implementation is Cloudflare-first: a Hono route receives Slack HTTP traffic, then hands real turn work to an org-scoped Cloudflare Durable Object implemented with the `agents` package.

## Code Map

| Area | File |
| --- | --- |
| Worker entry and exports | `apps/api/worker.ts` |
| Route mounting and feature flag | `apps/api/src/cloud-extras.ts` |
| Slack HTTP routes | `apps/api/src/routes/brain/slack/index.ts` |
| Per-org model and reasoning API | `apps/api/src/routes/brain/models.ts` |
| Model profile resolution | `apps/api/src/lib/brain/turn/model-profile.ts` |
| MCP connections API | `apps/api/src/routes/brain/mcp-connections.ts` |
| MCP connect button UI | `apps/api/src/lib/brain/slack/mcp-connect.ts` |
| Turn orchestration | `apps/api/src/lib/brain/slack/turn.ts` |
| Per-thread turn control / steering | `apps/api/src/lib/brain/slack/turn-control.ts` |
| Passive thread triage | `apps/api/src/lib/brain/slack/triage.ts` |
| Smart chime-in | `apps/api/src/lib/brain/slack/chime.ts`, `chime-cooldown.ts` |
| Public-channel rollout | `apps/api/src/lib/brain/slack/public-channel-rollout.ts` |
| Seven-day Slack history documents | `apps/api/src/lib/brain/slack/history-document.ts` |
| Channel theme and introduction generation | `apps/api/src/lib/brain/slack/channel-introduction.ts` |
| Organization-shared tool corroboration | `apps/api/src/lib/brain/slack/connected-tool-crosscheck.ts` |
| Channel history lookup | `apps/api/src/lib/brain/slack/channel-lookup.ts` |
| MCP catalog/connect/runtime tools | `apps/api/src/lib/brain/tools/mcp/` |
| Web search and page extraction | `apps/api/src/lib/brain/tools/web/` (Context.dev client: `apps/api/src/lib/context-dev/`) |
| Slack workspace schema | `packages/db/schema/slack.ts` |
| Worker bindings | `apps/api/wrangler.jsonc` |
| LLM cost ledger + charge | `apps/api/src/lib/brain/billing/cost.ts` |
| List-price fallback rates | `apps/api/src/lib/brain/billing/model-prices.ts` |
| `sm_operations` credit rate | `apps/api/src/lib/payments/meter-rates.ts` |

## Runtime Architecture

The Cloudflare Worker exports `CompanyBrainAgent` from `apps/api/worker.ts`. Wrangler binds it as the `COMPANY_BRAIN_AGENT` Durable Object namespace. The Slack route obtains an org-specific instance with:

```ts
getAgentByName(c.env.COMPANY_BRAIN_AGENT, ws.orgId)
```

That makes the Supermemory org id the Durable Object identity. The practical consequence is that Slack turn state is serialized per organization and can use the DO's embedded SQL storage for local idempotency and thread tracking.

The `CompanyBrainAgent` class extends `Agent<Env, CompanyBrainState>` from the `agents` package. It uses local SQL tables for turn state and lightweight Slack thread memory:

- Agents SDK managed-fiber tables durably accept explicit Slack turns, deduplicate them by Slack `event_id`, keep the Durable Object alive while they run, and retain recovery checkpoints across eviction.
- `brain_thread_turn(thread_key, turn_id, revision, status, asker_user, original_question, latest_instruction, updated_at)` so the active Slack-thread turn can be stopped, superseded, resumed after approval, or marked stale before late async side effects run.
- `brain_bot_thread(team_id, channel, thread_ts, updated_at)` so the bot can keep responding inside threads it has already joined, even when Slack thread reads are temporarily unavailable.

It also schedules a daily `dream` callback at `0 3 * * *`; the current implementation logs the tick.

## Feature Gating

Company Brain routes are mounted only when `features.companyBrain` is enabled. The brain router mounts Slack beneath `/brain/slack`:

```ts
if (features.companyBrain) {
  app.route("/brain", brainRoutes)
}

brainRoutes.route("/slack", slackRoutes)
```

Cloudflare defaults enable Company Brain. Self-hosted defaults disable it, which avoids requiring `cloudflare:workers`, Durable Object bindings, and the production Slack environment variables in self-hosted mode.

## LLM cost metering (`sm_operations`)

Company Brain LLM usage is debited from the org’s `usd_credits` wallet via Autumn’s `sm_operations` metered feature (credit-system conversion).

### Timing

A per-turn `BrainCostLedger` accumulates generation costs during:

- main turns (`computeTurn`) — including secondary calls on the same ledger: `resolve_entity` web research, MCP approval classifier, and per-request vendor spend from `search_web` / `web_extract` (see [Web Tools](#web-tools)).
- approval resumes / continuations (`resumeTurn`) — same secondary paths
- public-channel triage (`triage.ts`)
- active-turn gate (own short charge)
- public-channel rollout: theme extract, introduction compose, connected-tool crosscheck
- install starters, research announce, onboarding research, company-summary

After the turn finishes, `scheduleChargeBrainLlmCost` registers the **real** Autumn track promise with DO/Worker `waitUntil` (internal catch; slow-charge log only — timer does not settle waitUntil). Charging is post-hoc; the user-facing Slack reply is not blocked on Autumn.

When `trackBillable` returns `no_balance`, the cached entitlement verdict is dropped so the next turn re-reads Autumn and blocks. Metadata `brainTrialStatus` is still set to `exhausted` for an **active trial** org, but that flag is bookkeeping — it no longer gates anything.

### Entitlement

`getCompanyBrainEntitlement` (`lib/payments/company-brain-entitlement.ts`) is the single runtime gate. It reads **`organization_billing_state`** through `readBillingSnapshot` — never org metadata, which drifts when a trial lapses without a webhook landing. A turn runs when three things hold: `planIds` contains an active **Max or Scale** base plan, `planIds` contains `company_brain`, and `balances.usd_credits.remaining` is above zero (an `unlimited` balance also passes). There is no free Company Brain — the 14-day **Max** trial is the only unpaid path, it takes a card before it starts, and Enterprise is not a Company Brain plan. Overage is deliberately not honoured: credits are the ceiling. Deny reasons are `no_plan`, `trial_ended`, `no_addon`, `no_credits`, `not_provisioned`, and `temporarily_unavailable` (billing state unreadable — denies, but the copy says to retry rather than to upgrade).

Trial and paid need no separate handling: the sync keeps products that are `active` **or** `trialing`, so a trialing Max sits in `planIds` exactly like a paid one, and Autumn drops it when the trial lapses unpaid. Never test for the literal status `"trialing"` — a Company Brain trial reports `status: "active"` with `trialEndsAt` set. `trial_ended` versus `no_plan` is chosen from org metadata (`brainTrialStatus` / `brainTrialStartedAt`) purely to pick the right sentence; metadata never decides entitlement, so stale metadata can only mis-word a denial.

The turn never blocks on Autumn. The row is refreshed by `syncBillingStateInBackground` handed to the caller's `waitUntil` (the Durable Object's on Slack paths, `c.executionCtx` on routes). A denial passes `force: true` so a top-up frees the org on the next turn instead of waiting out the 30s sync debounce. The add-on is read from `planIds`, not `addonIds` — the sync never populates that column.

Only the first turn for an org with no row pays for an inline `syncBillingStateNow`; if that still yields no row the verdict is `not_provisioned`, which fails closed. Between syncs the balance stays honest because `chargeBrainLlmCost` debits `usd_credits` locally via `applyLocalBillingUsage` after a successful track. The Autumn `customer.products.updated` webhook and every successful Slack OAuth install also refresh the row.

### Plans, seats, and conversion

Company Brain is sold on **Max** ($100/mo, $130 credits) and **Scale** ($399/mo, $600 credits). Pro is not a Company Brain plan: `/api/autumn/attach` and `/api/autumn/multiAttach` reject `api_pro` for a Company Brain org, and the plan pickers do not offer it. `COMPANY_BRAIN_BASE_PRODUCTS` covers Max and Scale only — Enterprise is not a Company Brain plan.

Seats are unlimited for **every** Company Brain org, on any plan: a shared brain is useless if part of the team cannot reach it, and spend is bounded by the credit balance regardless of headcount. `COMPANY_BRAIN_SEAT_LIMIT` (3) now only serves as the floor for `brainMode=team` orgs still waiting on the add-on webhook. API-only orgs on `api_max` keep their normal 3-seat cap. Scale keeps the connector and access-control upsell: GitHub, S3, Web Crawler, restricted access, and container tags.

New signups are paused: `POST /brain/trial/start` no longer calls `attachCompanyBrainTrial` and always answers `409 trial_unavailable` (orgs already entitled still get `already_active`), org creation rejects `metadata.brainMode = "team"` (`403 team_signups_paused`), and `brainMode` is server-owned on org updates like `activeProducts`. The trial mechanics below still describe how existing trial orgs were provisioned and how their webhooks finalize.

The 14-day trial attaches `api_max` with 200 `usd_credits` and `cardRequired: true`, so the `company_brain` add-on is present during the trial and is **not** proof of payment. Nothing is granted while checkout is open: attach returns Autumn's `paymentUrl`, the org sits at `brainTrialStatus=pending_payment`, and the products webhook finalizes it once the base plan is live — claiming `pending_payment → finalizing` with a conditional UPDATE so duplicate deliveries cannot both provision. Conversion is recorded only when that webhook sees a paid base plan whose `trialEndsAt` has passed, alongside the add-on, at which point `markCompanyBrainConvertedIfPaid` sets `brainTrialStatus=converted`. Because a trial reports `status: "active"`, trial-versus-paid is decided on `trialEndsAt`, never on status alone.

Finalizing the trial also sends the welcome email (`lifecycle/company-brain/welcome`). It goes to the one person who paid (`brainTrialInitiatedByUserId`, not every admin) and leads with the cal.com setup call rather than the app link, because roughly half of card-paying orgs never install Slack on their own. It is fired in `waitUntil` so it never blocks the 200, and it is gated on `features.email` like every other lifecycle email. There is no retry: `finalizeCompanyBrainTrialIfPaid` only returns `finalized: true` once, so a send that fails is reported to Sentry and that org simply does not get the email. The idempotency key `cb-welcome:<orgId>` covers duplicate Autumn deliveries.

Every trial-status transition is a conditional UPDATE (`patchTrialStatusWhere`): `exhausted` and `expired` only write while the row still reads `active`, and `converted` only writes when it is not already converted. A terminal trial state therefore cannot overwrite a paid conversion, whichever writer wins the race.

The day 12 / 15 / 17 installer DMs present Max and Scale as a choice rather than Scale alone. Day 12 only fires while the org is genuinely mid-trial, tested as a `COMPANY_BRAIN_BASE_PRODUCTS` plan with `trialEndsAt` still in the future — not a hardcoded plan id, and not `status === "trialing"`, which Autumn never reports. The day-12 message includes the account's metered `usd_credits` usage via `getAutumnFeatureRowUsed`. This is aggregate usage on the account, not trial-scoped: for an org that existed before the trial it can include earlier usage. Later days omit it because the billing period may have reset.

### Cost source (hybrid)

For each generation (`recordFromGeneration` / `recordFinishEvent`):

1. **Provider-reported USD** when present (e.g. xAI `cost_in_usd_ticks` on `usage.raw`, provider metadata, or non-stream `response.body.usage`). Prefer this over any local table.
2. **Estimate** from token counts × list rates in `model-prices.ts` when the provider did not return a dollar amount (Anthropic, OpenAI, Gemini, etc.).
3. **Missing** → `$0` for that step (logged); does not invent a price for unknown models.

### Vendor spend (non-LLM APIs)

`recordVendorUsd(label, usd)` puts per-request API spend on the same ledger with `source: "vendor"` and zero token counts, so one turn converts model and vendor cost together in a single charge.

`search_web` and `web_extract` read `key_metadata.credits_consumed` off each context.dev response and convert at `USD_PER_CREDIT` (`0.0015`, the Hobby overage rate of $15 per 10,000 credits). One search or one page scrape is 1 credit, so 15 `sm_operations` at the fallback credit cost. `web_extract` records per URL, so a partial batch bills only the pages that returned. Failed and rate-limited calls consume no credits and bill nothing.

AI SDK `inputTokens` is total input. Cache read/write from `inputTokenDetails` / `outputTokenDetails` are a **subset** of that total. The estimate path bills base input rate only on non-cached input (`input − cacheRead − cacheWrite`), then adds cache-read and cache-write rates separately so cached tokens are not double-charged.

### Conversion

```
ops = ceil(usd / creditCost)
```

`creditCost` is the Autumn `usd_credits.creditSchema` entry for `sm_operations` (credits burned per op unit), loaded via `getSmOperationsCreditCost()` with a short in-memory cache. If Autumn is unavailable or the schema row is missing, the code falls back to `FALLBACK_SM_OPERATIONS_CREDIT_COST` (`0.0001`).

### Failure and retry

| Outcome | Behavior |
| --- | --- |
| `usd ≤ 0` | No track call; optional log when the ledger had steps with missing cost |
| `ops ≤ 0` after conversion | No track call; warn |
| Billing disabled / excluded org | `trackBillable` skips; turn still succeeds |
| Autumn `no_balance` | `trackBillable` skips; nothing is debited locally, and the background sync brings the zero balance back so the next turn blocks on `no_credits` |
| Autumn track error | `trackBillable` returns skipped; logged under `[company-brain-billing]` |
| Rate load failure | Use fallback `creditCost`; still attempt track |

There is no automatic retry of a failed track. Charging is post-hoc, so the turn that spends the last credits still completes; the next turn is the one that gets blocked.

### Logs

Structured console lines use the `[company-brain-billing]` prefix with org, source (`compute` / `resume` / `triage` / …), trace id when present, total USD, ops, rate source (`autumn` | `fallback`), and a short per-model breakdown.

## Authentication And Authorization

### Slack Install OAuth

Install is initiated at `GET /brain/slack/oauth/install`. This route requires normal Supermemory auth context:

- `c.get("org")` must exist.
- `c.get("user")` must exist.

The route creates a random state, stores `{orgId,userId}` in `AUTH_KV` under `slack:oauth:{state}` for 600 seconds, then redirects to Slack OAuth with these bot scopes:

- `app_mentions:read`
- `assistant:write`
- `chat:write`
- `channels:history`
- `channels:join`
- `channels:manage`
- `channels:read`
- `channels:write.invites`
- `files:read`
- `files:write`
- `groups:history`
- `groups:read`
- `im:history`
- `im:write`
- `reactions:read`
- `reactions:write`
- `team:read`
- `usergroups:read`
- `users:read`
- `users:read.email`

The callback at `GET /brain/slack/oauth/callback` is in the auth passthrough list because Slack calls it directly. The route validates and deletes the state, exchanges the code via Slack `oauth.v2.access`, encrypts the returned bot token, and upserts the `slack_workspace` row.

Adding the public-channel rollout does not require a separate Slack API feature toggle or a new Events API subscription. The app's existing Interactivity request URL must point at `/brain/slack/interactions`. Workspaces installed before the public-channel scopes were added must reinstall/reauthorize once; the rollout button detects missing granted scopes and explains this instead of starting a partial run.

### Slack Event Authentication

Events are delivered to `POST /brain/slack/events`, also in the auth passthrough list. It does not use Better Auth. Instead, it validates Slack's request signature:

- reads the raw request body,
- checks `x-slack-signature`,
- checks `x-slack-request-timestamp`,
- rejects requests with more than five minutes of timestamp skew,
- computes `v0:{timestamp}:{rawBody}` HMAC-SHA256 with `SLACK_SIGNING_SECRET`,
- compares with `timingSafeEqual`.

If verification fails, the route returns `401`.

### Token Storage

Slack bot tokens are encrypted before writing to Postgres:

- key material: `BETTER_AUTH_SECRET`,
- derivation: PBKDF2, SHA-256, 100,000 iterations,
- salt: `supermemory-connections`,
- cipher: AES-GCM,
- IV: random 12 bytes prepended to ciphertext.

The agent decrypts the token only when it needs to call the Slack Web API during a turn.

## Data Model

### `slack_workspace`

The table is keyed by Slack `team_id` and maps one Slack workspace to one Supermemory org.

Important columns:

- `team_id`: primary key from Slack.
- `org_id`: Supermemory organization id, cascades on org delete.
- `bot_token_enc`: encrypted Slack bot token.
- `bot_user_id`: bot's Slack user id, used to ignore self messages.
- `team_name`: display name from Slack OAuth.
- `installed_by_user_id`: Supermemory user who installed the bot.
- `scopes`: granted Slack scopes.
- `app_id`: Slack app id.

### `slack_workspace_member`

The durable identity link between a Slack workspace member and a Supermemory
organization member is keyed by `(team_id, slack_user_id)`. It stores the
normalized Slack email, Supermemory `user_id`, `org_id`, and active/revoked
status. Rollout provisioning first reuses this stable mapping, then falls back
to a case-insensitive email lookup. Existing users are added to the Company
Brain organization without changing an existing role; new users are created
through Better Auth as verified, passwordless users and added with the regular
`member` role. `provisioned_member_id` references the exact organization-member
row created by this workflow and clears automatically if that row is deleted,
so Slack deactivation never removes pre-existing or manually recreated web
access. Automatic provisioning and explicit web account linking serialize on
the same Slack-identity transaction lock. A relink removes the old
Slack-provisioned regular membership when safe, never transfers provisioning
provenance to the newly confirmed user, and preserves privileged or
independently mapped access. A Slack workspace is bound to one Supermemory
organization; OAuth reinstall may refresh that binding but cannot move the
workspace across organizations. All writes are idempotent.

### KV Keys

`AUTH_KV` is used for stateless route-level coordination:

- `slack:oauth:{state}`: OAuth install state, TTL 600 seconds.
- `slack:evt:{event_id}`: event idempotency, TTL 24 hours.

MCP connection OAuth state is stored in Postgres (`mcp_oauth_state`) instead of KV so the callback can persist PKCE/client metadata and optional Slack continuation context.

### `mcp_connection` and `mcp_oauth_state`

`mcp_connection` stores one connected tool provider per org/user scope. `runtime` is `remote_mcp` or `embedded`; remote rows have a `server_url`, while embedded rows never use a fake URL:

- `org_id`: Supermemory organization id.
- `user_id`: null for org-shared connections, set for personal Slack/member-scoped connections.
- `server_slug`: catalog or custom MCP server slug.
- `server_url`: nullable, remote-MCP-only endpoint.
- `auth_type`: `oauth`, `static`, or `none`.
- `status`: `active`, `pending`, or `error`.
- encrypted access/refresh tokens and metadata such as OAuth client info or static header name.

`mcp_oauth_state` stores transient OAuth state during connect redirects: provider runtime, state token, org/user, server slug, optional remote URL, encrypted PKCE verifier, requested scopes, optional target Google grant, dynamic client info, redirect URL, Slack context, and expiration.

### Durable Object Local SQL

Route-level KV handles Slack event idempotency. `brain_bot_thread` records thread timestamps where the bot should continue answering without being mentioned again, including degraded cases where `conversations.replies` cannot read the thread.

`brain_thread_turn` is the durable coordination record for steering. It stores one current turn pointer per Slack thread key (`teamId:channel:threadTs`), not the full transcript or tool output. A row is `running` while the model/tool loop is active, `waiting_approval` while a consequential action card is waiting on the requester, `finalizing` after the model atomically confirms that no live thread update is pending, `completed` after allowed side effects finish, or terminally stale as `cancelled` / `superseded`. The in-memory abort controller is intentionally separate and best-effort; the SQL row is the correctness guard used before Slack replies, cards, reactions, connect prompts, and memory writes.

`brain_thread_turn_update` is the durable inbox for messages received during an active turn. Rows are keyed by thread and Slack message timestamp and retain the active turn id/revision, author, instruction, gate outcome, and classification/application state. Intake atomically reserves a row as `classifying` before calling the active-turn gate; finalization and approval suspension wait for that reservation to become `ignored` or `pending`. This prevents the turn from completing while Haiku is still judging a message. The model loop drains pending rows in Slack timestamp order before each step. Exact repeated instructions from the same active revision within 30 seconds are recorded as ignored duplicates rather than triggering another model continuation.

The opt-in public-channel rollout has its own local SQL state:

- `brain_public_channel_rollout_card` identifies the single progress/action card in `#company-brain`.
- `brain_public_channel_rollout` stores the current run, frozen seven-day window, actor, phase, Slack cursor, connected-app summary, and retry state.
- `brain_public_channel_rollout_channel`, `_thread`, `_message`, and `_document` persist per-channel stages, thread cursors, normalized Slack messages, and submitted memory documents. This lets every alarm invocation perform one bounded unit and resume after eviction or rate limiting.
- `brain_public_channel_introduction` is the cross-run exactly-once introduction ledger. A stable Slack `client_msg_id` handles an ambiguous retry between posting and recording success.

Transcript rows are deleted after a channel completes. Connected-tool evidence is temporary rollout state and is never ingested into Company Brain as durable truth.

## Slack Member Identity and Account Linking

Company Brain authorizes a Slack person through the stable `(team_id, slack_user_id)` identity in `slack_workspace_member`, not through a mutable email address. Every authenticated action loads this mapping first and then rechecks that the mapped Supermemory user is still an active member of the organization. A stale mapping never grants access.

For an unmapped Slack user, an exact Slack-profile-email match against an existing organization member is a bootstrap convenience only. A successful match is immediately persisted as the stable mapping, so later Slack or Supermemory email changes do not break the account. If there is no exact match, Company Brain explains that the person may either have organization access through another email or need an administrator invitation, then sends a private DM or channel-ephemeral **Verify Supermemory account** action. It never reveals account details in a public message.

The action opens Nova with an opaque, short-lived, single-use token. Only the token hash is stored in `slack_account_link_state`. After the user signs in, Nova shows the Slack and Supermemory identities being connected and requires explicit confirmation. The API consumes the token atomically, verifies that the signed-in Supermemory user is already an active member of the Slack installation's organization, and then creates or explicitly replaces the stable mapping. Linking does not create a Supermemory account, add an organization member, or grant a seat. Expired, used, invalid, non-member, and relink states are shown explicitly, and a successful link is confirmed privately in Slack.

Future automatic member provisioning must reuse `slack_workspace_member` rather than create a second Slack-to-user identity system.

## Public-Channel Rollout

OAuth bootstrap creates or adopts the public `#company-brain` home channel, posts a short multi-message welcome personalized with the installer's Slack display name, and then ensures the channel contains an **Add me to public channels** card. Welcome progress is stored in Durable Object SQL so a failed or repeated bootstrap resumes at the next message instead of replaying completed bubbles. The welcome links **Brain** for app setup and lets teammates know they can request a connection by naming a tool in Slack. The rollout card also explains that teams may invite Supermemory to individual channels themselves. The OAuth grant at install covers reading public channels, so shortly after install the bot also joins a small number of channels on its own (the beachhead below); the full-workspace rollout remains admin-initiated. The home-channel card is a read-only status surface — the button that starts the full rollout lives on the installer's DM copy, because a channel message renders identically for every viewer.

The signed Block Kit interaction is acknowledged immediately, then the org-scoped Durable Object:

1. Resolves the clicker through the stable Slack member mapping, bootstrapping that mapping from an exact email match when possible, and requires the `admin` or `owner` role.
2. Freezes the exact interval from click time minus seven days through click time and refreshes the shared Team Brain capture configuration.
3. Pages through the current public-channel snapshot. It excludes `#company-brain`, `#general`, archived channels, private channels, and externally shared/Slack Connect channels.
4. Joins each eligible channel with `conversations.join`. Channels the bot already belongs to still receive the history backfill.
5. Reads `conversations.history` and every discovered in-window root thread through cursor-aware, persisted pages. A Slack `429` is never slept through inside the Durable Object; the next alarm uses Slack's exact `Retry-After` value.
6. Packs normalized messages into deterministic UTC-day Markdown documents, preserving roots and replies together, exact timestamps, Slack user ids, file names, and compact reaction counts. Message text uses the same shared legacy-attachment normalization as thread prompts and channel search (persisted into the rollout message store before packing), so attachment-only integration posts remain substantive. Bot-self messages, membership/topic system events, and empty noise are removed. Documents are capped and split at thread boundaries.
7. Submits the documents oldest-to-newest to `sm_org_shared` with source `company-brain-slack-history`, stable `customId`s, full-replace semantics, and `dreaming: dynamic`. Raw chunks remain searchable while the existing Company Brain capture policy extracts only durable decisions, ownership, commitments, blockers, constraints, and state changes. Participant ids remain inline but are not applied as document-level person tags.
8. Extracts at most two current themes from recent, channel-local Slack evidence. Every theme must cite an exact captured Slack timestamp.
9. Cross-checks those themes against all relevant organization-shared MCP connections through `orgSharedOnly: true` and `readOnly: true`. Only positively classified read methods are exposed. Personal connections are never loaded for a public post. A check can corroborate, qualify, contradict, find no evidence, be inapplicable, or be unavailable; it cannot introduce a new topic.
10. Polls both document processing and dynamic-memory status. Only after every document for the channel is `done` does it post one charismatic, grounded introduction. If no shared tool evidence was available, the message stays honestly Slack-only. Passive chime-in is suppressed until this first unsolicited message posts.

### Beachhead

Five minutes after install the bot joins the one or two busiest eligible public channels on its own, ranked by member count (`include_num_members`). Sensitive-sounding names (hr, finance, legal, security, compliance, incident, payroll, salary, comp) are hard-blocked, and social channels rank below work channels. The card announces which channels at action time; removal from a channel is respected and the bot stays out. Joined channels get the standard introduction plus a muted note linking the proactivity settings page (admin-only to change). The read-out of channel themes is delivered idempotently to the home channel before the run is marked done, so a failed post is retried rather than silently dropped, and the "add me to the rest" ask rides on the installer's DM card rather than a public button.

One scheduled callback performs one Slack page, join, model call, memory submission, poll, or introduction. Repeated operational failures are bounded and surfaced on the home-channel card. Pressing the completed card again takes a fresh channel snapshot and backfills newly eligible channels without repeating introductions in channels recorded in the ledger. This version intentionally does not subscribe to `channel_created`; beyond the automatic beachhead, discovery is driven from the installer's DM card.

## Team Invite ("Add your team")

Immediately after Slack OAuth, the installer DM announces that every eligible
full workspace member is being added to `#company-brain`, provisioned with a
Supermemory account, and sent a welcome DM. It explicitly says that guests and
external members are excluded. The org Durable Object then starts an automatic,
idempotent rollout. It reads one `users.list` cursor page per scheduled callback,
persists the next cursor and discovered targets in local SQL, and resumes after
eviction or Slack rate limiting. Bots, deleted users, guests, Slack Connect
users, and users whose home team differs from the installed workspace are
excluded while each page is ingested. After account provisioning, the rollout
invites one member at a time to `#company-brain` and then sends the existing
idempotent welcome DM. The DM contains the shared starter questions and
member-scoped Linear and Notion connect actions. Those durable actions resolve
the clicker's stable Slack identity mapping and mint fresh, short-lived OAuth
state only when clicked; welcome messages never persist expiring authorization
URLs.
The installer thread contains one progress card instead of a confirmation or
member picker. It advances through directory discovery, provisioning, and
notification phases, then reports welcomed, already-notified, and failed
counts. Directory, channel-invite, provisioning, and DM work is bounded and
retried from persisted state; Slack `429` responses reschedule with
`Retry-After`, and the stable per-member `client_msg_id` plus the notification
ledger prevents duplicate DMs across retries and reinstall recovery. Reinstall
or reauthorization attaches a fresh progress card to an active rollout, while a
completed rollout starts a fresh directory pass so members missed while the app
was absent are provisioned without repeating earlier welcome DMs.

The automatic rollout is capped at 5,000 discovered members. It composes
starter questions once from the research brief (billed as
`team_invite_starters`) and shares them across every member DM. Legacy
admin-triggered picker and notify-all interactions remain accepted for older
installer cards, but new installations do not render those controls. Automatic
Slack provisioning deliberately does not apply the generic organization member
seat cap: Company Brain is not billed per seat and its contract is to mirror all
eligible full workspace members. Product entitlement is checked before rollout
start and before every provisioning step. Each target is also refreshed with
`users.info` immediately before provisioning so a stale directory page cannot
grant access after a member is deactivated or restricted. Organization-member
creation and Slack-mapping provenance are committed in one transaction;
provisioning retries cannot overwrite a web-confirmed identity, and provenance
always describes the mapping's current Supermemory user.

Bulk rollout and lifecycle onboarding share one atomic notification-ledger
claim per Slack user. A pending claim carries the single stable
`client_msg_id`; either sender may safely resume it, while only a completed
claim deduplicates future outreach. Target-state transitions and run counters
are conditional on the expected run id and target status, so revocation cannot
be overwritten by a late DM completion. Slack profile rate limits propagate
`Retry-After` without consuming bounded failure attempts.

Each active automatic run persists the id of its next Durable Object schedule.
Callbacks reject stale schedule deliveries, and startup or a repeated install
reconciles an active run whose owned schedule is missing. Schedule creation is
bounded and always uses a positive delay compatible with the Agents scheduler;
repeated failures transition the run and its progress card to failed instead of
leaving an indefinitely active rollout. Every owned one-shot callback also has a
top-level recovery boundary: an exception or missing/rebound workspace clears
schedule ownership and terminally fails that bulk run unless a successor was
already persisted. Rollout startup is independent of the installer DM: opening
the DM, composing greeting bubbles, or posting the progress card may fail
without suppressing member enumeration.

Company Brain Durable Object invite and lifecycle entry points run inside one
request database scope, so repeated `db(env)` calls reuse a single Hyperdrive
client for that callback rather than opening a client per member-operation.

`team_join` runs the same eligibility, account provisioning, home-channel
invite, connect actions, and idempotent welcome path for future full
members. A transient failure is transferred to a bounded Durable Object retry
before the Slack event is acknowledged as terminal. Workspace-level lifecycle
enablement is stored separately from the latest bulk run, so a failed or aborted
directory rollout does not disable future `team_join` or `user_change`
synchronization. `user_change` revokes the
mapping and organization membership when Slack marks a mapped user deleted,
restricted, ultra-restricted, or a bot, and restores provisioning and channel
access when a guest is promoted or a deactivated member is reactivated. Access
is restored before the welcome ledger is checked, so an existing notification
suppresses only the duplicate DM. Mapping revocation and organization-membership
cleanup are one transaction, retries can finish older partially revoked rows,
and pre-existing memberships plus admin/owner roles are never removed. If the
same Supermemory user still has another active Slack mapping into that
organization, the organization membership is retained. Exact membership
provenance is resolved across all mappings for that organization and user, so
it remains available on revoked mappings until the last active mapping is
removed, regardless of revocation order. External/Slack Connect
transitions are treated as revocation. Before either granting or revoking
access, lifecycle handling re-fetches `users.info` and treats transient Slack
errors as retryable instead of trusting an old event payload. Revocation also
marks any matching unsent target in the active automatic rollout as skipped so
its queued notifier cannot send a welcome DM. Both events carry a nested `user`
object and are parsed ahead of the generic Slack event envelope.

## Onboarding Journey

After install, an org-scoped timer offers one rung at a time and stops as soon as the workspace stops answering. Rungs, in ladder order: `domain` (a company domain is known), `channels` (the bot has introduced itself somewhere), `second_asker` (more than one person has talked to it), `tool_workspace` (an org-shared connection exists), `digest` (a standing digest or recurring scheduled task exists). State is read live from those sources at send time, never cached, so a disconnected tool revokes its rung immediately.

Each tick picks the lowest ungranted rung, jitters within the workspace's working hours (9-5 local, weekdays), and posts at most one beat per day. Beats are idempotent per rung. The `domain` beat asks in the home channel and is answered through `update_configuration`; `second_asker` posts a theme-grounded example question in a channel the bot already introduced itself in, rather than another home-channel ask; `tool_workspace` and `digest` ask in the home channel and are admin- and mention-driven respectively.

Guardrails: the per-org kill switch (`brainProactivity.journey.enabled`, off by default), a one-beat-per-day gap, and a stop after two unanswered beats. A grant credits the beat that preceded it; a rung that goes from granted back to false is a refusal, which pauses the journey once and permanently skips that rung. An unreadable state source is treated as an outage, never as a refusal. Every beat sent, suppressed, or exited emits a PostHog event tagged with the company group.

## Signup Company Research

Research starts when the organization is created, not when Slack is installed. It needs only a company domain, so for a web-first signup it usually completes before the workspace exists. A free-mail domain yields nothing to research and the run is skipped.

The pass walks a fixed plan of six aspects — overview, products, people, work, competitors, and traction — after a few fast setup beats. The company's homepage is scraped once per run and shared as grounding by every aspect, so one credit replaces six repeat fetches. Each aspect is then one context.dev `web.search`, summarised by the fixed fast model against those results and the homepage excerpt, followed by a fast extraction of stats and highlight chips, and a memory write tagged under `company/<aspect>`. A summariser that cannot answer from the sources returns `NO_INFO` and the aspect is recorded as having no public information, so the pass never invents a finding.

Progress renders in `#company-brain` as a single Slack native `plan` block with one `task_card` per aspect, posted top-level and edited in place. All six aspects are always rendered, merged onto the expected plan rather than only the ones that have started: Slack derives the plan's completion state from its tasks, so a card containing only finished tasks would show a completed header while research was still running. The card is synced when an aspect starts, when it completes, when it fails, and once at the end.

Card identity lives in `brain_research_card`, a single row holding `message_ts`, `channel_id`, `block_id`, `team_id`, and `run_id`. The stored row is reused only when both the workspace and the run match. A reinstall into a different workspace, or a forced rerun, therefore posts a fresh card instead of editing a message that belongs to another workspace or another run. A research reset clears the row outright.

Because signup research runs before the home channel exists, every sync during that pass is a no-op. OAuth bootstrap closes the gap: once the home channel is ensured it calls `syncResearchCardIfDone` to post the finished card retroactively, then `announceResearchIfDone` for the digest. Both are best-effort and cannot fail the install.

The digest that follows is deliberately short: two concrete facts about the company and two questions the brain can already answer from what it read.

## Event Intake

The route accepts Slack URL-verification, generic event-callback, and dedicated
nested-user lifecycle envelope shapes:

- `url_verification`: returns Slack's challenge.
- `event_callback`: validates and dispatches event work.

The bot only considers events from `isAnsweredEvent`:

- `app_mention`,
- direct `message` with `channel_type === "im"`,
- threaded `message`.

Outside one-to-one DMs, direct Slack user mentions are routed before model
triage. A Company Brain mention anywhere in the message, in either `<@ID>` or
`<@ID|label>` form, owns the request and proceeds through the explicit
`app_mention` path. Otherwise, any direct mention of another person or app is
retained as local context only: it cannot start, chime into, or steer a turn.
In a one-to-one DM, the message remains explicitly addressed to Company Brain
and other user mentions are treated as references. With no direct user mention,
the existing DM, thread, name-wake, and proactive routing applies.

Events with a Slack subtype are ignored. The route also ignores unknown envelope shapes and returns `{ok:true}` so Slack does not retry unsupported traffic.

After signature verification, schema parsing, event filtering, idempotency, and workspace lookup, the route dispatches asynchronously:

```ts
c.executionCtx.waitUntil(agent.onSlackEvent(message))
```

The HTTP response to Slack is immediate `{ok:true}`. Slow LLM/tool work happens outside the request lifecycle.

## Turn Orchestration

`CompanyBrainAgent.onSlackEvent` performs local duplicate checking, then calls `runTurn`.

`runTurn` does the operational work:

1. Durably accepts the explicit Slack event with `startFiber`, keyed by Slack `event_id`, before returning from the agent RPC. The fiber supplies keep-alive, cooperative cancellation, and a compact SQLite checkpoint containing the recoverable event, turn/thread identity, delivery message timestamps, and recovery attempt.
2. Reloads the workspace by Slack team id.
3. Ignores events from bots or from the bot's own user id.
4. Allows only app mentions, DMs, or messages in a remembered bot thread.
5. Removes Slack mention tokens from the text.
6. Records the thread timestamp in `brain_bot_thread` after the bot posts or presents an approval card.
7. Decrypts the Slack bot token.
8. Checks `brain_thread_turn` for an active turn in the same Slack thread. Explicit stop/cancel from the original asker remains deterministic. Every other active-turn message, regardless of author, goes through a Haiku semantic gate returning `IGNORE`, `APPEND`, or `REPLACE`; author authority is applied separately after classification as an `ignore`, `queue`, or `restart` action. The gate sees the original task plus all replacement and appended instructions accumulated on the current revision. If the active revision changes during reservation or classification, the stale reservation is discarded and the message is evaluated again against the latest state; only a terminal row may seed a new turn directly. Ignored messages leave the turn untouched, appended messages enter the durable inbox without aborting, and requester-owned replacements preserve the existing supersede/restart behavior. High-confidence correction language such as `actually no`, `not X`, `instead`, and `rather than` cannot be discarded as `IGNORE`, even when written as a short conversational fragment. Additional research dimensions, implications, recommendations, or strategy for the same subject are compatible additions; `REPLACE` is reserved for instructions that explicitly negate, redirect away from, or cannot coexist with the active task. Other participants may append compatible scope but cannot cancel or replace the requester's task; their semantic `REPLACE` verdict is preserved while its runtime action is `queue`, so it is presented to the running agent as an attributed, conflicting follow-up after the original request rather than silently being treated as compatible scope. While waiting for approval, a requester-owned `APPEND` restarts the turn. A teammate's compatible addition stays attributed in the inbox and is reconsidered on approval resume; it never transfers turn ownership or execution credentials to that teammate.
9. For passive channel thread follow-ups (not @mentions, DMs, assistant-tab messages, or steering revisions), runs the configured Triage profile (default `claude-haiku-4.5` at low effort).
10. Triage returns `ANSWER` or `PASS`. `PASS` stops silently — no message, no reaction — with a bounded reason available to best-effort logs and traces; `ANSWER` continues.
11. For `ANSWER`, starts a native Slack stream only in direct/assistant conversations where the stream is not hiding progress from other thread viewers. In channel threads, the bot posts and updates a normal public progress card, then posts the final public reply when the turn completes.
12. Fetches thread context, asker profile, and a team directory.
13. Begins a new turn-control revision and calls `computeTurn` with an `AbortSignal`, turn-control snapshot, and optional steering instruction. `prepareStep` drains attributed inbox updates before every model step.
14. Validates short initial final text once against both the accumulated thread requirements and the latest request. Replies longer than 240 characters are accepted as terminal rather than classified from a truncated sample. If a short reply is progress-only or omits an explicit material requirement, `computeTurn` runs one tool-free replacement-answer attempt from the evidence already gathered. That result is accepted unless the conservative deterministic Slack reply-quality check identifies it as another short progress-only promise.
15. Atomically claims `finalizing` only when the inbox has neither classifying nor pending rows; if an update raced with the final model step, waits for its gate result and continues the model loop when needed before posting. A follow-up that arrives after this claim waits for that exact revision to complete (recovering an orphaned finalizing row after Durable Object eviction) and then re-evaluates the latest thread state, so the generated answer is delivered before the continuation begins. Continuations strip provider reasoning/signature metadata and compact large tool results before starting another model call. Stops the stream or updates/posts a final message fallback only if the turn-control snapshot is still current.
16. Posts connect prompts and writes memory only if the turn is still current, then marks the turn `completed`.

If the Durable Object is interrupted before a reply is checkpointed, `onFiberRecovered` first checks for a durably saved `finish_turn` proposal. When one exists, recovery publishes that exact proposal under the saved revision fence instead of rerunning the model. Without a terminal proposal, recovery supersedes the exact orphaned turn id and revision recorded by the fiber, then retries the original explicit turn once. That revision fence prevents an old fiber from cancelling or completing a newer replacement or continuation. The retry reuses the saved public progress card, labels it `Trying once more`, clears any stale Slack Assistant status, and does not re-add the normal `Dreaming` status. Posting an approval card is checkpointed as a delivered outcome so recovery never replays a turn that is waiting for the asker. A second interruption completes only the checkpointed retry revision, clears any stale Assistant status, and either replaces its progress card or posts a fresh terminal prompt to start over when no card exists.

The bot avoids responding in arbitrary channel thread replies unless it can see the bot in the thread or the thread is already recorded in `brain_bot_thread`.

Every fresh `computeTurn` also loads the nullable admin-managed Workspace Prompt from the organization's Company Brain Durable Object SQLite. The raw stored prompt is limited to 1,500 UTF-16 code units before it is escaped and framed as `<workspace_prompt>` runtime context. This persistent workspace guidance can cover operating preferences, priorities, source and tool selection, workflow conventions, terminology, formatting, and communication style when applicable. It takes precedence over learned interaction style, memories, entity or tag context, and situational defaults, while remaining below fixed system and developer policy, safety, authorization, approval requirements, evidence requirements, available capabilities and tool rules, and the user's explicit current request. The prompt content is treated as untrusted data rather than system instructions.

## Triage

Triage runs before the main turn for **passive channel thread follow-ups** and **top-level channel chime-in**: thread messages in a conversation the bot already joined where the user did not @mention the bot, plus eligible top-level channel messages where proactive chime-in is allowed. Company Brain @mentions, DMs, assistant threads, and other explicit turns proceed directly to the main turn. Outside one-to-one DMs, direct @mentions of anyone else bypass triage and are retained as context without a response.

The routing decision is binary:

- `ANSWER` means Company Brain can add clear, non-obvious value: a useful fact, correction, connection, implication, or next step. It does **not** imply a tool call or a long response. Triage never writes the response; the main turn decides whether to answer directly, search Company Brain memory, use live tools, or investigate more deeply.
- `PASS` means complete Slack silence: no message and no reaction. Use it for redundant or obvious restatements, answers already present in visible context, unsupported or speculative contributions, social chatter, human-directed asks, link-only or ambient FYIs, and low-signal content. Every final pass carries a bounded reason for logs and traces only; the reason is never posted to Slack.

Implementation: `apps/api/src/lib/brain/slack/triage.ts`, using the configured Triage model and effort with separate thread and channel prompts. The default is `claude-haiku-4.5` at low effort. The result contract records both the route and its provenance:

```ts
type TriageDecision = "answer" | "pass"
type TriageDecisionSource =
  | "model"
  | "parse_fallback"
  | "error_fallback"
  | "affirmative_override"

type TriageResult =
  | { decision: "answer"; source: TriageDecisionSource }
  | {
      decision: "pass"
      source: "model" | "parse_fallback" | "error_fallback"
      reason: string
    }
```

### Structured triage grammar

Matching for `ANSWER`, `PASS`, and `Reason:` is ASCII case-insensitive. Reasons preserve the generated text before the existing whitespace normalization and 900-character bound.

- Blank lines and line-edge whitespace are ignored throughout the payload.
- Unfenced `ANSWER` must begin with the standalone token. It may contain at most one `Priority:` field (a missing or invalid priority conservatively normalizes to `normal`), one optional valid `Fallback:` field, and one optional non-empty `Reason:` audit field; the main turn ignores the reason. Token-plus-prose, a preamble, duplicate fields, or other trailing fields are invalid.
- Unfenced `PASS` must be the first non-blank line, by itself. It must be followed by exactly one `Reason:` field with a non-empty normalized value. Unlabeled lines may continue the reason through the end of the payload.
- Continuation prose may contain colon-bearing phrases such as `Owner: Alice already answered` or embedded decision words such as `The previous ANSWER covers this.` A second standalone `Reason:` field is invalid.
- Standalone repeated or mixed `ANSWER`/`PASS` lines after the structural decision are invalid. Legacy tokens are not accepted or aliased.
- One optional Markdown fence may wrap the entire payload. The fence may be unlabeled or labeled `text`, `txt`, `markdown`, or `md`, case-insensitively. It must close, and no non-whitespace text may appear before its opener or after its closer. Nested or unclosed fences are invalid.
- A missing, blank, or whitespace-only pass reason is invalid.

Any grammar violation uses `source: "parse_fallback"`. Empty generated output is categorized as `triage_parse_empty_output`; any other malformed payload is `triage_parse_invalid_structure`.

### Context fallback and affirmative override

Fallbacks remain intentionally asymmetric:

- Thread parse or generation failure returns `ANSWER` so incomplete routing does not suppress a potentially useful continuation.
- Channel parse or generation failure returns `PASS` with a fixed, bounded operational reason, preserving the channel's quiet default.
- Generation/model-dependency failure uses `source: "error_fallback"` and the category `triage_generation_failed`.

Only a valid thread model `PASS` is eligible for the deterministic affirmative override. If Company Brain spoke last, offered an action (for example, “want me to check?”), and the user sends a short affirmative such as “yes,” “sure,” or “go ahead,” the result becomes `ANSWER` with `source: "affirmative_override"`. Parse/error fallbacks and channel passes are never overridden.

### Triage telemetry isolation and raw output

Routing completes before observability is scheduled. When observability context exists, triage schedules a separate best-effort import/capture call through the Company Brain Durable Object's `waitUntil`, so capture does not delay the selected route and can finish after triage returns. An import or capture failure logs only the bounded local category `triage_telemetry_failed` plus safe trace/context identifiers; it never includes prompts, generated output, Slack text, provider errors, or other free-form user content.

Generated-output presence is exact rather than truthy:

- If generation returned text, `rawOutput` is present and capture emits one assistant choice containing that exact string, including `content: ""` for an empty generation.
- If generation failed before text was assigned, `rawOutput` is absent and capture emits `outputChoices: []`; no fallback token is fabricated.
- Parse fallback preserves the exact generated output and records `$ai_is_error: true` with `$ai_error` equal to `triage_parse_empty_output` or `triage_parse_invalid_structure`.
- Generation fallback records `$ai_is_error: true` with `$ai_error: "triage_generation_failed"`.
- Valid model decisions have no triage error. Trace properties include final `triage_result`, `triage_decision_source`, and pass-only `triage_reason`.

The complete bounded error vocabulary is `triage_parse_empty_output`, `triage_parse_invalid_structure`, `triage_generation_failed`, and local-only `triage_telemetry_failed`.

Within a thread Company Brain already participates in, an explicit question, command, or actionable request is treated as directed at Company Brain unless it clearly names another recipient. It does not require another bot mention or an explicit reference to the previous answer, and semantic similarity to an earlier request is not sufficient reason to return `PASS`.

**Affirmative follow-ups:** when Company Brain's last thread message offered an action (e.g. "want me to check the knowledge base?") and the user replies with a short affirmative (`yeah`, `yes`, `sure`, `go ahead`), a valid model `PASS` is promoted to `ANSWER` with `source: "affirmative_override"` — thread-only, not channel chime.

## Post-turn reflect (background agent, phase 1)

After a successful explicit Slack turn completes (not chime/`forceFullTurn`), the org DO arms a delayed job (`runPostTurnReflect`, default **3 minutes**). At most one pending job per thread: a new full turn on that thread cancels the previous schedule. Phase 1 only logs `post-turn-reflect noop` — no model call and no Slack post. Implementation: `lib/brain/turn/post-turn-reflect.ts`.

## Smart chime-in

Smart chime-in lets Company Brain speak **without an `@mention`** when it can add clear value. It is gated by the low-effort Triage profile before any full turn. Beyond the beachhead join described above, the bot does not add itself to channels; elsewhere it only reads and posts where it was invited.

### Goals

- **Thread chime-in**: improve passive follow-ups in threads the bot already joined (extend current triage).
- **Channel chime-in**: listen to top-level messages in channels the bot is a member of; reply in a **thread on that message** (not the main feed).
- **Noise control**: default silent; rate-limit channel chimes; never spam `#general`-scale feeds.
- **Binary decision**: `PASS` (silent, reason logged to trace) or `ANSWER` (full `computeTurn`). Both surfaces share this two-outcome model.

### Thread vs channel

| | Thread chime-in | Channel chime-in |
| --- | --- | --- |
| Trigger | User posts in a thread the bot already joined, no `@mention` | User posts top-level in a channel the bot is a member of, no `@mention`, not a DM |
| Status today | **Implemented** — passive `ANSWER`/`PASS` triage in `runSlackTurn` | **Implemented** — `isChimeInEvent` → `onSlackChimeIn` with cooldown |
| Thread detection | Bot was `@` mentioned in thread, bot spoke before, or bot message in thread | N/A (top-level trigger) |
| Reply placement | Same thread | **New thread** on the triggering message (`thread_ts = message.ts`) |
| Silent outcome | `PASS` — no message, no reaction | `PASS` — no message, no reaction |
| Full tools | On `ANSWER` | On `ANSWER` only (writes still go through approval) |

### Triage outcomes

| Final route | Thread behavior | Channel behavior |
| --- | --- | --- |
| `ANSWER` | Continue the full turn in the existing thread; direct response, memory, and tools remain main-turn choices | Continue the full turn and reply in a new thread on the triggering message |
| `PASS` | No message or reaction; only a valid model pass may enter the affirmative override | No message or reaction; release the reserved cooldown slot and return directly |

### Event intake changes

**Slack app (manual, outside repo):** subscribe to `message.channels` and `message.groups` in addition to existing events. Slack only delivers these when the bot is already a channel member.

**Route (`routes/brain/slack/index.ts`):**

```text
if directly addressed elsewhere → agent.onSlackContextEvent (retain only)
else if isAnsweredEvent(event)   → agent.onSlackEvent (existing explicit turns)
else if isChimeInEvent(event)    → agent.onSlackChimeIn (new)
else                             → ignore
```

**`isChimeInEvent` (`events.ts`):**

- `type === "message"`
- no `thread_ts` (top-level only)
- not DM / not assistant thread
- not bot message (`shouldIgnoreMessage`)
- not `@mention` of bot (mention path owns that)
- allowed subtype only (same rules as today)

Thread chime-in stays on the existing `onSlackEvent` → `runSlackTurn` path (passive thread follow-up block).

Chime dispatch requires a linked workspace (`ws` from DB). The unlinked-workspace `SLACK_BOT_TOKEN` fallback runs for explicit turns only (mention/DM/thread), not channel chime.

### Handler flow

**Thread (`runSlackTurn`, existing path):**

1. Passive thread follow-up detected (unchanged gate).
2. Run `triageChimeMessage({ context: "thread", ... })`.
3. `PASS` → return silently; `ANSWER` → existing stream + `computeTurn`.

**Channel (new `runSlackChimeIn`):**

1. Load workspace + decrypt token.
2. **Cooldown check** (see below) — skip if over limit.
3. Fetch recent channel window (~20 messages) via `conversations.history` for triage context.
4. Run `triageChimeMessage({ context: "channel", ... })`.
5. `PASS` → release cooldown slot and return.
6. `ANSWER` → `createSlackStreamSession` + `computeTurn` with `thread_ts = event.ts`.

### Rate limits and dedupe

**KV (route, existing pattern):**

- `slack:chime:{team_id}:{channel}:{ts}` — per-message dedupe, TTL 24h.

**DO SQL (`brain_chime_budget`, created by `ensureChimeBudgetTables` in `slack/chime-budget.ts`):**

```sql
CREATE TABLE IF NOT EXISTS brain_chime_budget (
  channel_id TEXT PRIMARY KEY,
  hour_bucket INTEGER NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0,
  summons_count INTEGER NOT NULL DEFAULT 0,
  general_count INTEGER NOT NULL DEFAULT 0,
  low_count INTEGER NOT NULL DEFAULT 0,
  last_reply_at INTEGER NOT NULL DEFAULT 0,
  last_normal_reply_at INTEGER NOT NULL DEFAULT 0
);
```

Defaults for **channel** chime-in, per channel per hour, budgeted by priority rather
than one flat cap (`slack/chime-budget.ts`):

- `CHIME_ABSOLUTE_MAX_PER_HOUR` **12** overall, split across
  `CHIME_SUMMONS_MAX_PER_HOUR` **4**, `CHIME_GENERAL_MAX_PER_HOUR` **6**,
  `CHIME_LOW_MAX_PER_HOUR` **2**
- `CHIME_NORMAL_MIN_INTERVAL_MS` **3 minutes** between normal replies;
  `CHIME_LOW_QUIET_INTERVAL_MS` **15 minutes** before a low-priority one
- `evaluateChimeBudget` decides against that state; passive investigations are
  separately bounded (`PASSIVE_INVESTIGATION_MAX_CONCURRENT` 2,
  `PASSIVE_INVESTIGATION_MAX_PER_HOUR` 6, 10-minute lease)

Thread chime-in: no cooldown in v1 (thread audience is small); revisit if noisy.

### Agent surface

Add to `CompanyBrainAgent`:

```ts
async onSlackChimeIn(msg: SlackTurnMessage): Promise<void>
```

Implemented in `agent.impl.ts` → `runSlackChimeIn`. Flush PostHog telemetry same as `onSlackEvent`.

Observability `source`: `slack_chime_thread` | `slack_chime_channel`. Triage events include `chime_context`.

### Implementation phases

| Phase | Scope | Files |
| --- | --- | --- |
| **1** | Thread: passive `ANSWER`/`PASS` triage path | `triage.ts`, `turn.ts`, tests |
| **2** | Channel: event detection + route dispatch + `runSlackChimeIn` | `events.ts`, `index.ts`, `chime.ts`, `agent.ts`, `agent.impl.ts` |
| **3** | Cooldown + dedupe | `chime-cooldown.ts`, route KV key |
| **4** | Observability + spec/diagram sync | `observability.ts`, `architecture.md` |

### Operational defaults

1. **Channel `ANSWER`**: allowed but triage should rarely select it; prefer `PASS`.
2. **Private channels**: include via `message.groups` when bot is invited.
3. **No config UI in v1**: channel policy is implicit (bot must be invited; strict triage).

## Answer Generation

`computeTurn` builds the toolset and calls `streamText` with:

- model and reasoning: the configured Main profile (default `grok-4.5` at high effort),
- system: built by `buildSystemPrompt` / `buildSystemPromptMessages` (`turn/deps.ts`),
- prompt: Slack question, location, thread history, asker identity, team directory, connected MCP catalog context,
- tools: MCP meta-tools plus `search_company_brain`, `save_memory`, `search_mcp_directory`, `connect_app`, `get_configuration`, `update_configuration`, and, on Slack turns, `search_slack_channel`,
- stop condition: max 24 steps,
- output: plain Slack Markdown text; side effects are captured through tools.

Current-thread prompt construction and lazy `read_current_thread` formatting use the shared `SlackThreadMessage` transport type at every boundary. Message content combines top-level text with supported legacy attachment `pretext`, title/link, body text, and footer fields before the existing Slack mention and debug-id normalization runs; uploaded Slack file hints remain additive.

Company Brain search is model-driven during the main tool loop. The backend does not prefetch memories or run a separate usefulness judge before answer generation; instead, the prompt and `search_company_brain` tool description tell the model when to search the brain, when to resolve vague Slack references first, and when to go directly to a live app tool.

`get_configuration` (`lib/brain/configuration.ts`) is a read-only self-introspection tool for "what are you set up to do?" questions. It merges a DO snapshot (home channel, workspace prompt, automations, reminders, observed-channel count) with worker-side reads (org/trial metadata, resolved models, proactivity, company context, interaction style, MCP connections + catalog, Slack workspace status, capability flags). Authorization mirrors the turn: reminders and automations are scoped to the asker unless admin, and the connection listing uses the actor's runtime scope (`personalConnectionsOnly` / `orgSharedOnly`), so automation turns never see personal connections. It never returns tokens, secrets, raw Slack text, or private channel names. The system prompt's mechanics-secrecy rule has a carve-out: everything this tool returns is user-facing workspace configuration and may be shared, including configured model names; fallback chains, orchestration, and credentials remain undisclosable.

`update_configuration` is its write counterpart, assembled from the same factory and omitted entirely for passive investigations, scheduled runs, and read-only actors — a configuration change requires a human asking for it in an interactive turn. It takes one field per call: `company_domain`, `proactivity_default`, `channel_proactivity`, `models`, or `workspace_prompt`. All of them are admin-only, matching the web settings pages; a non-admin is refused and pointed at an admin. `company_domain` is an ordinary mutable setting rather than a write-once one, because a company's domain can genuinely change: install-time bootstrap infers a domain from the Slack team or installer email, and an admin can replace it as often as needed. The write is an unconditional jsonb merge into org metadata, so the last writer wins. Setting it schedules research (owner falls back to the workspace installer) and credits the onboarding journey's domain rung. Scheduling is domain-aware: a queued, running, or finished pass for the *same* domain is left alone and reported as such, while a different domain forces a new run that supersedes any in-flight one, so the tool never claims research started when it did not. Each research aspect is written under a stable per-aspect `customId` (`company-brain-research:<orgId>:<aspect>:epoch<resetEpoch>`), so a rerun replaces the previous findings in place instead of accumulating a second set; the epoch scopes ids to a memory-reset generation exactly as channel-observe and entity ids do. Research documents written before stable ids existed carry hash-derived ids and are not replaced by a rerun. The write paths themselves live in `lib/brain/settings/` and are shared with the `/brain/settings` and `/brain/models` routes, which keep their own validation and role gates.

When a Slack turn is steerable, `computeTurn` also receives an `AbortSignal` and a turn-control snapshot. The signal is passed into model generation and live-update continuations for fast best-effort cancellation. `computeTurn` and the Slack caller both race against that signal, so a dependency that ignores cooperative cancellation cannot hold the turn past the five-minute deadline; the awaited work is abandoned rather than cancelled, and finalization proceeds. Timeout, cancellation, and failure paths emit an idempotent terminal AI trace before propagating the error, so a stalled turn is never silently absent from observability. Individual MCP requests are bounded by the SDK's own 60s per-request timeout, and every MCP HTTP call except the long-lived notification stream carries a 75s fetch timeout that also covers the OAuth discovery and token exchanges the SDK issues without a signal. The snapshot is persisted into pending approval state so old approval buttons cannot resume a superseded turn. If the requester revised an active turn, the prompt includes a `<turn_steering>` block with the latest correction while retaining the original request as the main task.
Compatible messages received while the turn is running do not revise or abort it. They are inserted into the active turn's durable inbox and injected as attributed `<live_thread_updates>` before the next model step. The same inbox is drained when an approved turn resumes. A non-ignored requester update while waiting for approval supersedes the approval-bound revision so approval always applies to the final action arguments.

Interactive model loops expose `finish_turn({ outcome, reply })` as an explicit terminal proposal. The tool does not publish to Slack. The runtime captures valid calls at tool-start time so model-emitted order, rather than concurrent execution completion order, determines the winner; the final valid call wins, its reply supersedes ordinary assistant text from that step, and the loop stops before another model step. A new live-update continuation clears the prior durable proposal before generation so recovery cannot publish a stale draft. Normal Slack turns checkpoint the selected proposal in the managed turn fiber, while approval state carries it across approval suspension. Plain-text replies remain accepted during protocol rollout, while PostHog records protocol adoption, outcome, duplicate terminal calls, and the selected reply source.

The runtime does not call an LLM completion checker or reply rewriter in the delivery path. The shared turn-finalization module deterministically selects the final valid `finish_turn` proposal, otherwise sanitized model text, otherwise the longest publishable assistant draft in the response transcript. If none exists, the caller sends its fixed empty-reply fallback. This selection is identical for initial turns and approval resumes and judges only whether a reply can safely be published, not whether it semantically covers the request. PostHog is the shadow-only semantic quality surface; root traces record `answer_checker_mode=posthog_shadow`, `answer_checker_enforced=false`, and `reply_source`. If an `APPEND` arrives after a draft but before publication, finalization preserves that draft and gathered evidence, adds the attributed update, and asks the main model for one complete replacement answer rather than restarting from scratch. Live-update rebases keep investigative tools available with a bounded 12-step budget.

Finalization uses an idempotent three-state claim: `claimed`, `updates_pending`, or `inactive`. When a live-update reservation resolves to `ignored` between the claim and inbox read, the turn retries the claim instead of failing because there is no pending message to consume. Empty-inbox retries are capped at three; exhausting them produces the bounded `turn_finalization_inbox_inconsistent` failure rather than spinning indefinitely. An `inactive` claim remains a fenced coordination failure and cannot publish a stale answer. The 24-step main-turn limit is unchanged.

The selected `finish_turn.reply` is the Slack reply when the protocol is used; otherwise the runtime falls back to the model's final text during rollout. `save_memory` captures one focused tagged memory document or an array of up to four, while `connect_app` captures a catalog slug or a directory slug when the asker explicitly needs to authorize an app. In an interactive Slack turn, `sandbox_get_artifact` also delivers the generated file into the active thread and returns the Slack file id to the model. The tool may only report `uploaded: true` after Slack completes the external upload; an upload error is surfaced as a tool error so the final reply cannot truthfully claim an attachment was delivered.

In direct/assistant conversations, the agent streams partial reply text to Slack every 48 new characters and streams task cards when tools start and finish. In channel threads, Slack's native stream UI is recipient-scoped, so the agent uses temporary public Block Kit progress cards instead of native streaming. The final answer is posted as a fresh thread reply so it appears after any messages received while the turn was running. After that reply succeeds, the progress card is deleted; if deletion fails, it becomes a completed card with a direct link to the final answer. Public progress cards expose at most eight concrete task rows; additional work is grouped under the generic `Continuing research` overflow row.

The model may also post sparse public narration during long tool-using channel turns. Default is silence: most turns should send zero or one narration message, and the three-message cap is a ceiling, not a target. Adjacent lookup/setup work should be summarized as one high-level update, not narrated source-by-source; later updates are reserved for material shifts or noticeable delays. Narration must not claim a Connect button exists; missing app access should use the `connect_app` capture flow so Slack can post the private button, with a concrete limitation if that flow cannot run.

The model may also post sparse public narration during long tool-using channel turns. Default is silence: most turns should send zero or one narration message, and the three-message cap is a ceiling, not a target. Adjacent lookup/setup work should be summarized as one high-level update, not narrated source-by-source; later updates are reserved for material shifts or noticeable delays. Narration must not claim a Connect button exists; missing app access should use the `connect_app` capture flow so Slack can post the private button, with a concrete limitation if that flow cannot run.

## Company Brain Search

`search_company_brain` is an AI SDK tool assembled for normal turns and, when needed, approval resumes. It is intentionally described as a company-knowledge tool, not a live-data tool. The model writes the search query itself from the current request, thread context, and any Slack channel lookup it performs to resolve unclear references. Queries should be clear natural-language questions or specific search statements with resolved subjects and time windows when known, not keyword fragments.

Implementation details:

- Builds a fake Hono context with org and user via `makeSlackSearchContext`.
- Resolves `VectorDBService` through `makeAppLayer`.
- Calls `searchMemoryEntries`.
- Always searches `SHARED_TEAM_BRAIN_CONTAINER_TAG`.
- Also searches the current scoped Slack memory container when present:
  - DMs: the mapped Supermemory member's private `My Brain` tag, `user_{userId}`.
  - Private channels / group DMs: `slack_channel_{channelId}`.
- Scheduled runs preserve the Slack memory scope captured when the reminder was created, so reminders from DMs/private channels can search the same scoped memory.
- Uses hybrid search.
- Limit is 12 per container.
- Threshold is `0.3`.
- Rerank, aggregation, query rewrite, documents, summaries, and related memories are disabled.
- Dedupe is by result id; the highest similarity result wins.
- Final raw response is top 12 sorted by similarity; the formatted model-visible tool result is capped at 10 memories.

The formatted tool result gives the model numbered source chunks/memories and optional file paths.

For time-sensitive answers, brain results are treated as internal memory rather than proof of the live current state. If a needed live app, Slack, or web lookup fails, the final answer should say that lookup failed and frame brain results as partial or historical context instead of confidently presenting them as "latest" or "past few days" evidence.

## Web Tools

Two tools cover the public web, both backed by [context.dev](https://context.dev) through its official SDK. They are ordinary HTTP calls rather than model calls, so they carry no token cost, but their per-request vendor spend is metered per org on the same `BrainCostLedger` as model cost — see [Vendor spend](#vendor-spend-non-llm-apis).

They are unavailable, with a startup warning, when `CONTEXT_DEV_API_KEY` is unset.

### `search_web`

Query in, ranked results out. The model writes the query itself and may use search operators — `site:`, `-site:`, `inurl:`, `intitle:`, quoted phrases, and `OR` — which pass through to the provider unchanged. An optional `freshness` parameter (`last_24_hours` / `last_week` / `last_month` / `last_year`) restricts results by publish date and is preferred over writing dates into the query text.

- 15s timeout per attempt.
- Requests 10 results (the API's minimum) and returns the top 5. Ten results cost the same one credit as five, so the trim is for the model's context, not for spend: five results of title, URL, and snippet is roughly 330 tokens.
- Each result carries a `high` / `medium` / `low` relevance label.
- No results returns a plain sentence telling the model to reword or drop any `site:` filter, rather than an error.

### `web_extract`

Reads pages the model already has URLs for. Use it when someone shares a link or when a search snippet is not enough. Handles PDFs, and YouTube URLs return the video's transcript when captions exist.

- Up to 5 URLs per call, fetched in parallel; wall time tracks the slowest page, not the count.
- 30s timeout per page. A page that fails is reported in place and the rest of the batch still returns.
- Not for private or logged-in pages, and not for our own Slack, GitHub, Notion, or Linear — those go through their connected app tools.

**Budgets.** Each page is capped at 25,000 characters and one call at 50,000. When a batch exceeds the call budget the ceiling is lowered until it fits, so only the largest pages are trimmed and small ones survive whole. A trimmed page keeps its head and tail (60/40) with the omitted middle labelled inline, because docs and pricing pages bury the answer at the bottom. The 25,000 figure comes from measuring real pages: the median is around 16,600 characters, so it returns most pages intact.

### Rate limits and retries

The provider enforces a per-minute request cap per API key. `web_extract` spends one request per URL, so a 5-URL call costs five.

- Every response's `X-RateLimit-*` headers are logged as `context_quota tool=… remaining=N/M`, escalating to a `LOW` warning below 20% headroom. This is the signal for whether the current plan tier is sized correctly.
- A 429 is retried on an Effect `Schedule` that waits the longer of a jittered exponential backoff and the provider's `Retry-After`, bounded to a 30s total retry window. In practice that is one retry, so a rate-limited call settles in roughly 30s rather than failing instantly or hanging.
- Rate limiting is detected by HTTP status, not `instanceof`, so it survives Effect's `FiberFailure` wrapper and any duplicate copy of the SDK's error classes. Failures are rethrown via `Cause.squash` so callers still see the provider's own error.
- On exhaustion the tool tells the model it is rate limited and that retrying will not help, so it answers from what it has instead of burning more quota rephrasing.

The SDK's own `maxRetries` is set to `0` deliberately: it defaults to 2 and retries timeouts, which would silently turn a 15s bound into 45s.

## Reminder Scheduling

Reminder permissions are action-specific. The creator can list full details, cancel, and replace a reminder. A direct target or primary participant stored in `relatedSlackUserIds` receives only the id, label, creator, and next-run metadata needed to identify the reminder and may cancel it, but cannot inspect its instruction or destination, replace it, or take ownership. Replacement preserves the original creator identity and future delivery credentials. Omitting a replacement destination preserves the stored destination; explicitly selecting origin or personal DM rebinds the complete channel, thread, and memory-scope tuple so stale fields cannot survive the move. Manual reminders default to the originating Slack channel/thread. They move to another channel only when the asker explicitly selects it; `deliverTo: "channel"` without a named channel safely remains at the origin. Personal DM delivery goes only to the asker and must also be explicitly selected.

## Slack Channel Lookup

`search_slack_channel` is available on Slack turns when the bot has channel context. It uses `conversations.history` and capped `conversations.replies` thread expansion — no `search:read` scope. Channel formatting normalizes the same supported legacy attachment content with top-level message text, so attachment-only posts participate in summaries, related-message and cross-channel matching, thread snippets, and `find_link` context and URL extraction.

Intents:

- `summarize_window`: recent channel activity in a time window (`today`, `yesterday`, `last_24_hours`, `last_7_days`).
- `find_related`: messages matching a topic query, with thread snippets for top matches.
- `extract_open_actions`: likely open vs likely done items inferred from message wording (Slack has no task state).

The model should describe action status as inferred, not guaranteed.

## Memory Write-Back

The prompt asks the model to call `save_memory` only for durable, future-useful facts:

- decisions,
- commitments,
- status changes,
- ownership facts,
- resolved canonical answers,
- constraints.

The `save_memory` tool accepts one memory object or an array of up to four memory objects. Each memory object is intentionally focused around one coherent tag set; the model should split unrelated people, projects, customers, teams, or recurring topics into separate memory documents instead of writing one large summary, but only when each split memory is independently useful. Bare entity stubs, name/domain mappings, tag labels, or other identifying details are metadata for a substantive finding rather than memories on their own.

`writeMemories` stores each memory through `addMemorySingle` with:

- source: `company-brain`,
- container tag selected by Slack scope:
  - public channels: `SHARED_TEAM_BRAIN_CONTAINER_TAG`,
  - DMs: the mapped Supermemory member's private `My Brain` tag, `user_{userId}`,
  - private channels / group DMs: `slack_channel_{channelId}`,
- metadata: `sm_source=company-brain`, `source_type=company-brain-slack`, `sm_internal_event_from=slack`, UTC `ingestion_date`, `memory_scope`, Slack channel id/type, normalized `memory_key`, title, sources, `brain_tags`, and `brain_tag_labels`,
- custom id: `company-brain-slack:{YYYY-MM-DD}:{sha256(memory_key:raw_key)}` where `raw_key` includes title, tag keys, and content, so focused same-day documents with the same title but different tag/content do not overwrite one another.

Company Brain maintains a lightweight Durable Object tag registry in `brain_memory_tag`, keyed by `(container_tag, key)`. Confirmed `queued`/`done` tagged writes upsert each tag's stable `key`, human label, kind, description, and usage counters under the memory's container tag; skipped, quota-failed, or invalid writes do not register tags. The prompt injects the registry as `<available_memory_tags>` so the model can reuse existing tags, but public turns see only shared-container tags while private-channel/DM turns see shared tags plus the current private container's tags. Teammate tags use stable Slack ids (`person_{slackUserId}`), while durable non-person tags use prefixes like `topic_`, `project_`, `customer_`, and `team_`. Slack-agent writeback rejects untagged memory objects because tag-based recall cannot reliably inject them later, and drops person tags not backed by trusted Slack ids from the sender, mentions, or thread context.

Recall mimics the old bucket flow without putting one bucket per workspace member into `space.profileBuckets`. At the start of a Slack turn, `buildBrainProfileContext` chooses stable person tags from the sender and @mentioned Slack ids plus relevant topic/project/customer/team tags from the scoped registry and current query. It then reads latest, non-forgotten memories from the shared container and current private-channel container by filtering `memory_entry.metadata->brain_tags`. Personal DM profile buckets remain separate and are injected only when the sender has opted into personal-to-shared sharing. If the Durable Object tag registry is reset, existing tagged memories remain in Postgres, but topic recall degrades until tags are re-learned from future writes; a Postgres-backed registry rebuild can be added later if this becomes operationally important.

If a DM or private-channel sender cannot be mapped to an active Supermemory organization member through the stable Slack identity mapping (including the exact-email bootstrap), memory write-back is skipped rather than writing private content to a shared, installer-owned, or otherwise mismatched space. Quota and document errors are caught and logged or sent to Sentry without counting the memory as written.

## Skills

Company Brain exposes visible skills through an `<available_skills>` runtime index containing their names and routing descriptions. The model calls `load_skill` with an exact name only when a listed skill is relevant, and the tool returns the full Markdown body. Personal and organization skills are stored in the organization Durable Object; a viewer's personal skill wins when it shares a normalized name with an organization skill.

Code-owned system skills live under `apps/api/src/lib/brain/skills/system/`. They use the same runtime index and `load_skill` interface as stored skills, but they have no database row, owner, editing route, or usage-counter write. System skills win normalized-name collisions so the body loaded for an indexed system name cannot be shadowed by stored content. A pre-existing stored skill with the same name remains persisted and editable but is hidden from the runtime index until its owner renames it; frontend visibility and reserved-name handling are deferred. The built-in `Supermemory Docs` skill routes public questions about Supermemory products and capabilities to current official documentation through `search_web`; its complete body is loaded only on relevant turns.

## MCP Tool Integration

MCP integration lives under `apps/api/src/lib/brain/tools/mcp/`.

`assembleTurnTools` calls `createMcpRuntimeTools` for the current actor. Slack turns set `personalConnectionsOnly: true`, so only the asker's personal MCP connections are available; org-shared connections are not used for Slack actions.

Per turn, the runtime:

1. Loads active MCP connections visible to the actor from `mcp_connection`.
2. Deduplicates by server slug, preferring a personal connection over an org-shared one.
3. Opens a generic provider handle. Remote MCP providers use Streamable HTTP with OAuth refresh/write-back or static auth headers; embedded providers dispatch first-party API tools in-process without speaking MCP.
4. Lists provider tools and indexes them as `{serverSlug}.{toolName}` ids.
5. Exposes three AI SDK tools:
   - `mcp_search_tools`: search the connected tool index by task.
   - `mcp_describe_tool`: fetch the selected MCP tool's schema.
   - `mcp_execute_tool`: execute the selected tool with arguments.

Write-like MCP tools are gated by AI SDK approval. The approval decision is based on MCP `destructiveHint` plus write verbs in the tool name (`send`, `create`, `update`, `delete`, `post`, `invite`, `schedule`, etc.). The model still has to search and describe tools before execution; no per-app routing is hardcoded.

### Embedded Gmail provider

Gmail is an embedded Company Brain provider, not an MCP protocol server. It keeps the MCP-style catalog/search/describe/execute UX and policy surface, but calls the Gmail REST API directly. Gmail is personal-only and non-leaseable; shared connections, static auth, org fallback, and temporary leased execution are rejected.

The dedicated Google Cloud project must enable the Gmail API and register `${BETTER_AUTH_URL}/brain/mcp-connections/callback`. Staging and production provision only `COMPANY_BRAIN_GOOGLE_WORKSPACE_CLIENT_ID` and `COMPANY_BRAIN_GOOGLE_WORKSPACE_CLIENT_SECRET` for this flow. It must never use ingestion `GOOGLE_CLIENT_ID/SECRET` or login `AUTH_GOOGLE_*` credentials.

Consent currently requests exact identity and `gmail.readonly` scopes with PKCE and an explicit consent prompt. Gmail sending is paused until Google's `gmail.send` approval is complete, so new and reconnect consent requests explicitly remove that scope even when an older grant contains it. The flow also deliberately excludes the incompatible `gmail.metadata` scope because Gmail rejects query-based message search when that scope is present, even alongside broader scopes. The callback atomically deletes valid state before exchange, verifies Google `sub` and email, and stores encrypted tokens in one canonical `google_workspace_grant` deduped by user/sub/client. Gmail bindings reference that user-scoped grant and contain no token copy, allowing the same authorization to back provider bindings in multiple Supermemory organizations. Reconnects target the existing grant and reject a different Google identity without poisoning it. Refresh uses a short CAS claim/version; losers reload the winner and omitted rotated refresh tokens preserve the stored token. `invalid_grant` marks the grant and all bindings reconnect-required. Disconnect deletes only the selected provider binding; it best-effort revokes Google consent and deletes the grant only after the final binding is removed. Organization deletion follows the same reference-aware rule, while user deletion revokes every grant owned by that user.

The currently advertised tools are the read-only `gmail.search_messages`, `gmail.get_message`, and `gmail.get_thread`. Reads use bounded responses and may retry one transient 429/5xx failure. Message and thread reads decode inline MIME bodies and fetch externally stored text/HTML bodies up to the configured safety limit; long threads retain the newest 100 messages in chronological order. The approval-gated `gmail.send_email` implementation remains dormant: it is excluded from discovery and rejected at execution until the send capability and OAuth scope are re-enabled after approval. When enabled, it accepts exactly one plain-text or HTML body, validates To/Cc recipients and MIME constraints before approval, and calls Gmail only after the Slack requester approves a card showing the recipients, subject, and bounded body preview. Bcc is not supported because hidden recipients cannot be safely verified in the shared Slack approval card.

The user prompt includes `<mcp_catalog>` with connectable catalog apps from `apps/api/src/lib/brain/tools/mcp/catalog.ts`, marking slugs that are already connected. Beyond the catalog, `search_mcp_directory` searches the wider MCP directory in `apps/api/src/lib/brain/tools/mcp/directory.json`, served to the connectors UI at `GET /brain/mcp-connections/directory` so both read one source. It returns the top matches with `totalMatches` and `truncated`, so a capped result is never read as the complete set. Entries needing a preregistered OAuth client are withheld from the agent unless the catalog carries credentials for them, since connecting those by URL always fails. If the model returns `connect` for a catalog or directory slug, Slack posts the MCP connect button. If an app is already connected, the prompt tells the model to use MCP discovery instead of asking to connect again.

Staff users with `@supermemory.com` email addresses can add custom OAuth MCP server URLs from the Company Brain connections UI. Custom servers are personal-only in v1, reuse the generic OAuth/DCR storage path, and are still enforced server-side in `brain/mcp-connections`: non-staff users cannot start custom connects, custom shared connects are rejected, and catalog slugs cannot be repointed to arbitrary URLs. Custom URLs must use public hosts (and HTTPS outside development); the connect, callback, and runtime transport paths use the same guarded fetch so discovered OAuth endpoints cannot redirect token/registration traffic to localhost, private IPs, link-local, metadata service hosts, or IPv4-mapped IPv6 private addresses.

Progress labels infer an app from MCP tool ids and use catalog display names when available. Unknown apps fall back to slug formatting rather than a hardcoded app alias list.

## App Connect Flow

1. The main turn calls `connect_app` with `linear`, another catalog MCP slug, or a directory slug from `search_mcp_directory` when authorization is required. Directory apps we can authorize follow the same OAuth path; those needing the requester's own API key return a `/configure?mcpSetup=<slug>` link that opens the prefilled setup form, because only they can enter that key. Directory connections are personal-only, like custom URLs.
2. `runSlackTurn` calls `startMcpConnect`, storing transient OAuth state in `mcp_oauth_state` with Slack context (`teamId`, channel, thread, Slack user id, and the triggering prompt).
3. Slack posts an ephemeral connect button from `postSlackMcpConnectButton`.
4. OAuth completes at `GET /brain/mcp-connections/callback?state=...`. The callback exchanges tokens, writes/updates `mcp_connection`, deletes the OAuth state, and returns an HTML success page.
5. If Slack context was present, the callback `waitUntil`s `agent.onSlackConnectComplete`.
6. `runSlackConnectComplete` posts a short connected message. If the triggering prompt or prior same-user thread message contains a real task beyond app connection, it starts a forced Slack turn with `obsSource: "slack_connect_retry"` so the task continues with the newly connected MCP tools. Connect-only prompts such as "connect Plain" stop after the connected acknowledgement.
7. If that retry reaches a consequential action, normal approval suspension persists the pending approval and posts Approve/Deny buttons in the original thread.

### Slack app configuration

- **Interactivity & shortcuts -> Request URL:** `{API}/brain/slack/interactions`
- **Event subscriptions:** automatic lifecycle sync requires the `team_join` and `user_change` bot events (`users:read` is already granted; this is a dashboard-only change).
- MCP OAuth redirect uses `{API}/brain/mcp-connections/callback`.

### GitHub OAuth app (catalog, no DCR)

Most catalog servers self-register via dynamic client registration (DCR). GitHub does not support DCR, so its catalog entry uses a pre-registered OAuth app whose client id/secret we supply. The `github` entry in `catalog.ts` sets `preregisteredClientEnv`; `getPreregisteredClient` reads those env vars and `oauth-provider.ts` returns them from `clientInformation()`, short-circuiting DCR. If the secrets are absent, GitHub simply cannot be connected (no crash).

One-time registration per deploy environment:

1. Create an OAuth app at **GitHub -> Settings -> Developer settings -> OAuth Apps -> New OAuth App** (org-owned if org repos need access).
2. **Authorization callback URL** must match the API's public origin exactly: `${BETTER_AUTH_URL}/brain/mcp-connections/callback`. The connect + callback routes both derive the `redirect_uri` from `BETTER_AUTH_URL` via `publicApiOrigin`, not the raw request host (behind portless/tunnels the request host is internal `127.0.0.1`, which GitHub would reject with `redirect_uri` not associated). GitHub matches host exactly.
3. Homepage URL can be the Supermemory app URL; app name is user-facing on the consent screen (e.g. "Supermemory Company Brain").
4. Generate a client secret, then set both secrets on the API worker:
   - `COMPANY_BRAIN_GITHUB_MCP_CLIENT_ID`
   - `COMPANY_BRAIN_GITHUB_MCP_CLIENT_SECRET`

   Named distinctly from `GITHUB_CLIENT_ID/SECRET` and `AUTH_GITHUB_ID/SECRET`, which are unrelated (login + other GitHub usage).
5. Declare both names in `wrangler.jsonc` `secrets.required`. Wrangler only surfaces **declared** secrets into the worker env, so an undeclared secret stays `undefined` at runtime even when it is present in `.dev.vars`/`.env`.
6. If the org enforces OAuth App access restrictions, an org owner must approve the app before members' tokens can see org-private repos.

Scope is fixed on the authorize URL via the entry's `oauthScope` (`repo read:org read:user`); it applies to every user, and `repo` is read+write across all repos the user can access (OAuth apps have no per-repo scoping). Endpoints are still resolved from GitHub's advertised authorization-server metadata (`/.well-known/oauth-authorization-server/login/oauth`); only registration is skipped. If the pre-registered creds are absent the connect route returns a clean 501 rather than attempting DCR.

## Consequential Action Approval

Before running write/send/delete/trigger MCP tools, the turn suspends and posts an Approve/Deny Block Kit card in the thread.

1. `computeTurn` detects `tool-approval-request` parts from the AI SDK for `mcp_execute_tool`.
2. The approval card summarizes the target and content. Message-sending actions include recipient fields such as `To`, `Cc`, `Bcc`, and `Subject` when the tool input exposes them, so the requester can verify the destination before approving. Gmail draft-send approvals that only carry an opaque draft id reuse the prior draft-create arguments in the same turn so the card still shows recipients, subject, and body instead of only the backend id.
3. Turn state is persisted in the Durable Object table `brain_pending_approval`, the current `brain_thread_turn` row moves to `waiting_approval`, and the HTTP response ends without a final reply.
4. Only the original asker's Slack user id can approve or deny (`brain_approval_approve` / `brain_approval_deny` buttons).
5. On approve/deny, `POST /brain/slack/interactions` routes to `onApprovalDecision` -> `resumeTurnAfterApproval`, which first verifies the saved turn-control snapshot is still current, injects `tool-approval-response` messages, rebuilds MCP runtime tools, and continues the turn.
6. After an approved action runs, the final Slack reply confirms the outcome in user-facing terms, including the recipient, destination, or record when available (for example, "Calendar invite sent" or "Sent to Alex").
7. Multiple consequential tools in one step batch into a single card; one decision answers every approval id in the batch.

Pending approvals expire after 15 minutes. If a Slack follow-up cancels or supersedes a turn while an approval is pending, old approval cards resolve as `Cancelled` and do not run tools.

Approval UI is rendered as a compact decision brief rather than an undifferentiated text card. The container header names the exact operation or connected app, the body labels the intended effect, and a compact context line identifies the requester, expiry, and exact-action guardrail. Primary buttons use explicit verbs (`Approve action` or `Grant temporary access`). Completed approvals collapse into a small audit record; an active connection lease remains expanded while its `Revoke access` action is available. Connected-app icons are used when the catalog can resolve one.

Code Mode's connector contract marks approval statically per exposed method. Methods proven read-only from trusted annotations or deterministic verbs (`list`, `get`, `search`, etc.) execute without pausing. Known writes and ambiguous methods on writable connections remain approval-gated; non-read operations on read-only connections reach the policy check and are denied rather than presenting an unusable approval card.

## Slack Web API Usage

The bot uses Slack Web API methods for both UX and context:

- `chat.postMessage`: fallback/final response.
- `chat.update`: update fallback placeholder.
- `chat.startStream`: start streaming response in direct/assistant conversations only.
- `chat.appendStream`: stream plan updates, tool cards, and Markdown text.
- `chat.stopStream`: close streaming response.
- `chat.postMessage` / `chat.update`: post and update public channel progress cards where native streaming would be recipient-scoped.
- `reactions.add` / `reactions.remove`: `ack` while a full turn is processing, with `white_check_mark` fallback when a workspace lacks custom `:ack:`, swap to `brain` when done.
- `conversations.replies`: fetch thread context.
- `conversations.history`: fetch recent channel messages for `search_slack_channel` (time-window summaries, related mentions, likely open actions).
- `conversations.info`: resolve channel privacy for Slack memory scoping; requires `channels:read` / `groups:read` on new installs, with fail-closed scoped behavior if lookup is unavailable.
- `files.getUploadURLExternal`: request a one-time URL for a generated sandbox artifact.
- the returned external upload URL: stream the artifact bytes directly from Daytona without public object storage.
- `files.completeUploadExternal`: publish the uploaded artifact in the active Slack thread.
- `users.info`: identify the asker.
- `users.list`: build a small team directory for name-to-email resolution.
- `oauth.v2.access`: exchange Slack install code.

Markdown generated by the model is delivered via Slack's **markdown block** or **`markdown_text` stream chunks**. The model may use full Slack markdown: **bold**, lists, tables, headers, code blocks, task lists, etc. Interactive Block Kit UI (approvals and connect prompts) uses mrkdwn in section blocks separately.

## Error Handling And Idempotency

The system has several defensive layers:

- Invalid Slack signatures return `401`.
- Generated artifact uploads are abort-aware and recheck the durable turn revision immediately before `files.completeUploadExternal`, so a cancelled or superseded turn cannot publish a stale file. Concurrent retrievals of the same path share one in-flight upload.
- Invalid JSON returns `400`.
- Unsupported Slack envelopes return `{ok:true}`.
- Unanswerable event types return `{ok:true}`.
- Route-level event duplicate keys live for 24 hours.
- Slack retries are ignored when KV is unavailable.
- The Durable Object also stores processed event ids.
- Missing Slack workspace rows cause events to be dropped with `{ok:true}`.
- `runTurn` catches and logs errors from the agent entrypoint.
- Slack stream operations log warnings instead of failing the whole turn where possible.
- If streaming is unavailable, the bot posts a `Dreaming...` placeholder and later updates it.
- Every Company Brain model call goes through the dedicated Company Brain AI Gateway with an ordered two-candidate fallback per request: the resolved primary, then Claude Sonnet 5 (GPT-5.6 for Anthropic primaries). Provider credentials are stored in the gateway (BYOK / unified billing); a missing gateway configuration fails the call loudly and reports to Sentry rather than degrading silently.
- If a main or approval-resume result has no publishable terminal proposal or model text, finalization recovers the longest publishable assistant draft from the response transcript without another model call.
- If deterministic selection still produces no reply, the agent sends a fixed fallback apology.
- MCP connection failures degrade to no app tools instead of failing the whole answer.
- Steering cancellation is cooperative: model/tool abort is best-effort, and stale `brain_thread_turn` checks are the durable guard against late replies, reactions, approval cards, prompts, or memory writes.
- Memory write failures are captured and do not block the Slack response.

## Observability

The worker is wrapped with Sentry in `apps/api/worker.ts`, and Company Brain emits PostHog AI observability for main turns, tool spans, and `company_brain_triage` generations. Triage capture uses the same trace id handed to an admitted main turn and records final `triage_result`, `triage_decision_source`, pass-only bounded `triage_reason`, source/context fields, model/provider, latency, prompt, and context size.

Triage telemetry is strictly best-effort and is scheduled through the Company Brain Durable Object's `waitUntil` only after routing is fixed. It does not delay returning the selected `ANSWER` or `PASS`. Capture/import failure produces no replacement span and only a safe local `triage_telemetry_failed` warning. Parse and generation failures use only the bounded `$ai_error` categories documented in [Triage](#triage), never raw provider errors, prompts, Slack text, or generated output.

Failed main-turn traces retain the bounded terminal `$ai_error` vocabulary and also record `failure_phase` plus `failure_code`. These fields identify stages such as `turn_finalization` and known coordination outcomes without recording raw provider messages or Slack content. Root traces record `reply_source`, terminal-protocol adoption and outcomes, and the shadow-only checker state. Semantic answer-quality evaluations remain in PostHog and do not gate delivery.

Agent and Slack helper failures otherwise use console logging/warnings, with memory-write exceptions captured through `captureException`.

### Gateway Health Endpoint

`GET /internal/brain/gateway-health` (internal-secret protected via `x-observatory-internal-secret`, auth-passthrough) probes the primary and fallback models separately through the Company Brain AI Gateway; `?deep=1` adds a deliberately dead-primary pair probe proving the gateway advances to the fallback step. Results are `ok`/`degraded`/`down` (degraded = exactly one candidate healthy) mapped to HTTP 200/200/503, cached in KV for 60 seconds (`?fresh=1` bypasses), and never billed to an organization. Each failing probe reports to Sentry with a stable fingerprint (`brain-health-primary-failed`, `brain-health-fallback-failed`, `brain-health-pair-failed`, `brain-health-all-failed`, `company-brain-gateway-missing`). The Observatory "Company Brain" tab renders this endpoint.

## Per-org Model And Reasoning Configuration

`GET /brain/models/` returns `resolved`, `defaults`, and `choices` for two independent roles. Organization admins update any subset through `PATCH /brain/models/`; overrides are stored in `organization.metadata.brainModels`, and `null` removes an override. The route locks the organization row and replaces only the `brainModels` metadata subtree so concurrent writes to unrelated metadata keys are preserved.

| Role | Model key | Effort key | Default effort | Runtime consumers |
| --- | --- | --- | --- | --- |
| Main | `main` | `mainEffort` | `high` | Normal Slack turns, approval resumes, and continuations |
| Triage | `triage` | `triageEffort` | `low` | Passive thread routing, channel chime routing, and connected-app native-call approval classification |

Every effort field accepts `low`, `medium`, `high`, or `xhigh`; main effort may also be `auto`. Passive triage recommends an `AgentMainEffort`, which `computeTurn` uses for `auto`; turns without a recommendation use the default `high`. The recommendation is based on expected work rather than urgency or response length: `low` is a direct answer requiring no tools or meaningful ambiguity, `medium` is one clearly scoped retrieval or check, `high` is dependent multi-step or multi-source work requiring substantial synthesis, and `xhigh` is reserved for exceptionally broad, ambiguous, consequential investigations with many interdependent checks or repeated hypothesis testing. Triage selects the lowest sufficient level; an ordinary urgent request does not become `xhigh` solely because it is urgent. Anthropic receives adaptive thinking and maps `xhigh` to its native `max` value. OpenAI receives `xhigh` unchanged. xAI receives its reasoning-effort provider option with `xhigh` bounded to `high`. Google receives no reasoning provider option. The stored value remains `xhigh` even when a provider translates or bounds it, so switching the role to another provider does not discard the administrator's selection.

The final-answer fallback is deliberately not an independent per-org role. It is derived from the resolved Main provider and always crosses the provider boundary: Claude Sonnet 5 for xAI, OpenAI, and Google primaries; GPT-5.6 for Anthropic primaries. It uses medium reasoning effort. The same provider-crossing pair also forms the gateway's per-request candidate list.

Signup company research is not a per-org role: its lookups are context.dev calls, summarised by the fixed fast model. Model and effort resolution happens from the freshly loaded organization metadata at the start of each turn, resumed turn, triage call, connected-app tool assembly, or research job, so a saved setting applies to subsequent work without a process restart.

## Configuration And Secrets

Required for the Slack bot path:

- `SLACK_SIGNING_SECRET`
- `SLACK_CLIENT_ID`
- `SLACK_CLIENT_SECRET`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `AUTH_KV`
- `HYPERDRIVE` or database access through `db(env)`
- `COMPANY_BRAIN_AGENT`
- `COMPANY_BRAIN_AI_GATEWAY_NAME` and `COMPANY_BRAIN_AI_GATEWAY_TOKEN`: dedicated AI Gateway that every Company Brain model call routes through; provider keys live in the gateway, not in worker secrets.
- `COMPANY_BRAIN_GOOGLE_WORKSPACE_CLIENT_ID` and `COMPANY_BRAIN_GOOGLE_WORKSPACE_CLIENT_SECRET` for embedded Gmail in staging/production; these belong to the dedicated Company Brain Google Workspace OAuth client.

Optional:

- Sentry/AI/model provider keys used by the broader API runtime.
- `COMPANY_BRAIN_GITHUB_MCP_CLIENT_ID` / `COMPANY_BRAIN_GITHUB_MCP_CLIENT_SECRET`: GitHub catalog OAuth app (see [GitHub OAuth app](#github-oauth-app-catalog-no-dcr)); absent means GitHub can't be connected.
- `CONTEXT_DEV_API_KEY`: context.dev key for [`search_web` and `web_extract`](#web-tools); absent means both tools are omitted from the turn's toolset.

## Design Implications

- The bot is org-scoped for the Durable Object and Slack workspace install, but MCP app connections on Slack are **member-scoped** (`orgId:userId`).
- Slack install must be initiated by an authenticated Supermemory org user; event handling does not require app session cookies.
- Memory search is explicit and tool-gated. The model should not search for general knowledge or live data.
- Live app data should come from MCP tools, not from memory.
- Memory write-back is model-proposed but backend-normalized with stable ids and guarded error handling.

## Change Notes For Future Work

When modifying this bot, keep these boundaries intact:

- Route files should stay thin: validate Slack, dedupe, lookup workspace, dispatch to agent.
- Turn behavior belongs in `CompanyBrainAgent`.
- Slack API calls belong in `client.ts`.
- MCP connection and runtime tool behavior belongs under `tools/mcp/`.
- Memory search/write shape should stay aligned with the prompts in `prompts.ts`.
- New persisted Slack install fields should be added to `packages/db/schema/slack.ts` and the `upsertWorkspace` call together.
- Any new event type should be added to `types.ts` and then handled in `runTurn`.
