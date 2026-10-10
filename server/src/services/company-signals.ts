import { and, eq, gt, gte, inArray, isNotNull, not, notInArray, notLike, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  assets,
  issueAttachments,
  budgetPolicies,
  companies,
  companySkills,
  costEvents,
  documents,
  goals,
  issueDocuments,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  projects,
  routines,
  toolConnections,
} from "@paperclipai/db";
import { SYSTEM_ISSUE_DOCUMENT_KEYS, type CompanySignals } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { retryIdempotentDatabaseOperation } from "../database-retry.js";
import { getUtcMonthStart } from "./dashboard.js";
import { executionIssueCondition, visibleIssueCondition } from "./issue-visibility.js";

const QUESTION_INTERACTION_KINDS = [
  "suggest_tasks",
  "ask_user_questions",
  "request_confirmation",
  "request_checkbox_confirmation",
  "request_item_verdicts",
];

const count = sql<number>`count(*)`;

export function companySignalsService(db: Db) {
  const run = <T>(op: () => Promise<T>) => retryIdempotentDatabaseOperation(op);
  const countRows = (rows: Array<{ count: number | string }>) => Number(rows[0]?.count ?? 0);

  return {
    get: async (companyId: string): Promise<CompanySignals> => {
      const company = await run(() =>
        db
          .select({ id: companies.id, budgetMonthlyCents: companies.budgetMonthlyCents })
          .from(companies)
          .where(eq(companies.id, companyId))
          .then((rows) => rows[0] ?? null),
      );
      if (!company) throw notFound("Company not found");

      const now = new Date();
      const monthStart = getUtcMonthStart(now);
      const isVisibleIssue = and(eq(issues.companyId, companyId), visibleIssueCondition());

      const [
        agentCount, taskCount, openTaskCount, projectCount, goalCount, routineCount,
        documentArtifactCount, workProductArtifactCount, attachmentArtifactCount, extraSkillCount, connectionCount,
        connectionRequestCount, approvalCount, questionCount, activePolicyCount, spend,
      ] = await Promise.all([
        run(() => db.select({ count }).from(agents).where(and(
          eq(agents.companyId, companyId),
          not(eq(agents.status, "terminated")),
          sql`not (coalesce(${agents.metadata}, '{}'::jsonb) ? 'paperclipBuiltInAgent')`,
        )).then(countRows)),
        run(() => db.select({ count }).from(issues)
          .where(and(eq(issues.companyId, companyId), executionIssueCondition())).then(countRows)),
        run(() => db.select({ count }).from(issues)
          .where(and(
            eq(issues.companyId, companyId),
            executionIssueCondition(),
            notInArray(issues.status, ["done", "cancelled"]),
          )).then(countRows)),
        run(() => db.select({ count }).from(projects)
          .where(and(eq(projects.companyId, companyId), sql`${projects.archivedAt} is null`)).then(countRows)),
        run(() => db.select({ count }).from(goals).where(eq(goals.companyId, companyId)).then(countRows)),
        run(() => db.select({ count }).from(routines)
          .where(and(eq(routines.companyId, companyId), not(eq(routines.status, "archived")))).then(countRows)),
        // Artifacts mirror the sources in companyArtifactsService.list: agent-authored,
        // non-system issue documents, paperclip artifact work products and standalone attachments on visible issues.
        run(() => db.select({ count }).from(issueDocuments)
          .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
          .innerJoin(issues, eq(issueDocuments.issueId, issues.id))
          .where(and(
            eq(issueDocuments.companyId, companyId),
            isVisibleIssue,
            or(isNotNull(documents.createdByAgentId), isNotNull(documents.updatedByAgentId)),
            notInArray(issueDocuments.key, [...SYSTEM_ISSUE_DOCUMENT_KEYS]),
          )).then(countRows)),
        run(() => db.select({ count }).from(issueWorkProducts)
          .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
          .where(and(
            eq(issueWorkProducts.companyId, companyId),
            eq(issueWorkProducts.type, "artifact"),
            eq(issueWorkProducts.provider, "paperclip"),
            isVisibleIssue,
          )).then(countRows)),
        // Standalone agent-created attachments, minus those already surfaced by a work product.
        run(() => db.select({ count }).from(issueAttachments)
          .innerJoin(assets, and(eq(issueAttachments.assetId, assets.id), eq(assets.companyId, issueAttachments.companyId)))
          .innerJoin(issues, and(eq(issueAttachments.issueId, issues.id), eq(issues.companyId, issueAttachments.companyId)))
          .where(and(
            eq(issueAttachments.companyId, companyId),
            sql`${issueAttachments.issueCommentId} is null`,
            isNotNull(assets.createdByAgentId),
            isVisibleIssue,
            sql`not exists (
              select 1 from ${issueWorkProducts}
              inner join ${issues} as wp_issue on wp_issue.id = ${issueWorkProducts.issueId}
              where ${issueWorkProducts.companyId} = ${companyId}
                and ${issueWorkProducts.type} = 'artifact'
                and ${issueWorkProducts.provider} = 'paperclip'
                and wp_issue.hidden_at is null and wp_issue.harness_kind is null
                and ${issueWorkProducts.metadata}->>'attachmentId' = ${issueAttachments.id}::text
            )`,
          )).then(countRows)),
        run(() => db.select({ count }).from(companySkills)
          .where(and(eq(companySkills.companyId, companyId), notLike(companySkills.key, "paperclipai/paperclip/%")))
          .then(countRows)),
        run(() => db.select({ count }).from(toolConnections)
          .where(eq(toolConnections.companyId, companyId)).then(countRows)),
        run(() => db.select({ count }).from(issueThreadInteractions)
          .innerJoin(issues, eq(issueThreadInteractions.issueId, issues.id))
          .where(and(
            eq(issueThreadInteractions.companyId, companyId),
            eq(issueThreadInteractions.kind, "connection_intent"),
            isVisibleIssue,
          )).then(countRows)),
        run(() => db.select({ count }).from(approvals).where(eq(approvals.companyId, companyId)).then(countRows)),
        run(() => db.select({ count }).from(issueThreadInteractions)
          .innerJoin(issues, eq(issueThreadInteractions.issueId, issues.id))
          .where(and(
            eq(issueThreadInteractions.companyId, companyId),
            inArray(issueThreadInteractions.kind, QUESTION_INTERACTION_KINDS),
            isVisibleIssue,
          )).then(countRows)),
        run(() => db.select({ count }).from(budgetPolicies)
          .where(and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.isActive, true),
            gt(budgetPolicies.amount, 0),
          )).then(countRows)),
        run(() => db
          .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)` })
          .from(costEvents)
          .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, monthStart)))
          .then((rows) => Number(rows[0]?.total ?? 0))),
      ]);

      return {
        companyId,
        agents: agentCount,
        tasks: taskCount,
        openTasks: openTaskCount,
        projects: projectCount,
        goals: goalCount,
        routines: routineCount,
        artifacts: documentArtifactCount + workProductArtifactCount + attachmentArtifactCount,
        extraSkills: extraSkillCount,
        connections: connectionCount,
        connectionRequests: connectionRequestCount,
        approvalsEver: approvalCount,
        questionsEver: questionCount,
        budgetSet: (company.budgetMonthlyCents ?? 0) > 0 || activePolicyCount > 0,
        monthSpendCents: spend,
        generatedAt: now.toISOString(),
      };
    },
  };
}
