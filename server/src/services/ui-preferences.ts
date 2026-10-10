import { and, eq } from "drizzle-orm";
import { companyUserUiPreferences, type Db } from "@paperclipai/db";
import {
  applyUiPreferencesPatch,
  DEFAULT_UI_PREFERENCES,
  type PatchUiPreferences,
  type UiPreferences,
} from "@paperclipai/shared";

type Row = typeof companyUserUiPreferences.$inferSelect;

function toPreferences(row: Row | undefined | null): UiPreferences {
  if (!row) return { ...DEFAULT_UI_PREFERENCES };
  return {
    pinned: row.pinned,
    hidden: row.hidden,
    revealed: row.revealed,
    seen: row.seen,
    showEverything: row.showEverything,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const rowWhere = (companyId: string, userId: string) =>
  and(eq(companyUserUiPreferences.companyId, companyId), eq(companyUserUiPreferences.userId, userId));

export function uiPreferencesService(db: Db) {
  return {
    async get(companyId: string, userId: string): Promise<UiPreferences> {
      const [row] = await db.select().from(companyUserUiPreferences).where(rowWhere(companyId, userId)).limit(1);
      return toPreferences(row);
    },

    async patch(companyId: string, userId: string, patch: PatchUiPreferences): Promise<UiPreferences> {
      return db.transaction(async (tx) => {
        await tx.insert(companyUserUiPreferences).values({ companyId, userId }).onConflictDoNothing();
        const [row] = await tx
          .select()
          .from(companyUserUiPreferences)
          .where(rowWhere(companyId, userId))
          .for("update");
        const now = new Date();
        const next = applyUiPreferencesPatch(toPreferences(row), patch, now.toISOString());
        const [updated] = await tx
          .update(companyUserUiPreferences)
          .set({
            pinned: next.pinned,
            hidden: next.hidden,
            revealed: next.revealed,
            seen: next.seen,
            showEverything: next.showEverything,
            updatedAt: now,
          })
          .where(rowWhere(companyId, userId))
          .returning();
        return toPreferences(updated);
      });
    },
  };
}
