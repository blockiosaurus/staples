import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, companyDocuments, documentRevisions, documents } from "@paperclipai/db";
import { COMPANY_BRIEF_WAKE_EXCERPT_CHARS, type CompanyBrief, type UpdateCompanyBrief } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";

export const COMPANY_BRIEF_DOCUMENT_KEY = "brief";
const BRIEF_TITLE = "Company brief";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type BriefActor = { userId?: string | null; agentId?: string | null; runId?: string | null };

/** What every agent's wake carries: the start of the brief, flagged when cut. */
export type CompanyBriefExcerpt = {
  body: string;
  truncated: boolean;
  revisionId: string | null;
  revisionNumber: number;
  companyId: string;
};

async function loadBrief(executor: Executor, companyId: string, lock = false) {
  const query = executor
    .select({
      documentId: documents.id,
      body: documents.latestBody,
      revisionId: documents.latestRevisionId,
      revisionNumber: documents.latestRevisionNumber,
      updatedAt: documents.updatedAt,
    })
    .from(companyDocuments)
    .innerJoin(documents, eq(companyDocuments.documentId, documents.id))
    .where(and(eq(companyDocuments.companyId, companyId), eq(companyDocuments.key, COMPANY_BRIEF_DOCUMENT_KEY)));
  const rows = lock ? await query.for("update") : await query;
  return rows[0] ?? null;
}

function toBrief(row: { body: string; revisionId: string | null; revisionNumber: number; updatedAt: Date }): CompanyBrief {
  return {
    body: row.body,
    revisionId: row.revisionId ?? "",
    revisionNumber: row.revisionNumber,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function excerptCompanyBrief(
  companyId: string,
  row: { body: string; revisionId: string | null; revisionNumber: number } | null | undefined,
): CompanyBriefExcerpt | null {
  if (!row || !row.body.trim()) return null;
  const truncated = row.body.length > COMPANY_BRIEF_WAKE_EXCERPT_CHARS;
  return {
    body: truncated ? row.body.slice(0, COMPANY_BRIEF_WAKE_EXCERPT_CHARS) : row.body,
    truncated,
    revisionId: row.revisionId,
    revisionNumber: row.revisionNumber,
    companyId,
  };
}

export function companyBriefService(db: Db) {
  return {
    get: async (companyId: string): Promise<CompanyBrief | null> => {
      const row = await loadBrief(db, companyId);
      return row ? toBrief(row) : null;
    },

    /** The capped excerpt for wake payloads; null when there is no brief or it is blank. */
    wakeExcerpt: async (companyId: string): Promise<CompanyBriefExcerpt | null> => {
      const row = await loadBrief(db, companyId);
      return excerptCompanyBrief(companyId, row);
    },

    /**
     * Create or revise the brief. Writes for one company are serialized on the
     * company row; a baseRevisionId that is not the latest revision is a 409.
     */
    update: async (
      companyId: string,
      input: UpdateCompanyBrief,
      actor: BriefActor,
    ): Promise<{ brief: CompanyBrief; changed: boolean }> =>
      db.transaction(async (tx) => {
        const [company] = await tx.select({ id: companies.id }).from(companies)
          .where(eq(companies.id, companyId)).for("update");
        if (!company) throw notFound("Company not found");
        const existing = await loadBrief(tx, companyId, true);
        const baseRevisionId = input.baseRevisionId ?? null;
        // Creating needs no base; revising needs the exact latest revision, so a
        // writer who never saw the current brief cannot overwrite it.
        if (existing ? baseRevisionId !== existing.revisionId : baseRevisionId !== null) {
          throw conflict("The company brief was changed by someone else. Reload it and try again.", {
            currentRevisionId: existing?.revisionId ?? null,
          });
        }
        const now = new Date();
        const authorship = {
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
        };

        if (existing) {
          if (existing.body === input.body) return { brief: toBrief(existing), changed: false };
          const revisionNumber = existing.revisionNumber + 1;
          const [revision] = await tx.insert(documentRevisions).values({
            companyId, documentId: existing.documentId, revisionNumber, title: BRIEF_TITLE, format: "markdown",
            body: input.body, ...authorship, createdByRunId: actor.runId ?? null, createdAt: now,
          }).returning({ id: documentRevisions.id });
          await tx.update(documents).set({
            latestBody: input.body, latestRevisionId: revision!.id, latestRevisionNumber: revisionNumber,
            updatedByAgentId: actor.agentId ?? null, updatedByUserId: actor.userId ?? null, updatedAt: now,
          }).where(eq(documents.id, existing.documentId));
          await tx.update(companyDocuments).set({ updatedAt: now }).where(eq(companyDocuments.documentId, existing.documentId));
          return { brief: toBrief({ body: input.body, revisionId: revision!.id, revisionNumber, updatedAt: now }), changed: true };
        }

        const [document] = await tx.insert(documents).values({
          companyId, title: BRIEF_TITLE, format: "markdown", latestBody: input.body, latestRevisionNumber: 1,
          ...authorship, updatedByAgentId: actor.agentId ?? null, updatedByUserId: actor.userId ?? null,
          createdAt: now, updatedAt: now,
        }).returning({ id: documents.id });
        const [revision] = await tx.insert(documentRevisions).values({
          companyId, documentId: document!.id, revisionNumber: 1, title: BRIEF_TITLE, format: "markdown",
          body: input.body, ...authorship, createdByRunId: actor.runId ?? null, createdAt: now,
        }).returning({ id: documentRevisions.id });
        await tx.update(documents).set({ latestRevisionId: revision!.id }).where(eq(documents.id, document!.id));
        await tx.insert(companyDocuments).values({
          companyId, documentId: document!.id, key: COMPANY_BRIEF_DOCUMENT_KEY, createdAt: now, updatedAt: now,
        });
        return { brief: toBrief({ body: input.body, revisionId: revision!.id, revisionNumber: 1, updatedAt: now }), changed: true };
      }),
  };
}

/** SQL condition: the company has a non-blank brief. */
export function companyHasBriefCondition(companyId: string) {
  return sql<boolean>`exists (
    select 1 from company_documents cd
    inner join documents d on d.id = cd.document_id
    where cd.company_id = ${companyId}
      and cd.key = ${COMPANY_BRIEF_DOCUMENT_KEY}
      and d.latest_body ~ '\\S'
  )`;
}
