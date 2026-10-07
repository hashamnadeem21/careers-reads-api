import { z } from "zod";
import { SLUG_PATTERN } from "../shared/content/schema.js";

/** Accent gradients the site knows how to render for blog categories. */
export const CATEGORY_ACCENTS = [
  "from-sky-500 to-indigo-500",
  "from-indigo-500 to-violet-500",
  "from-rose-500 to-orange-400",
  "from-emerald-500 to-teal-500",
  "from-amber-500 to-rose-500",
  "from-violet-500 to-fuchsia-500",
] as const;

const kind = z.enum(["blog", "job"]);

export const categorySchema = z
  .object({
    kind,
    slug: z.string().trim().regex(SLUG_PATTERN, "Use lowercase letters, numbers and dashes").max(60),
    name: z.string().trim().min(2, "At least 2 characters").max(40),
    /** Blog categories only (their page title). */
    headline: z.string().trim().max(110).default(""),
    description: z.string().trim().min(20, "At least 20 characters").max(300),
    /** Blog categories only: one of CATEGORY_ACCENTS. */
    accent: z.string().max(80).default(""),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "blog" && v.headline.length < 10) {
      ctx.addIssue({
        code: "custom",
        path: ["headline"],
        message: "Blog categories need a headline (10+ characters) for their page title",
      });
    }
    if (v.kind === "blog" && !(CATEGORY_ACCENTS as readonly string[]).includes(v.accent)) {
      ctx.addIssue({ code: "custom", path: ["accent"], message: "Pick an accent colour" });
    }
  });
export type CategoryInput = z.infer<typeof categorySchema>;

export const reorderCategoriesSchema = z.object({
  kind,
  slugs: z.array(z.string().max(80)).max(200),
});

export const categoryListQuerySchema = z.object({
  kind: z.preprocess((v) => (v === "" ? undefined : v), kind.optional()),
});
