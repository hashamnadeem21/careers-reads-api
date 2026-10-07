import { z } from "zod";
import { articleFrontmatterSchema, type ArticleFrontmatter, SLUG_PATTERN } from "../shared/content/schema.js";
import { placeableSectionIds } from "../shared/content/toc.js";

/** What the admin's editor saves (port of the admin's `lib/posts/draft.ts`). */
export const postDraftSchema = z.object({
  slug: z.string().max(120),
  title: z.string().max(300),
  excerpt: z.string().max(1000),
  body: z.string().max(200_000),
  category: z.string().max(80),
  tags: z.array(z.string().max(60)).max(20),
  author: z.string().max(80),
  coverImage: z.string().max(500),
  coverAlt: z.string().max(500),
  coverWidth: z.number().int().min(0).max(20000),
  coverHeight: z.number().int().min(0).max(20000),
  images: z
    .array(
      z.object({
        src: z.string().max(500),
        alt: z.string().max(500),
        caption: z.string().max(500),
        width: z.number().int().min(0).max(20000),
        height: z.number().int().min(0).max(20000),
        placement: z.string().max(120),
      }),
    )
    .max(3),
  seoTitle: z.string().max(300),
  seoDescription: z.string().max(500),
  canonicalUrl: z.string().max(500),
  noindex: z.boolean(),
  ads: z.boolean(),
  featured: z.boolean(),
  trending: z.boolean(),
  editorsPick: z.boolean(),
});
export type PostDraft = z.infer<typeof postDraftSchema>;

export const POST_INTENTS = ["draft", "publish", "schedule", "update", "unpublish", "autosave"] as const;
export type PostIntent = (typeof POST_INTENTS)[number];

export type Publishing = { status: "draft" | "published"; publishedAt: Date };

const blank = (v: string | undefined) => (v === undefined || v.trim() === "" ? undefined : v.trim());

/** The status and publish date an intent produces for a post that is currently `current`. */
export function resolvePublishing(
  current: { status: "draft" | "published"; publishedAt: Date | null },
  intent: PostIntent,
  now = new Date(),
  scheduleAt?: string,
): Publishing | { error: string } {
  const date = current.publishedAt;
  switch (intent) {
    case "publish":
      // Keep the original date when re-publishing something already published in the past.
      return {
        status: "published",
        publishedAt: date && current.status === "published" && date <= now ? date : now,
      };
    case "schedule": {
      const at = scheduleAt ? new Date(scheduleAt) : null;
      if (!at || Number.isNaN(at.getTime()) || at <= now) return { error: "Pick a date and time in the future." };
      return { status: "published", publishedAt: at };
    }
    case "update":
      return { status: current.status, publishedAt: date ?? now };
    case "unpublish":
    case "draft":
    case "autosave":
      return { status: "draft", publishedAt: date ?? now };
  }
}

export interface DraftCheck {
  data?: ArticleFrontmatter;
  /** Keyed by field path, e.g. "title", "images.1.alt". */
  errors: Record<string, string>;
  /** Images pointing at headings that no longer exist (they fall back to "middle"). */
  missingSections: number[];
}

/** Validates a draft with the site's own frontmatter schema, plus slug and body rules. */
export function checkDraft(draft: PostDraft, publishing: Publishing): DraftCheck {
  const errors: Record<string, string> = {};
  if (!SLUG_PATTERN.test(draft.slug)) errors.slug = "Use lowercase letters, numbers and dashes";
  else if (draft.slug.length > 100) errors.slug = "Keep the slug under 100 characters";
  if (draft.body.trim().length < 20) errors.body = "Write the post before saving (at least a few sentences)";

  const parsed = articleFrontmatterSchema.safeParse({
    title: draft.title,
    excerpt: draft.excerpt,
    category: draft.category,
    tags: draft.tags,
    author: draft.author,
    publishedAt: publishing.publishedAt.toISOString(),
    status: publishing.status,
    featured: draft.featured,
    trending: draft.trending,
    editorsPick: draft.editorsPick,
    coverImage: draft.coverImage,
    coverAlt: draft.coverAlt,
    coverWidth: draft.coverWidth || 1600,
    coverHeight: draft.coverHeight || 900,
    images: draft.images.map((i) => ({
      src: i.src,
      alt: i.alt,
      ...(blank(i.caption) && { caption: blank(i.caption) }),
      width: i.width || 1600,
      height: i.height || 900,
      placement: i.placement,
    })),
    seoTitle: blank(draft.seoTitle),
    seoDescription: blank(draft.seoDescription),
    canonicalUrl: blank(draft.canonicalUrl),
    noindex: draft.noindex,
    ads: draft.ads,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "form";
      errors[key] ??= key === "coverImage" ? "Choose a hero image" : issue.message;
    }
  }
  const sections = new Set(placeableSectionIds(draft.body));
  const missingSections = draft.images
    .map((img, i) => (img.placement.startsWith("section:") && !sections.has(img.placement.slice(8)) ? i : -1))
    .filter((i) => i >= 0);

  return {
    data: parsed.success && Object.keys(errors).length === 0 ? parsed.data : undefined,
    errors,
    missingSections,
  };
}
