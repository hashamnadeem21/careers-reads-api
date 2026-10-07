import { z } from "zod";
import { SLUG_PATTERN } from "../shared/content/schema.js";
import { POST_INTENTS, postDraftSchema } from "./post-draft.js";

export const POST_STATUS_FILTERS = ["live", "draft", "scheduled"] as const;
export const POST_SORTS = ["published", "title", "updated"] as const;

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const postListQuerySchema = z.object({
  q: z.preprocess(blankToUndefined, z.string().trim().max(100).optional()),
  status: z.preprocess(blankToUndefined, z.enum(POST_STATUS_FILTERS).optional()),
  category: z.preprocess(blankToUndefined, z.string().trim().max(80).optional()),
  page: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(1)),
  sort: z.preprocess(blankToUndefined, z.enum(POST_SORTS).default("updated")),
  dir: z.preprocess(blankToUndefined, z.enum(["asc", "desc"]).default("desc")),
});
export type PostListQuery = z.infer<typeof postListQuerySchema>;

/** Create or update a post: the editor's fields plus what to do with them. */
export const savePostSchema = postDraftSchema.extend({
  intent: z.enum(POST_INTENTS),
  /** ISO date, required when `intent` is "schedule". */
  scheduleAt: z.string().max(40).optional(),
});
export type SavePostInput = z.infer<typeof savePostSchema>;

const slug = z.string().regex(SLUG_PATTERN).max(100);

export const bulkPostsSchema = z.object({
  action: z.enum(["publish", "unpublish", "delete"]),
  slugs: z.array(slug).min(1).max(100),
});
