import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Progress of one POST /plans/apply, keyed by (company, idempotency key), so a
 * retry resumes instead of duplicating: agents already hired are reused by
 * client key, and a plan already applied returns its stored result.
 */
export const planApplications = pgTable(
  "plan_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    /** sha256 of the canonical plan; a key reused for a different plan is refused. */
    planHash: text("plan_hash").notNull(),
    /** in_progress | applied | failed | superseded (taken over by a newer key) */
    status: text("status").notNull().default("in_progress"),
    /** Hired agents by client key: { id, status, approvalId }. */
    agents: jsonb("agents").$type<Record<string, { id: string; status: string; approvalId: string | null }>>().notNull().default({}),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    lastError: text("last_error"),
    /** While set in the future, another apply holds this key. */
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    /** Random token of the apply holding the lease; every write during an apply is conditional on it. */
    leaseOwner: text("lease_owner"),
    /** The row that took this one over (status superseded). */
    supersededById: uuid("superseded_by_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUq: uniqueIndex("plan_applications_company_key_uq").on(table.companyId, table.idempotencyKey),
  }),
);
