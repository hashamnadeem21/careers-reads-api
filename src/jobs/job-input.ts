import { z } from "zod";
import { fieldErrors } from "../common/zod.js";
import { slugify } from "../common/slug.js";
import { SLUG_PATTERN } from "../shared/content/schema.js";
import { MAX_QUESTIONS, type Question, questionSchema } from "../shared/jobs/questions.js";
import { type JobInput, descriptionText, jobSchema, summaryFromDescription } from "../shared/jobs/schema.js";
import { sanitizeJobHtml } from "./job-html.js";

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
  /** Rich-text job description (HTML from the editor). When set, the summary is derived from it. */
  description: z.string().max(100_000).default(""),
  responsibilities: list,
  requirements: list,
  benefits: list,
  /** Take applications on Career Reads (needs the company's permission, set by a super admin). */
  onsiteApply: z.boolean().default(false),
  /** Screening questions for the application form, in order. Checked in `parseJobBody`. */
  questions: z.array(z.unknown()).max(MAX_QUESTIONS, `Ask at most ${MAX_QUESTIONS} questions`).default([]),
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
  questions: Question[];
  errors: Record<string, string>;
}

/** The questions, or errors keyed `questions.<index>.<field>`. */
export function parseQuestions(raw: unknown[]): { questions: Question[]; errors: Record<string, string> } {
  const questions: Question[] = [];
  const errors: Record<string, string> = {};
  raw.forEach((item, index) => {
    const parsed = questionSchema.safeParse(item);
    if (parsed.success) questions.push(parsed.data);
    else
      for (const [field, message] of Object.entries(fieldErrors(parsed.error)))
        errors[`questions.${index}.${field}`] ??= message;
  });
  const ids = questions.map((q) => q.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) errors.questions = "A question appears twice";
  return { questions, errors };
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
  const html = sanitizeJobHtml(body.description);
  const description = descriptionText(html) ? html : undefined;

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
    summary: description ? summaryFromDescription(description) : body.summary.trim(),
    description,
    responsibilities: items(body.responsibilities),
    requirements: items(body.requirements),
    benefits: items(body.benefits),
    onsiteApply: body.onsiteApply,
    applyUrl: optional(body.applyUrl),
    applyEmail: optional(body.applyEmail),
    postedAt: dateInputToIso(body.postedAt) ?? "",
    deadline: dateInputToIso(body.deadline),
    status: body.status,
    featured: body.featured,
    sample: false,
  };

  const { questions, errors } = parseQuestions(body.questions);
  if (!SLUG_PATTERN.test(slug)) errors.slug = "Use lowercase letters, numbers and dashes";
  if (slug.length > 100) errors.slug = "Keep the slug under 100 characters";
  if (candidate.deadline && candidate.postedAt && candidate.deadline < candidate.postedAt) {
    errors.deadline = "The deadline can't be before the posted date";
  }
  const parsed = jobSchema.safeParse(candidate);
  if (!parsed.success)
    for (const [field, message] of Object.entries(fieldErrors(parsed.error))) errors[field] ??= message;
  // With a description the summary is derived from it, so its errors belong to the editor.
  if (description && errors.summary) {
    errors.description ??= "Write at least 30 characters";
    delete errors.summary;
  }
  if (!parsed.success || Object.keys(errors).length) return { slug, questions, errors };
  return { slug, data: parsed.data, questions, errors };
}
