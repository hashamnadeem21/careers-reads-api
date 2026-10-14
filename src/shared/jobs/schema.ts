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
    summary: z.string().trim().min(30),
    /** Rich-text job ad (sanitized HTML). Replaces summary + lists on the site; older jobs don't have one. */
    description: z.string().trim().max(60_000).optional(),
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

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

/** Plain text of a job description's HTML, for search, meta descriptions and the summary. */
export function descriptionText(html: string): string {
  return html
    .replace(/<\/(p|li|h[1-6]|blockquote|div)>|<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#?\w+);/g, (m, name: string) => ENTITIES[name] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/** The short summary saved alongside a description: its opening text, cut at a word, at most 240 characters. */
export function summaryFromDescription(html: string): string {
  const text = descriptionText(html);
  if (text.length <= 240) return text;
  const cut = text.slice(0, 239);
  const space = cut.lastIndexOf(" ");
  return `${(space > 180 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function jobLocation(job: Pick<Job, "city" | "country" | "workModel">): string {
  const place = job.city ? `${job.city}, ${job.country}` : job.country;
  return job.workModel === "remote" && !job.city ? `Remote · ${place}` : place;
}
