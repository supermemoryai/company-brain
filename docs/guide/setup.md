# Setup and onboarding

Deploying Company Brain and installing it into Slack.

Setting up Company Brain is a few one-time steps for whoever deploys it. Everyone else joins on their own after that (see [Greeting new teammates](use-cases/greeting.md)). Deploy details, secrets and local development are in the [root README](../../README.md).

## 1. Deploy and open `/setup`

Deploy the worker (the Deploy to Cloudflare button, or `wrangler deploy`). It asks for a supermemory API key and one model key. Then open `/setup` on your deployment. It checks, in order:

1. **Database:** the D1 migrations have run. The worker applies them itself on its first request; if that failed, the page shows why and a **Run migrations** button to retry.
2. **Memory:** `SUPERMEMORY_API_KEY` is set.
3. **Model:** `MODEL_API_KEY` holds an Anthropic, OpenAI, Google or xAI key (the provider is detected from the key), or a provider-specific variable like `ANTHROPIC_API_KEY` is set.
4. **Slack:** the Slack app credentials are stored.

> [!NOTE]
> Company Brain installs into an existing Slack workspace; it doesn't create one for you. Don't have one yet? Create it at [app.slack.com](https://app.slack.com) first.

## 2. Create the Slack app

On `/setup`, click **Create the Slack app**. It opens Slack with a manifest that already has your deployment's URLs in it (events, interactivity, and the two OAuth redirects). Pick your workspace, create the app, then copy its **Client ID**, **Client secret** and **Signing secret** from *Basic Information → App Credentials* back into the form on `/setup`.

Slack verifies the event and interactivity URLs with the signing secret, so if it flagged them as unverified while you were creating the app, hit **Retry** under *Event Subscriptions* once the credentials are saved.

## 3. Sign in with Slack

Click **Sign in with Slack**. The first person to sign in creates the organization and becomes its **owner**. After that, anyone from the same Slack workspace can sign in; people from other workspaces are turned away.

## 4. Install to Slack (admin)

Click **Install to Slack** (on `/setup`, or from the brain's home). Only owners and admins can install. After you approve Slack's consent screen:

1. **Hand off to Slack.** The app UI welcomes you back and points you to Slack.
2. **Home channel.** The agent creates `#company-brain`, invites you, and posts an intro there.
3. **Research.** It figures out your company's domain from your Slack workspace and starts learning about the company. If the deployment has `CONTEXT_DEV_API_KEY` set, that includes reading your company's website.
4. **Channels.** An admin card offers to **add it to your public channels**. It never joins silently: you tap once, then it works through your public channels and introduces itself. Private channels only get it when someone invites it.
5. **Your team.** Rolling it out to teammates starts automatically: people are picked up from the Slack workspace and get a welcome DM. There's no per-seat anything, so nobody has to be invited by email.
6. **Your DM.** You get a welcome DM with buttons to connect your first tools.

> [!NOTE]
> **Try it:** ask `What does {your company} do?` in `#company-brain` or a DM.

## 5. The app UI

Once you're signed in, your deployment's root (`/`) is the app:

- **Home:** setup progress, connected sources, members, and Slack status.
- **Graph:** the brain's memories as a graph (the shared brain plus your own private memories).
- **Configure:** Integrations, Models, Workspace Prompt, Proactivity, Automations and Skills.

Next:

- **[Greeting new teammates](use-cases/greeting.md):** what joining looks like from a new hire's side.
- **[The permissions graph](permissions.md):** what each person can see once they're in.
