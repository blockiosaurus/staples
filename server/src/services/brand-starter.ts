import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import sharp from "sharp";
import { agents, issueComments, issueWorkProducts, issues, type Db } from "@paperclipai/db";
import { renderBrandKit } from "@paperclipai/brand-kit";
import {
  BRAND_STARTER_ORIGIN_KIND,
  type BrandKitSpec,
  type BrandStarterConcept,
  type BrandStarterStatus,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { StorageService } from "../storage/types.js";
import { logActivity } from "./activity-log.js";
import { heartbeatService } from "./heartbeat.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { issueService } from "./issues.js";

export const BRAND_DESIGNER_AGENT_KEY = "brand-designer";
const MANIFEST_FILENAME = "brand-starter.json";
const DOCUMENT_FILENAME = "brand-starter.md";
const PALETTE_FILENAME = "palette.json";
const CONCEPT_FILE = /^concept-(\d+)-(mark|lockup|preview)\.(svg|png)$/;

export const BRAND_STARTER_BODY = (description: string, companyName: string, nameGiven: boolean) =>
  `The person described their business as:\n\n> ${description.trim().replace(/\n+/g, "\n> ")}\n\n` +
  `Current company name: ${companyName.trim()}\n` +
  `Name given: ${nameGiven ? "yes" : "no"}\n\n` +
  (nameGiven
    ? "The person chose this name. Keep it: every concept's `name` must be exactly this.\n\n"
    : "This is a working name derived from the description. Propose a different name per concept, or keep it where it fits.\n\n") +
  "Follow the `staples-brand-kit` skill: three concepts (a geometric mark, a monogram, a wordmark), a palette and a one-page brand starter. " +
  "Publish with the brand-kit publish call, then comment with one line per concept and mark this task done.";

const NAME_GIVEN_MARKER = /^Name given: yes$/m;

export function attachmentContentPath(attachmentId: string) {
  return `/api/attachments/${attachmentId}/content`;
}

/** Lockup SVG to a white-flattened PNG of the given width. */
export function rasterize(svg: string, width: number): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density: 300 })
    .resize({ width })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
}

export type BrandStarterActor = {
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
};

type Manifest = { concepts: Array<{ index: number; name: string; kind: BrandStarterConcept["kind"] }>; tagline: string | null; pairingId?: string };

export function brandStarterService(db: Db, storage: StorageService, options: { heartbeat?: IssueAssignmentWakeupDeps } = {}) {
  const issueSvc = issueService(db);
  let heartbeat = options.heartbeat ?? null;
  const wakeScheduler = () => (heartbeat ??= heartbeatService(db));

  async function findIssue(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, BRAND_STARTER_ORIGIN_KIND), eq(issues.originId, companyId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function findDesigner(companyId: string) {
    return db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          ne(agents.status, "terminated"),
          sql`${agents.metadata} -> 'paperclipBuiltInAgent' ->> 'key' = ${BRAND_DESIGNER_AGENT_KEY}`,
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function start(companyId: string, input: { description: string; userId: string; companyName: string; nameGiven: boolean }): Promise<{ issueId: string } | null> {
    const existing = await findIssue(companyId);
    if (existing) return { issueId: existing.id };
    const designer = await findDesigner(companyId);
    if (!designer) return null;
    const issue = await issueSvc.create(companyId, {
      title: "Brand starter",
      description: BRAND_STARTER_BODY(input.description, input.companyName, input.nameGiven),
      status: "todo",
      priority: "high",
      assigneeAgentId: designer.id,
      originKind: BRAND_STARTER_ORIGIN_KIND,
      originId: companyId,
      createdByUserId: input.userId,
      actorResponsibleUserId: input.userId,
      trustExplicitResponsibleUserId: true,
    });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: input.userId,
      action: "issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: { originKind: BRAND_STARTER_ORIGIN_KIND },
    });
    void queueIssueAssignmentWakeup({
      heartbeat: wakeScheduler(),
      issue: { id: issue.id, assigneeAgentId: issue.assigneeAgentId ?? designer.id, status: issue.status },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      requestedByActorType: "user",
      requestedByActorId: input.userId,
    });
    return { issueId: issue.id };
  }

  async function readManifest(attachment: { objectKey: string; companyId: string }): Promise<Manifest | null> {
    try {
      const obj = await storage.getObject(attachment.companyId, attachment.objectKey);
      const chunks: Buffer[] = [];
      for await (const chunk of obj.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Manifest;
      return Array.isArray(parsed.concepts) ? parsed : null;
    } catch (err) {
      logger.warn({ err }, "brand starter manifest unreadable");
      return null;
    }
  }

  async function status(companyId: string): Promise<BrandStarterStatus> {
    const issue = await findIssue(companyId);
    if (!issue) {
      return { issue: null, designerName: null, latestNote: null, concepts: [], documentPath: null, palettePath: null, tagline: null, nameGiven: false };
    }
    const [attachments, designer, comment] = await Promise.all([
      issueSvc.listAttachments(issue.id),
      issue.assigneeAgentId
        ? db
            .select({ name: agents.name })
            .from(agents)
            .where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, companyId)))
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            eq(issueComments.issueId, issue.id),
            isNotNull(issueComments.authorAgentId),
            isNull(issueComments.deletedAt),
          ),
        )
        .orderBy(desc(issueComments.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    // listAttachments is newest first: the first row per filename wins.
    const byName = new Map<string, (typeof attachments)[number]>();
    for (const a of attachments) {
      if (a.companyId === companyId && a.originalFilename && !byName.has(a.originalFilename)) byName.set(a.originalFilename, a);
    }
    const manifestAttachment = byName.get(MANIFEST_FILENAME);
    const manifest = manifestAttachment ? await readManifest(manifestAttachment) : null;
    const concepts: BrandStarterConcept[] = [];
    if (manifest) {
      for (const c of [...manifest.concepts].sort((x, y) => x.index - y.index)) {
        const mark = byName.get(`concept-${c.index}-mark.svg`);
        const lockup = byName.get(`concept-${c.index}-lockup.svg`);
        if (!mark || !lockup) continue;
        const preview = byName.get(`concept-${c.index}-preview.png`);
        concepts.push({
          index: c.index,
          name: c.name,
          kind: c.kind,
          markPath: attachmentContentPath(mark.id),
          lockupPath: attachmentContentPath(lockup.id),
          previewPath: preview ? attachmentContentPath(preview.id) : null,
        });
      }
    }
    const doc = byName.get(DOCUMENT_FILENAME);
    const palette = byName.get(PALETTE_FILENAME);
    const note = comment?.body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null;
    return {
      issue: { id: issue.id, identifier: issue.identifier ?? "", status: issue.status },
      designerName: designer?.name ?? null,
      latestNote: note,
      concepts,
      documentPath: doc ? attachmentContentPath(doc.id) : null,
      palettePath: palette ? attachmentContentPath(palette.id) : null,
      tagline: manifest?.tagline ?? null,
      nameGiven: NAME_GIVEN_MARKER.test(issue.description ?? ""),
    };
  }

  async function publish(
    companyId: string,
    input: { issueId: string; spec: BrandKitSpec; document: string; tagline?: string | null; actor: BrandStarterActor },
  ): Promise<BrandStarterStatus> {
    const issue = await issueSvc.getById(input.issueId);
    if (!issue || issue.companyId !== companyId) throw notFound("Issue not found");
    if (issue.originKind !== BRAND_STARTER_ORIGIN_KIND || issue.originId !== companyId) {
      throw unprocessable("Issue is not the brand starter task");
    }
    const out = renderBrandKit(input.spec);
    const failed = out.concepts.filter((c) => !c.lint.ok);
    if (failed.length > 0) {
      throw unprocessable("Brand kit failed lint", {
        concepts: failed.map((c) => ({ index: c.index, name: c.name, errors: c.lint.errors })),
      });
    }
    const tagline = input.tagline?.trim() || input.spec.tagline?.trim() || null;

    const files: Array<{ name: string; contentType: string; body: Buffer }> = [];
    for (const c of out.concepts) {
      files.push({ name: `concept-${c.index}-mark.svg`, contentType: "image/svg+xml", body: Buffer.from(c.markSvg) });
      files.push({ name: `concept-${c.index}-lockup.svg`, contentType: "image/svg+xml", body: Buffer.from(c.lockupSvg) });
      let preview: Buffer;
      try {
        preview = await rasterize(c.lockupSvg, 512);
      } catch (err) {
        logger.warn({ err, concept: c.name }, "brand starter preview rasterisation failed");
        throw unprocessable(`Could not render a preview for concept ${c.index} (${c.name})`);
      }
      files.push({ name: `concept-${c.index}-preview.png`, contentType: "image/png", body: preview });
    }
    files.push({ name: PALETTE_FILENAME, contentType: "application/json", body: Buffer.from(JSON.stringify(out.palette, null, 2)) });
    files.push({ name: DOCUMENT_FILENAME, contentType: "text/markdown", body: Buffer.from(input.document) });
    const manifest: Manifest = {
      concepts: out.concepts.map((c) => ({ index: c.index, name: c.name, kind: c.kind })),
      tagline,
      pairingId: out.pairing.id,
    };
    files.push({ name: MANIFEST_FILENAME, contentType: "application/json", body: Buffer.from(JSON.stringify(manifest, null, 2)) });

    // Re-publishing replaces. Remember the old files, write the new set, then drop the old
    // ones, so a failure part-way never leaves the issue without a kit.
    const names = new Set(files.map((f) => f.name));
    const stale = (await issueSvc.listAttachments(issue.id)).filter(
      (old) => old.companyId === companyId && old.originalFilename && (names.has(old.originalFilename) || CONCEPT_FILE.test(old.originalFilename)),
    );

    for (const file of files) {
      const stored = await storage.putFile({
        companyId,
        namespace: `issues/${issue.id}`,
        originalFilename: file.name,
        contentType: file.contentType,
        body: file.body,
      });
      await issueSvc.createAttachment({
        issueId: issue.id,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: input.actor.agentId,
        createdByUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
        createdByRunId: input.actor.runId,
      });
    }

    if (stale.length > 0) {
      const staleIds = stale.map((old) => old.id);
      await db
        .delete(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, companyId),
            eq(issueWorkProducts.issueId, issue.id),
            eq(issueWorkProducts.type, "artifact"),
            inArray(issueWorkProducts.externalId, staleIds),
          ),
        );
      for (const old of stale) {
        try {
          await storage.deleteObject(old.companyId, old.objectKey);
        } catch (err) {
          logger.warn({ err, attachmentId: old.id }, "storage delete failed while replacing brand starter file");
        }
        await issueSvc.removeAttachment(old.id);
      }
    }

    await logActivity(db, {
      companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId,
      runId: input.actor.runId,
      agentApiKeyId: input.actor.agentApiKeyId,
      action: "issue.brand_kit_published",
      entityType: "issue",
      entityId: issue.id,
      details: { concepts: out.concepts.length, files: files.length },
    });
    return status(companyId);
  }

  return { start, findIssue, status, publish };
}
