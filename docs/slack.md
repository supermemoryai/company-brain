# Company Brain — Slack

**Anchors:** `apps/api/src/routes/brain/slack/index.ts`, `apps/api/src/lib/brain/slack/**`, turn loop under `lib/brain/turn/**`.

## HTTP surface

| Method | Path | Auth | Role |
|--------|------|------|------|
| GET | `/brain/slack/oauth/install` | Supermemory session + org | Start install |
| GET | `/brain/slack/oauth/callback` | Slack redirect (passthrough) | Exchange code, store workspace |
| POST | `/brain/slack/events` | Slack HMAC | Events API |
| POST | `/brain/slack/interactions` | Slack HMAC | Block Kit buttons |
| GET | `/brain/slack/status` | Session | Install status |
| DELETE | `/brain/slack/workspace` | Session + org, admin/owner | Disconnect the workspace |
| GET | `/internal/brain-admin/slack-installs` | Observatory secret | List every live Slack install |
| POST | `/internal/brain-admin/slack-shutdown` | Observatory secret + Company Brain admin | Announce or remove, inline, up to 25 orgs per call (preview by default) |
| GET/POST | `/brain/slack/account-link/:token` | Session | Link Slack ↔ SM user |

### Event auth

- Raw body + `x-slack-signature` + `x-slack-request-timestamp`
- Reject skew &gt; 5 minutes; HMAC-SHA256 with `SLACK_SIGNING_SECRET`
- Not Better Auth session cookies

### Install

- Requires `org` + `user` on install route, and `memberRole` of `admin` or `owner`; any other org member gets `403`
- OAuth state in `AUTH_KV` (`slack:oauth:{state}`, TTL ~600s)
- Bot token encrypted (PBKDF2 + AES-GCM; see workspace helpers) into `slack_workspace`
- Bootstrap: `#company-brain` home, welcome, optional public-channel rollout card, member provisioning wave

### Disconnect

`DELETE /brain/slack/workspace` tears the install down. Admin or owner only.
Runs for **every** `slack_workspace` row on the org. Two halves, shared with the
operator shutdown below (`slack/workspace.ts`):

**Announce** — `announceSlackWorkspaceFarewell`. One idempotent post per install in
`#company-brain`, while the token still works and the Durable Object still knows the
home channel (fallback: the bot's joined channels, so a retry after reset still finds
it). A retryable post (`ratelimited`, 5xx, network) returns `hold` and nothing is torn
down, so the retry can still speak. A missing or dead channel is `skipped`, never a
blocker. DMs are left as-is — Slack cannot unsend them.

**Teardown** — `teardownSlackWorkspace`. Order matters: agent state is cleared
*before* any row is deleted, so a failure leaves the workspace intact and the call
is retryable.

1. `resetSlackWorkspaceState()` on the org's Durable Object. Clears home/observe,
   public-channel rollout, team-invite, welcome/notified, and channel-membership
   state, and cancels every Slack-owned schedule. On failure: `cleanup_failed`.
2. Per installation: `apps.uninstall`, falling back to `auth.revoke`. Uninstall is
   what removes the bot from every channel and DM, so no per-channel
   `conversations.leave`. Outcome is `revoked`, `terminal`, or `transient`. Only
   `transient` — a network error, 5xx, or `ratelimited`, where Slack never gave a
   verdict — holds the row back, because the encrypted token is the only way to retry
   revocation. `terminal` covers a dead token and `invalid_auth`; gating on those
   would strand a workspace already removed on Slack's side in our database forever.
3. Under the same `pg_advisory_xact_lock` OAuth uses, delete the `slack_workspace` row
   scoped to `org + team + token`, then its `slack_workspace_member` rows. A zero-row
   delete is only success when no row survives for that team — a surviving row means
   OAuth reinstalled during teardown (the token is re-encrypted with a fresh IV, so the
   scoped delete misses it) and the call reports `cleanup_failed` instead.

Responses: `200 {ok, revoked}` · `404 not_connected` · `503 cleanup_failed` (retryable).
`revoked` is true only when **every** installation was revoked, so a partial success on
a multi-workspace org never reads as fully revoked. `revoked: false` with `ok: true`
means our side is clean but the app may still need removing from the Slack admin page.

### Shutdown (operator)

The customer DELETE above remains scoped to one org. Operator retirement is the
same two functions run inline from `POST /internal/brain-admin/slack-shutdown`
(`routes/internal/brain-org-admin.ts`), driven from Observatory → Company Brain →
"Slack agent retirement". No workflow, no binding, no polling: the fleet is small
(about a hundred workspaces at most), so each call finishes in seconds and the
response carries per-org results. Announcement and removal are separate, explicit
actions:

1. **Send deprecation notice only** (`mode: "announce"`) posts once per installation
   in `#company-brain`. The notice says the agent will leave by **Tuesday, September 8,
   2026**, and saved data remains available at **console.supermemory.ai**. This run
   does not reset state, revoke tokens, uninstall the app, or schedule removal.
2. **Remove agent now** (`mode: "remove"`) is a separate operator action to run by
   Tuesday. It calls `teardownSlackWorkspace` without posting another notice.
   No date-based automation is armed by sending the announcement.

The route runs at most 25 orgs per call, five at a time. Observatory sends the
confirmed org list in chunks of 10 and shows progress as each chunk returns, so an
operator watches the whole run and can rerun the leftovers. Per-org outcomes:

- announce: `posted`, `already_posted`, `skipped`, `hold`, `not_connected`, `failed`
- teardown: `done`, `not_connected`, `failed`

`hold` and `failed` are retryable by clicking again. Slack posts use a deterministic
UUID `client_msg_id`, so a repeat announce cannot double-post; Slack answers `ok`
with the *original* message's `ts`, which `postSlackMessageIdempotent` detects (ts
older than the request by more than a minute) and reports as `already_posted`
instead of a fresh post. Transient or incomplete home-channel enumeration returns
`hold`, not `skipped`; a dead token or genuinely absent home channel is `skipped`.

`POST /internal/brain-admin/slack-shutdown` requires `mode`, previews by default
(`dryRun`), and accepts `orgIds` for a subset. The preview includes the exact message
and org/team list. The UI confirms that list and submits those org IDs, not a fresh
unrestricted "all" selection. Both actions retain the Company Brain admin allowlist
and internal-secret checks.

### Console access after deprecation

Console v2 no longer redirects Company Brain organizations to the consumer app.
Members can select them in the initial org picker or the shell switcher and keep
that selection on reload. Existing membership, restricted-space, and admin-only
route checks still apply; this does not grant access to other organizations or
change billing entitlements.

## Event dispatch

After verify + parse + workspace resolve, the route acknowledges quickly and `waitUntil`s the DO.

| Kind | Handler |
|------|---------|
| `team_join` | `onSlackTeamJoin` |
| `user_change` | `onSlackUserChange` |
| Reactions (incl. debug) | `onSlackReaction` |
| Channel membership events | `onSlackMembershipEvent` |
| Explicit answerable | `onSlackEvent` (fiber) |
| Top-level chime candidate | `onSlackChimeIn` |
| Context retention | `onSlackContextEvent` |

Classifiers: `slack/events.ts` — `isAnsweredEvent`, `isChimeInEvent`, `isContextRetentionEvent`, mention/address helpers.

**Answerable (simplified):** DMs; `@bot` as `app_mention`; thread messages the bot should stay in. Bot/self ignored.

**Chime:** top-level channel `message`, not DM, not already `@bot`, non-empty text, bot must already be in channel.

**Context:** other messages kept for local context without starting a full answer turn (exact twin of `app_mention` excluded).

Idempotency: `AUTH_KV` keys such as `slack:evt:{event_id}` (and chime-specific keys); DO also tracks processed work.

## Turn path (`onSlackEvent` → fiber → `runTurn`)

1. Accept fiber keyed by Slack `event_id` (recovery + keep-alive).
2. Load workspace; ignore bots / self.
3. Participation: mentions, DMs, remembered bot threads (`brain_bot_thread`).
4. Outside DMs, direct `@` of someone else is not a bot summons (context only).
5. Active-thread steering: stop/cancel; Haiku gate `IGNORE` | `APPEND` | `REPLACE` → inbox / restart (`turn-control`, `active-turn-gate`, `turn-inbox`).
6. Passive thread follow-ups → **triage** before main turn.
7. UX: native stream in DM/assistant; **public progress cards** in channel threads.
8. `computeTurn` with abort + steering snapshot; drain live inbox each step.
9. Finalization claims must see a clean inbox; then post reply, connect prompts, memory writeback if turn still current.

**Slack actor:** `personalConnectionsOnly: true`.

## Triage and chime

**File:** `slack/triage.ts`  
**Budget:** `slack/chime-budget.ts`

- Outcomes: **`ANSWER`** (admit main turn), **`ACK`** (reaction only), **`INVESTIGATE`** (bounded passive investigation), **`PASS`** (no Slack message, no reaction).
- Default model: triage profile (`claude-haiku-4.5`, low effort) — see [agent.md](./agent.md).
- Parse or model failure falls back to **PASS** for both thread and channel.
- Thread-only **affirmative override**: prior bot offer + short “yes/sure” can force ANSWER.
- Telemetry is best-effort and must not change the route.

**Channel chime budget (code constants):**

| Constant | Value |
|----------|--------|
| Absolute max replies / channel / hour | 12 |
| General allowance / hour | 6 |
| Summons / hour | 4 |
| Low priority / hour | 2 |
| Normal min interval | 3 minutes |
| Low quiet interval | 15 minutes |

Passive investigation has separate concurrency/hourly caps in the same module.

Channel **ANSWER** replies in a **new thread** on the triggering message. Thread **ANSWER** stays in-thread.

## Public-channel rollout

**Files:** `public-channel-rollout.ts`, `history-document.ts`, `channel-introduction.ts`, `connected-tool-crosscheck.ts`

- Opt-in button (“Add me to public channels”) is posted to the **installer's DM** by `ensureAdminRolloutCard`; `#company-brain` only gets a read-only status card, because a channel message renders identically for every viewer.
- Freezes a **7-day** window; pages join/history with persisted cursors; respects Slack `Retry-After` via alarms.
- Skips `#general`, `#company-brain`, private, archived, Slack Connect.
- Documents → **`sm_org_shared`** (raw searchable + dynamic memory extraction).
- Themes corroborated only with **org-shared read-only** tools; evidence not written as durable truth.
- Exactly-once introductions via ledger + Slack `client_msg_id`.

## Identity and provisioning

- Stable map: `(team_id, slack_user_id)` → Supermemory user/org (`slack_workspace_member`).
- Email match bootstraps once, then mapping is durable.
- Unmapped users get a private **Verify** flow — no public account leakage.
- Auto team invite + `team_join` / `user_change` provision/revoke full members (guests/bots/external excluded). See `turn/team-invite.ts`, `member-provisioning.ts`, `account-link.ts`.

## UX

- DM/assistant: stream text + tool task cards.
- Channels: temporary public progress cards; final answer as a new thread reply; card deleted or collapsed after.
- Consequential tools: Approve/Deny card; asker only; ~15m expiry; supersede cancels stale cards.
- Connect app: Block Kit button + OAuth; optional turn retry after connect (`onSlackConnectComplete`).
- Reactions: processing ack → done; debug reactions can surface traces.

## Memory writeback on Slack turns

Scoped by channel privacy (`conversations.info` fail-closed). Model proposes `save_memory`; backend normalizes tags and container (see [architecture.md](./architecture.md#memory-short)). Unmapped private sender → skip write.

## Code anchors (high traffic)

- Routes: `routes/brain/slack/index.ts`
- Events: `slack/events.ts`
- Turn: `slack/turn.ts`, `turn-control.ts`, `turn-inbox.ts`
- Triage/chime: `slack/triage.ts`, `chime.ts`, `chime-budget.ts`
- Client/UX: `slack/client.ts`, `stream.ts`, `mcp-connect.ts`
- Rollout: `slack/public-channel-rollout.ts`
