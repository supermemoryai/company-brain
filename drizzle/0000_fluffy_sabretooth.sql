CREATE TABLE `deployment_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`encrypted` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `member` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_member_org_user` ON `member` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_member_org_id` ON `member` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_member_user_id` ON `member` (`user_id`);--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo` text,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `organization_settings` (
	`org_id` text PRIMARY KEY NOT NULL,
	`brain_proactivity` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`email` text NOT NULL,
	`image` text,
	`deleted` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `google_workspace_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`google_sub` text NOT NULL,
	`email` text NOT NULL,
	`oauth_client_id` text NOT NULL,
	`access_token_enc` text NOT NULL,
	`refresh_token_enc` text,
	`expires_at` integer,
	`scopes` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_error` text,
	`refresh_version` integer DEFAULT 0 NOT NULL,
	`refresh_claim_token` text,
	`refresh_claim_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_google_workspace_grant_identity` ON `google_workspace_grant` (`user_id`,`google_sub`,`oauth_client_id`);--> statement-breakpoint
CREATE INDEX `idx_google_workspace_grant_user` ON `google_workspace_grant` (`user_id`);--> statement-breakpoint
CREATE TABLE `mcp_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text,
	`runtime` text DEFAULT 'remote_mcp' NOT NULL,
	`server_slug` text NOT NULL,
	`server_url` text,
	`google_workspace_grant_id` text,
	`transport` text DEFAULT 'http' NOT NULL,
	`auth_type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`expires_at` integer,
	`scopes` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`google_workspace_grant_id`) REFERENCES `google_workspace_grant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mcp_connection_org_id` ON `mcp_connection` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_connection_status` ON `mcp_connection` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_mcp_connection_org_slug_user` ON `mcp_connection` (`org_id`,`server_slug`,`user_id`) WHERE "mcp_connection"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_mcp_connection_org_slug_shared` ON `mcp_connection` (`org_id`,`server_slug`) WHERE "mcp_connection"."user_id" is null;--> statement-breakpoint
CREATE TABLE `mcp_oauth_state` (
	`state_token` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text,
	`runtime` text DEFAULT 'remote_mcp' NOT NULL,
	`server_slug` text NOT NULL,
	`server_url` text,
	`code_verifier` text,
	`pkce_verifier_enc` text,
	`requested_scopes` text,
	`target_google_workspace_grant_id` text,
	`client_info` text,
	`tokens` text,
	`redirect_url` text,
	`context` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_google_workspace_grant_id`) REFERENCES `google_workspace_grant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mcp_oauth_state_expires_at` ON `mcp_oauth_state` (`expires_at`);--> statement-breakpoint
CREATE TABLE `slack_account_link_state` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`slack_user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`slack_email` text,
	`slack_display_name` text,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `slack_workspace`(`team_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_slack_account_link_state_expires_at` ON `slack_account_link_state` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_slack_account_link_state_identity` ON `slack_account_link_state` (`team_id`,`slack_user_id`);--> statement-breakpoint
CREATE TABLE `slack_workspace` (
	`team_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`bot_user_id` text,
	`bot_token_enc` text NOT NULL,
	`team_name` text,
	`installed_by_user_id` text,
	`scopes` text,
	`app_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`installed_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_slack_workspace_org_id` ON `slack_workspace` (`org_id`);--> statement-breakpoint
CREATE TABLE `slack_workspace_member` (
	`team_id` text NOT NULL,
	`slack_user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`email` text,
	`status` text DEFAULT 'active' NOT NULL,
	`link_source` text DEFAULT 'email_match' NOT NULL,
	`provisioned_member_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`team_id`, `slack_user_id`),
	FOREIGN KEY (`team_id`) REFERENCES `slack_workspace`(`team_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provisioned_member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_slack_workspace_member_org_id` ON `slack_workspace_member` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_slack_workspace_member_user_id` ON `slack_workspace_member` (`user_id`);