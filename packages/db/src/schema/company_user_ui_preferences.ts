import { pgTable, uuid, text, boolean, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companyUserUiPreferences = pgTable(
  "company_user_ui_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    pinned: jsonb("pinned").$type<string[]>().notNull().default([]),
    hidden: jsonb("hidden").$type<string[]>().notNull().default([]),
    revealed: jsonb("revealed").$type<Record<string, string>>().notNull().default({}),
    seen: jsonb("seen").$type<Record<string, string>>().notNull().default({}),
    showEverything: boolean("show_everything").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_user_ui_preferences_company_idx").on(table.companyId),
    userIdx: index("company_user_ui_preferences_user_idx").on(table.userId),
    companyUserUq: uniqueIndex("company_user_ui_preferences_company_user_uq").on(table.companyId, table.userId),
  }),
);
