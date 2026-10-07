// Owned by blognest-api (originally blognest/src/lib/jobs/schema.ts). The website keeps its own copy for its file fallback; keep the rules in step.
import { z } from "zod";
import { SLUG_PATTERN } from "../content/schema.js";
import { EMPLOYMENT_TYPES, EXPERIENCE_LEVELS, WORK_MODELS } from "./categories.js";

const isoDate = z
  .union([z.string(), z.date()])
  .transform((value, ctx) => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: "custom", message: "Invalid date" });
      return z.NEVER;
    }
    return date.toISOString();
  });

const listItems = z.array(z.string().trim().min(3).max(300)).max(20);

/**
 * Shape of one job file in `content/jobs/<slug>.json`.
 * The admin panel should validate its form input against this same schema.
 */
export const jobSchema = z
  .object({
    title: z.string().trim().min(4).max(100),
    company: z.string().trim().min(2).max(100),
    companyWebsite: z.url().optional(),
    city: z.string().trim().min(2).max(60).optional(),
    country: z.string().trim().min(2).max(60),
    workModel: z.enum(WORK_MODELS),
    employmentType: z.enum(EMPLOYMENT_TYPES),
    /** A job category slug (checked against the category list, files or database). */
    category: z.string().regex(SLUG_PATTERN),
    experience: z.enum(EXPERIENCE_LEVELS),
    /** Free text, e.g. "PKR 80,000 – 120,000 / month". Leave out if not disclosed. */
    salary: z.string().trim().min(2).max(80).optional(),
    summary: z.string().trim().min(30).max(240),
    responsibilities: listItems.default([]),
    requirements: listItems.default([]),
    benefits: listItems.default([]),
    applyUrl: z.url().optional(),
    applyEmail: z.email().optional(),
    postedAt: isoDate,
    /** Last day to apply. The job disappears from the site after this date. */
    deadline: isoDate.optional(),
    status: z.enum(["draft", "published"]).default("draft"),
    featured: z.boolean().default(false),
    /** Example listing: shown in development only, never in production. */
    sample: z.boolean().default(false),
  })
  .strict()
  .refine((job) => job.applyUrl || job.applyEmail, {
    message: "Add an applyUrl or an applyEmail so people can apply",
    path: ["applyUrl"],
  });

export type JobInput = z.infer<typeof jobSchema>;

export interface Job extends JobInput {
  slug: string;
}

export function jobLocation(job: Pick<Job, "city" | "country" | "workModel">): string {
  const place = job.city ? `${job.city}, ${job.country}` : job.country;
  return job.workModel === "remote" && !job.city ? `Remote · ${place}` : place;
}
