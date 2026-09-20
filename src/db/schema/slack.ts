import { relations } from "drizzle-orm"
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core"
import { member, organization, user } from "./auth"

export const slackWorkspace = sqliteTable(
	"slack_workspace",
	{
		teamId: text("team_id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		botUserId: text("bot_user_id"),
		botTokenEnc: text("bot_token_enc").notNull(),
		teamName: text("team_name"),
		installedByUserId: text("installed_by_user_id").references(() => user.id, {
			onDelete: "set null",
		}),
		scopes: text("scopes"),
		appId: text("app_id"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [index("idx_slack_workspace_org_id").on(table.orgId)],
)

export const slackWorkspaceRelations = relations(slackWorkspace, ({ one }) => ({
	org: one(organization, {
		fields: [slackWorkspace.orgId],
		references: [organization.id],
	}),
	installedBy: one(user, {
		fields: [slackWorkspace.installedByUserId],
		references: [user.id],
	}),
}))

export const slackWorkspaceMember = sqliteTable(
	"slack_workspace_member",
	{
		teamId: text("team_id")
			.notNull()
			.references(() => slackWorkspace.teamId, { onDelete: "cascade" }),
		slackUserId: text("slack_user_id").notNull(),
		orgId: text("org_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		email: text("email"),
		status: text("status").notNull().default("active"),
		linkSource: text("link_source").notNull().default("email_match"),
		provisionedMemberId: text("provisioned_member_id").references(
			() => member.id,
			{ onDelete: "set null" },
		),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		primaryKey({ columns: [table.teamId, table.slackUserId] }),
		index("idx_slack_workspace_member_org_id").on(table.orgId),
		index("idx_slack_workspace_member_user_id").on(table.userId),
	],
)

export const slackAccountLinkState = sqliteTable(
	"slack_account_link_state",
	{
		tokenHash: text("token_hash").primaryKey(),
		teamId: text("team_id")
			.notNull()
			.references(() => slackWorkspace.teamId, { onDelete: "cascade" }),
		slackUserId: text("slack_user_id").notNull(),
		orgId: text("org_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		slackEmail: text("slack_email"),
		slackDisplayName: text("slack_display_name"),
		expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
		consumedAt: integer("consumed_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		index("idx_slack_account_link_state_expires_at").on(table.expiresAt),
		index("idx_slack_account_link_state_identity").on(
			table.teamId,
			table.slackUserId,
		),
	],
)
