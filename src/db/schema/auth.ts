import { generateId } from "@repo/lib/generate-id"
import { relations } from "drizzle-orm"
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { BrainProactivitySettings } from "./common"

/**
 * Single-tenant identity. A deployment serves one organization; people arrive
 * through Slack, so `user` rows are created from Slack profiles rather than a
 * login flow.
 */
export const user = sqliteTable("user", {
	id: text("id").primaryKey().$defaultFn(generateId),
	name: text("name").notNull().default(""),
	email: text("email").notNull(),
	image: text("image"),
	deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
})

export const organization = sqliteTable("organization", {
	id: text("id").primaryKey().$defaultFn(generateId),
	name: text("name").notNull(),
	slug: text("slug").notNull(),
	logo: text("logo"),
	metadata: text("metadata", { mode: "json" }).$type<
		Record<string, unknown>
	>(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
})

export const member = sqliteTable(
	"member",
	{
		id: text("id").primaryKey().$defaultFn(generateId),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		role: text("role").notNull().default("member"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		index("idx_member_org_id").on(table.organizationId),
		index("idx_member_user_id").on(table.userId),
	],
)

export const organizationSettings = sqliteTable("organization_settings", {
	orgId: text("org_id")
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	brainProactivity: text("brain_proactivity", {
		mode: "json",
	}).$type<BrainProactivitySettings>(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
})

export const userRelations = relations(user, ({ many }) => ({
	members: many(member),
}))

export const organizationRelations = relations(organization, ({ many }) => ({
	members: many(member),
}))

export const memberRelations = relations(member, ({ one }) => ({
	organization: one(organization, {
		fields: [member.organizationId],
		references: [organization.id],
	}),
	user: one(user, { fields: [member.userId], references: [user.id] }),
}))

/**
 * Values captured after deploy rather than supplied as Workers secrets, so a
 * one-click deploy only has to ask for a memory key and a model key. Secret
 * values are encrypted with the deployment's encryption key.
 */
export const deploymentConfig = sqliteTable("deployment_config", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
	encrypted: integer("encrypted", { mode: "boolean" }).notNull().default(false),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
})
