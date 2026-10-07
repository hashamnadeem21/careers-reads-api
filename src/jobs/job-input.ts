import { z } from "zod";
import { fieldErrors } from "../common/zod.js";
import { slugify } from "../common/slug.js";
import { SLUG_PATTERN } from "../shared/content/schema.js";
import { type JobInput, jobSchema } from "../shared/jobs/schema.js";

/**
 * What the admin's job form sends, as JSON (port of the admin's `lib/jobs/form.ts`).
 * Loose on purpose: strings are trimmed, blanks mean "not set", empty list items are dropped,
 * and the result is validated with the site's own `jobSchema`.
 */
const text = z.string().max(2000).default("");
const list = z.array(z.string().max(2000)).max(50).default([]);

export const jobBodySchema = z.object({
  /** Leave empty to build one from the title and company. */
  slug: text,
  title: text,
  company: text,
  companyWebsite: text,
  city: text,
  country: text,
  workModel: text,
  employmentType: text,
  category: text,
  experience: text,
  salary: text,
  summary: text,
  responsibilities: list,
  requirements: list,
  benefits: list,
  applyUrl: text,
  applyEmail: text,
  /** "YYYY-MM-DD" (midnight UTC) or an ISO date. */
  postedAt: text,
  /** Last day to apply, "YYYY-MM-DD" or ISO. Empty = no deadline. */
  deadline: text,
  status: z.enum(["draft", "published"]).default("draft"),
  featured: z.boolean().default(false),
  /** Staff only: the company account that owns the job (empty = Career Reads). */
  companyId: text,
});
export type JobBody = z.infer<typeof jobBodySchema>;

export interface ParsedJob {
  slug: string;
  data?: JobInput;
  errors: Record<string, string>;
}

const optional = (v: string) => (v.trim() === "" ? undefined : v.trim());

/** "YYYY-MM-DD" from a date input → ISO midnight UTC. Anything else is passed through. */
export function dateInputToIso(value: string): string | undefined {
  const v = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return v || undefined;
  return `${v}T00:00:00.000Z`;
}

export function jobSlugFrom(title: string, company: string): string {
  return slugify([title, company].filter(Boolean).join(" ")) || "job";
}

/** Turns the body into the exact object the site validates. Pure; the service adds database checks. */
export function parseJobBody(body: JobBody): ParsedJob {
  const title = body.title.trim();
  const company = body.company.trim();
  const slug = body.slug.trim().toLowerCase() || jobSlugFrom(title, company);
  const items = (values: string[]) => values.map((v) => v.trim()).filter(Boolean);

  const candidate = {
    title,
    company,
    companyWebsite: optional(body.companyWebsite),
    city: optional(body.city),
    country: body.country.trim(),
    workModel: body.workModel.trim(),
    employmentType: body.employmentType.trim(),
    category: body.category.trim(),
    experience: body.experience.trim(),
    salary: optional(body.salary),
    summary: body.summary.trim(),
    responsibilities: items(body.responsibilities),
    requirements: items(body.requirements),
    benefits: items(body.benefits),
    applyUrl: optional(body.applyUrl),
    applyEmail: optional(body.applyEmail),
    postedAt: dateInputToIso(body.postedAt) ?? "",
    deadline: dateInputToIso(body.deadline),
    status: body.status,
    featured: body.featured,
    sample: false,
  };

  const errors: Record<string, string> = {};
  if (!SLUG_PATTERN.test(slug)) errors.slug = "Use lowercase letters, numbers and dashes";
  if (slug.length > 100) errors.slug = "Keep the slug under 100 characters";
  if (candidate.deadline && candidate.postedAt && candidate.deadline < candidate.postedAt) {
    errors.deadline = "The deadline can't be before the posted date";
  }
  const parsed = jobSchema.safeParse(candidate);
  if (!parsed.success)
    for (const [field, message] of Object.entries(fieldErrors(parsed.error))) errors[field] ??= message;
  if (!parsed.success || Object.keys(errors).length) return { slug, errors };
  return { slug, data: parsed.data, errors };
}
