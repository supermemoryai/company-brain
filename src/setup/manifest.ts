export const SLACK_APP_NAME = "Supermemory Company Brain"

/** Slack app manifest for this deployment, with its own URLs filled in. */
export function slackAppManifest(origin: string, appName = SLACK_APP_NAME) {
	return {
		display_information: {
			name: appName,
			description: "Your team's shared memory, in Slack. By supermemory.",
			background_color: "#000b36",
		},
		features: {
			app_home: {
				home_tab_enabled: false,
				messages_tab_enabled: true,
				messages_tab_read_only_enabled: false,
			},
			bot_user: { display_name: appName, always_online: true },
			agent_view: {
				agent_description: "Super agent with all the context of a company",
				suggested_prompts: [],
			},
		},
		oauth_config: {
			redirect_urls: [
				`${origin}/brain/slack/oauth/callback`,
				`${origin}/auth/slack/callback`,
			],
			scopes: {
				user: [
					"openid",
					"email",
					"profile",
					"canvases:read",
					"channels:history",
					"files:read",
					"groups:history",
					"groups:read",
					"im:history",
					"mpim:history",
					"mpim:read",
					"search:read.files",
					"search:read.im",
					"search:read.mpim",
					"search:read.private",
					"search:read.public",
				],
				bot: [
					"app_mentions:read",
					"assistant:write",
					"channels:history",
					"channels:join",
					"channels:manage",
					"channels:read",
					"channels:write.invites",
					"chat:write",
					"files:read",
					"files:write",
					"groups:history",
					"groups:read",
					"im:history",
					"im:write",
					"reactions:read",
					"reactions:write",
					"team:read",
					"usergroups:read",
					"users:read",
					"users:read.email",
				],
			},
			pkce_enabled: false,
		},
		settings: {
			event_subscriptions: {
				request_url: `${origin}/slack/events`,
				bot_events: [
					"app_mention",
					"message.channels",
					"message.groups",
					"message.im",
					"reaction_added",
					"reaction_removed",
					"team_join",
					"user_change",
				],
			},
			interactivity: {
				is_enabled: true,
				request_url: `${origin}/slack/interactions`,
			},
			org_deploy_enabled: false,
			socket_mode_enabled: false,
			token_rotation_enabled: false,
			is_mcp_enabled: true,
		},
	}
}
