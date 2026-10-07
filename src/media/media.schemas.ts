import { z } from "zod";

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const mediaListQuerySchema = z.object({
  q: z.preprocess(blankToUndefined, z.string().trim().max(80).optional()),
  page: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(1)),
});
export type MediaListQuery = z.infer<typeof mediaListQuerySchema>;

export const altSchema = z.string().trim().max(200, "Alt text must be 200 characters or fewer.");

export const updateMediaSchema = z.object({ alt: altSchema });
