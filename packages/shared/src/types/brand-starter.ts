export const BRAND_STARTER_ORIGIN_KIND = "staples_brand_starter";
export interface BrandStarterConcept {
  index: number;            // 1-based, matches file names concept-<index>-*
  name: string;
  kind: "geometric" | "monogram" | "wordmark";
  markPath: string;         // /api/... content path of concept-<n>-mark.svg
  lockupPath: string;       // concept-<n>-lockup.svg
  previewPath: string | null; // concept-<n>-preview.png
}
export interface BrandStarterStatus {
  issue: { id: string; identifier: string; status: string } | null; // null: company has no brand starter
  designerName: string | null;
  latestNote: string | null;   // first line of the designer's latest comment
  concepts: BrandStarterConcept[];
  documentPath: string | null; // brand-starter.md
  palettePath: string | null;  // palette.json
  tagline: string | null;
  nameGiven: boolean;          // the person chose the company name (not a derived working name)
}
