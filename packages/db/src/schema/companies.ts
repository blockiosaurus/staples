import type { InteractionResolverGovernance } from "@paperclipai/shared";
import { numeric, pgTable, uuid, text, integer, timestamp, boolean, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    issuePrefix: text("issue_prefix").notNull().default("PAP"),
    issueCounter: integer("issue_counter").notNull().default(0),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spendMonthUtc: text("spend_month_utc"),
    spentMonthlyCents: numeric("spent_monthly_cents", { precision: 24, scale: 7, mode: "number" }).notNull().default(0),
    defaultResponsibleUserId: text("default_responsible_user_id"),
    requireBoardApprovalForNewAgents: boolean("require_board_approval_for_new_agents")
      .notNull()
      .default(false),
    interactionResolverGovernance: jsonb("interaction_resolver_governance")
      .$type<InteractionResolverGovernance>()
      .notNull()
      .default({}),
    feedbackDataSharingEnabled: boolean("feedback_data_sharing_enabled")
      .notNull()
      .default(false),
    feedbackDataSharingConsentAt: timestamp("feedback_data_sharing_consent_at", { withTimezone: true }),
    feedbackDataSharingConsentByUserId: text("feedback_data_sharing_consent_by_user_id"),
    feedbackDataSharingTermsVersion: text("feedback_data_sharing_terms_version"),
    /**
     * Created by a non-admin under PAPERCLIP_SELF_SERVE_COMPANIES. While that
     * flag is on, the self-serve floor (remote adapters only, no host
     * execution) applies to this company whatever the actor.
     */
    selfServe: boolean("self_serve").notNull().default(false),
    /** The user who created this self-serve company; counts toward their limit. */
    selfServeCreatedByUserId: text("self_serve_created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issuePrefixUniqueIdx: uniqueIndex("companies_issue_prefix_idx").on(table.issuePrefix),
    selfServeCreatorIdx: index("companies_self_serve_creator_idx").on(table.selfServeCreatedByUserId),
  }),
);
