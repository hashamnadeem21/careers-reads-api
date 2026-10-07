import { z } from "zod";
import { SLUG_PATTERN } from "../shared/content/schema.js";

export const JOB_STATUS_FILTERS = ["live", "draft", "review", "scheduled", "expired"] as const;
export type JobStatusFilter = (typeof JOB_STATUS_FILTERS)[number];
export const JOB_SORTS = ["posted", "deadline", "title", "updated"] as const;

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const jobListQuerySchema = z.object({
  q: z.preprocess(blankToUndefined, z.string().trim().max(100).optional()),
  status: z.preprocess(blankToUndefined, z.enum(JOB_STATUS_FILTERS).optional()),
  category: z.preprocess(blankToUndefined, z.string().trim().max(80).optional()),
  /** Staff only: one company account's jobs. Ignored for company accounts. */
  company: z.preprocess(blankToUndefined, z.uuid().optional()),
  page: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(1)),
  sort: z.preprocess(blankToUndefined, z.enum(JOB_SORTS).default("updated")),
  dir: z.preprocess(blankToUndefined, z.enum(["asc", "desc"]).default("desc")),
});
export type JobListQuery = z.infer<typeof jobListQuerySchema>;

export const jobStatusSchema = z.object({ status: z.enum(["draft", "published"]) });

export const rejectJobSchema = z.object({
  note: z.string().trim().min(5, "Tell the company what to change (at least 5 characters)").max(500),
});

export const bulkJobsSchema = z.object({
  action: z.enum(["publish", "unpublish", "delete"]),
  slugs: z.array(z.string().regex(SLUG_PATTERN).max(100)).min(1).max(100),
});
