export interface UiPreferences {
  pinned: string[];
  hidden: string[];
  /** surfaceId -> ISO timestamp of first reveal */
  revealed: Record<string, string>;
  /** surfaceId -> ISO timestamp of first visit */
  seen: Record<string, string>;
  showEverything: boolean;
  updatedAt: string | null;
}
