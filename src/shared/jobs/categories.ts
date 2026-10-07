// Owned by blognest-api (originally blognest/src/lib/jobs/categories.ts). The website keeps its own copy for its file fallback; keep the rules in step.
/**
 * Job categories. Like blog categories (see src/lib/categories.ts), this typed
 * list is the default and is replaced in place by the database loader.
 */
export const JOB_CATEGORY_SLUGS = [
  "software-it",
  "design-creative",
  "marketing-content",
  "sales-business",
  "finance-accounting",
  "customer-support",
  "operations-admin",
  "education-training",
] as const;

/** Any job category slug (categories can be added in the admin panel). */
export type JobCategorySlug = string;

export interface JobCategory {
  slug: JobCategorySlug;
  name: string;
  description: string;
}

const defaultJobCategories: Record<string, JobCategory> = {
  "software-it": {
    slug: "software-it",
    name: "Software & IT",
    description: "Developers, QA, DevOps, data, and IT support roles.",
  },
  "design-creative": {
    slug: "design-creative",
    name: "Design & Creative",
    description: "UI/UX, graphic design, video, and creative roles.",
  },
  "marketing-content": {
    slug: "marketing-content",
    name: "Marketing & Content",
    description: "Digital marketing, SEO, social media, and writing.",
  },
  "sales-business": {
    slug: "sales-business",
    name: "Sales & Business",
    description: "Sales, business development, and account management.",
  },
  "finance-accounting": {
    slug: "finance-accounting",
    name: "Finance & Accounting",
    description: "Accounting, audit, banking, and finance roles.",
  },
  "customer-support": {
    slug: "customer-support",
    name: "Customer Support",
    description: "Support, success, and call-center roles.",
  },
  "operations-admin": {
    slug: "operations-admin",
    name: "Operations & Admin",
    description: "HR, admin, logistics, and operations roles.",
  },
  "education-training": {
    slug: "education-training",
    name: "Education & Training",
    description: "Teaching, tutoring, and training roles.",
  },
};

const jobRegistry: Record<string, JobCategory> = { ...defaultJobCategories };

export const jobCategories: Record<JobCategorySlug, JobCategory> = new Proxy(jobRegistry, {
  get: (target, key) =>
    typeof key === "string" && !(key in target)
      ? { slug: key, name: key.replace(/-/g, " "), description: "" }
      : Reflect.get(target, key),
});

export const jobCategoryList: JobCategory[] = JOB_CATEGORY_SLUGS.map((slug) => defaultJobCategories[slug]);

export function isJobCategorySlug(value: string): value is JobCategorySlug {
  return Object.hasOwn(jobRegistry, value);
}

/** Replaces the active job categories (called by the database loader). An empty list keeps the defaults. */
export function replaceJobCategories(next: JobCategory[]): void {
  if (next.length === 0) return;
  for (const key of Object.keys(jobRegistry)) delete jobRegistry[key];
  for (const c of next) jobRegistry[c.slug] = c;
  jobCategoryList.splice(0, jobCategoryList.length, ...next);
}

export const EMPLOYMENT_TYPES = ["full-time", "part-time", "contract", "internship", "freelance"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const WORK_MODELS = ["on-site", "hybrid", "remote"] as const;
export type WorkModel = (typeof WORK_MODELS)[number];

export const EXPERIENCE_LEVELS = ["entry", "mid", "senior"] as const;
export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

export const employmentTypeLabels: Record<EmploymentType, string> = {
  "full-time": "Full-time",
  "part-time": "Part-time",
  contract: "Contract",
  internship: "Internship",
  freelance: "Freelance",
};

export const workModelLabels: Record<WorkModel, string> = {
  "on-site": "On-site",
  hybrid: "Hybrid",
  remote: "Remote",
};

export const experienceLabels: Record<ExperienceLevel, string> = {
  entry: "Entry level (0–2 yrs)",
  mid: "Mid level (2–5 yrs)",
  senior: "Senior (5+ yrs)",
};
