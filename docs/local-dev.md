# Company Brain: local dev setup

End state: your own Company Brain bot, in your own private Slack sandbox workspace, answering from the API running on your machine. Budget about an hour the first time.

## How it fits together

| Piece | Where | Local URL |
| --- | --- | --- |
| API + brain agent | `mono` repo, `apps/api` | `https://api.dev.supermemory.ai` |
| Web app (signup, `/brain` onboarding) | `supermemory` repo, `apps/web` | `https://app.dev.supermemory.ai` |
| Slack sandbox + your Slack app | Slack, manual | n/a |
| Public tunnel | ngrok | `https://<you>.ngrok-free.app` |

Two kinds of traffic, two kinds of URL:

- **Browser traffic** uses the `*.dev.supermemory.ai` hostnames. They resolve to `127.0.0.1` and portless serves them over HTTPS from your machine. This covers the web app, API calls from it, and the Slack OAuth redirect.
- **Slack server traffic** (event and interactivity webhooks) is POSTed by Slack's servers, which cannot reach `127.0.0.1`. That is what the tunnel is for.

Because the webhook URLs point at one specific machine, **every engineer needs their own Slack app** (and their own sandbox workspace to keep bots from colliding). The manifest below makes that a paste, not a chore.

## Prerequisites

- `mono` and `supermemory` repos already set up for local dev with [Bun](https://bun.sh), envs copied and filled from the shared dev env (`apps/api/.env` in mono, `apps/web/.env` in supermemory). The API should already run on your machine before starting this guide.
- In `supermemory/apps/web/.env`, point the web app at your local API: `NEXT_PUBLIC_BACKEND_URL=https://api.dev.supermemory.ai`.
- An [ngrok](https://ngrok.com) account (free). Claim your one free static domain under **Universal Gateway -> Domains** so your tunnel URL survives restarts.
- Joined the [Slack developer program](https://api.slack.com/developer-program) (free) for sandbox workspaces.

## 1. Run the stack

```sh
# mono
bun run dev

# supermemory
cd apps/web && bun dev
```

Check: `https://api.dev.supermemory.ai` and `https://app.dev.supermemory.ai` both load.

The brain is its own worker, so `bun run dev` starts two processes (brain + API) and
stops both on Ctrl+C. The startup banner should show
`COMPANY_BRAIN_AGENT ... local [connected]` — `[not connected]` on the first print is
just the brain still booting. See [do-split-runbook.md](./do-split-runbook.md).

Run from your main checkout, not a git worktree. In a worktree portless prefixes the branch name onto the hostname (`<branch>.api.dev.supermemory.ai`), which breaks the URLs baked into your Slack app and env.

## 2. Start the tunnel

```sh
ngrok http https://api.dev.supermemory.ai \
  --host-header=api.dev.supermemory.ai \
  --domain=<you>.ngrok-free.app
```

This forwards Slack's webhooks through ngrok into your local portless proxy. Keep it running whenever you want the bot to respond.

## 3. Create your Slack sandbox and app

1. Sandbox: [developer program dashboard](https://api.slack.com/developer-program) -> **Sandboxes** -> create one and open it in Slack. Limits to know: 2 active sandboxes at a time, 10 per 30 days, no importing of message history.
2. App: [api.slack.com/apps](https://api.slack.com/apps) -> **Create New App** -> **From a manifest** -> pick your sandbox workspace -> paste [`docs/company-brain/slack-app-manifest.yaml`](./slack-app-manifest.yaml) with `YOUR-TUNNEL` and `yourname` replaced.
3. From the app's **Basic Information** page, copy into `apps/api/.env`:
   - Client ID -> `SLACK_CLIENT_ID`
   - Client Secret -> `SLACK_CLIENT_SECRET`
   - Signing Secret -> `SLACK_SIGNING_SECRET`
4. Restart `bun run dev` so the worker picks up the secrets.
5. Back in the Slack app: **Event Subscriptions** -> the Request URL shows unverified (the API rejects unsigned requests, and it did not have your signing secret yet). Hit **Retry**. It must turn green.

Do **not** use the dashboard's "Install App" button. Installation happens through the product flow in step 5, which is what links the workspace to your org.

## 4. Create your org and install the bot

1. Open `https://app.dev.supermemory.ai`, sign up, then go to `/brain`.
2. Follow the Company Brain onboarding. It creates the org, attaches the trial and billing products, and offers **Add to Slack**.
3. The Slack OAuth screen opens for your app. Pick your **sandbox** workspace and allow.
4. You land back in the app, and the bot creates or adopts `#company-brain` in your sandbox.

## 5. Verify

- DM the bot, or @mention it in a channel it is in. You should get a streamed answer.
- Logs: `tail -f .logs/workflow.log` in `mono`. Slack deliveries also show in the ngrok console.

## Troubleshooting

- **Request URL verification fails**: API not running, tunnel down, or `SLACK_SIGNING_SECRET` mismatch. The events route returns 401 before the handshake if the signature is wrong.
- **Bot never replies**: check the ngrok console. No requests means Slack cannot reach you (tunnel down, or request URLs still have the placeholder). Requests with 401 means signing secret mismatch. Requests with 200 but silence, read `.logs/workflow.log`; a missing AI Gateway token fails the turn.
- **OAuth install errors**: the redirect URL in the Slack app must be exactly `https://api.dev.supermemory.ai/brain/slack/oauth/callback`, and the install must start from the web app (`/brain`), signed in as an org admin.
- **Portless serves the wrong app**: a stale workerd is squatting the port. Kill old `wrangler`/`workerd` processes and restart `bun run dev`. Testing with `curl localhost` is misleading (IPv6 vs IPv4), use the full hostname.
- **Fresh checkout misbehaves**: run `bun install` before `bun dev`.

## Reference: what the Slack app must have

Defined by code, mirrored in the manifest. If these drift, update the manifest and your app.

- Bot scopes: `SLACK_SCOPES` in `apps/api/src/routes/brain/slack/index.ts`.
- Endpoints (`apps/api/src/routes/brain/slack/index.ts`): `POST /brain/slack/events`, `POST /brain/slack/interactions`, `GET /brain/slack/oauth/install` (admin-only, product-initiated), `GET /brain/slack/oauth/callback`. MCP connector OAuth returns to `/brain/mcp-connections/callback`.
- Signature check: `apps/api/src/lib/brain/slack/verify.ts`, HMAC with `SLACK_SIGNING_SECRET`, 5 minute clock skew, no dev bypass.
- Event handling and routing: `apps/api/src/lib/brain/slack/events.ts`, turns run in the `CompanyBrainAgent` Durable Object (`apps/api/src/lib/brain/turn/agent.ts`).

Architecture background: [architecture.md](./architecture.md) and [spec.md](./spec.md).
