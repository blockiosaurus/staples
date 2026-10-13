import { z } from "zod";

/** Maximum stored length of the company brief. */
export const COMPANY_BRIEF_MAX_CHARS = 20_000;
/** How much of the brief is inlined into every agent's wake prompt. */
export const COMPANY_BRIEF_WAKE_EXCERPT_CHARS = 4_000;
export const COMPANY_BRIEF_PATH = "/company/brief";

export const updateCompanyBriefSchema = z
  .object({
    body: z.string().max(COMPANY_BRIEF_MAX_CHARS),
    /** The revision the edit was based on; a mismatch is a 409 conflict. */
    baseRevisionId: z.string().uuid().nullable().optional(),
  })
  .strict();

export type UpdateCompanyBrief = z.infer<typeof updateCompanyBriefSchema>;
