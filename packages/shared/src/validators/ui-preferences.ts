import { z } from "zod";

export const surfaceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,79}$/);
const surfaceIdList = z.array(surfaceIdSchema).max(20);

export const patchUiPreferencesSchema = z
  .object({
    pin: surfaceIdList.optional(),
    unpin: surfaceIdList.optional(),
    hide: surfaceIdList.optional(),
    unhide: surfaceIdList.optional(),
    reveal: surfaceIdList.optional(),
    see: surfaceIdList.optional(),
    showEverything: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "At least one change is required",
  });

export type PatchUiPreferences = z.infer<typeof patchUiPreferencesSchema>;
