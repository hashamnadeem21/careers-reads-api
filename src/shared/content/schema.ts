// Owned by blognest-api (originally blognest/src/lib/content/schema.ts). The website keeps its own copy for its file fallback; keep the rules in step.
import { z } from "zod";

/**
 * Single source of truth for article and author data shape.
 * The MDX repository validates frontmatter against these schemas today; a
 * future PostgreSQL repository should validate rows against the same schemas.
 */

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

/**
 * Where an extra image appears inside the article body:
 *  - "after-intro"        before the first section heading
 *  - "middle"             under the heading of the middle section
 *  - "before-conclusion"  before the last section heading
 *  - "section:<id>"       under a specific H2/H3 heading (id = its anchor, e.g. "section:why-it-matters")
 */
export const IMAGE_PLACEMENTS = ["after-intro", "middle", "before-conclusion"] as const;
export const imagePlacementSchema = z.union([
  z.enum(IMAGE_PLACEMENTS),
  z.string().regex(/^section:[a-z0-9-]+$/, 'Use "after-intro", "middle", "before-conclusion", or "section:<heading-id>"'),
]);
export type ImagePlacement = z.infer<typeof imagePlacementSchema>;

export const articleImageSchema = z
  .object({
    src: z.string().regex(/^\/|^https:\/\//, "Use an absolute path or https URL"),
    alt: z.string().trim().min(10).max(200),
    caption: z.string().trim().max(200).optional(),
    width: z.number().int().positive().default(1600),
    height: z.number().int().positive().default(900),
    placement: imagePlacementSchema.default("middle"),
  })
  .strict();
export type ArticleImage = z.infer<typeof articleImageSchema>;

export const articleStatusSchema = z.enum(["draft", "published"]);
export type ArticleStatus = z.infer<typeof articleStatusSchema>;

export const articleFrontmatterSchema = z
  .object({
    title: z.string().trim().min(10).max(110),
    excerpt: z.string().trim().min(50).max(220),
    /** A category slug. Whether it exists is checked against the category list (files or database). */
    category: z.string().regex(SLUG_PATTERN),
    tags: z
      .array(z.string().trim().min(2).max(40))
      .min(1)
      .max(8)
      .transform((tags) => Array.from(new Set(tags.map((t) => t.toLowerCase())))),
    author: z.string().regex(SLUG_PATTERN),
    publishedAt: isoDate,
    updatedAt: isoDate.optional(),
    status: articleStatusSchema.default("draft"),
    featured: z.boolean().default(false),
    /** Editorially curated — NOT derived from traffic analytics. */
    trending: z.boolean().default(false),
    editorsPick: z.boolean().default(false),
    coverImage: z.string().regex(/^\/|^https:\/\//, "Use an absolute path or https URL"),
    coverAlt: z.string().trim().min(10).max(200),
    coverWidth: z.number().int().positive().default(1600),
    coverHeight: z.number().int().positive().default(900),
    /** Extra images shown inside the article (the cover is the hero image at the top). */
    images: z.array(articleImageSchema).max(3).default([]),
    seoTitle: z.string().trim().max(70).optional(),
    seoDescription: z.string().trim().min(50).max(170).optional(),
    /** Only set when the article was first published elsewhere. */
    canonicalUrl: z.url().optional(),
    noindex: z.boolean().default(false),
    /** Set to false to disable ads on sensitive articles. */
    ads: z.boolean().default(true),
  })
  .strict();

export type ArticleFrontmatter = z.infer<typeof articleFrontmatterSchema>;

export const authorSchema = z
  .object({
    slug: z.string().regex(SLUG_PATTERN),
    name: z.string().trim().min(2).max(80),
    /** "Organization" for team bylines (e.g. an editorial desk), "Person" for individuals. */
    type: z.enum(["Person", "Organization"]).default("Person"),
    role: z.string().trim().min(2).max(80),
    bio: z.string().trim().min(40).max(600),
    avatar: z.string().regex(/^\/|^https:\/\//),
    links: z
      .object({
        website: z.url().optional(),
        x: z.url().optional(),
        linkedin: z.url().optional(),
      })
      .partial()
      .default({}),
  })
  .strict();

export type Author = z.infer<typeof authorSchema>;

export interface TocItem {
  id: string;
  text: string;
  depth: 2 | 3;
}

export interface ArticleSummary extends ArticleFrontmatter {
  slug: string;
  readingTimeMinutes: number;
  wordCount: number;
}

export interface Article extends ArticleSummary {
  /** Raw MDX body (frontmatter removed). */
  content: string;
  toc: TocItem[];
}
