import { Logger } from "@nestjs/common";
import readingTime from "reading-time";
import { z } from "zod";
import type { ArticleRow, AuthorRow, JobRow } from "../db/schema.js";
import { articleFrontmatterSchema, authorSchema, type Article, type Author } from "../shared/content/schema.js";
import { extractToc } from "../shared/content/toc.js";
import { jobSchema, type Job } from "../shared/jobs/schema.js";

const logger = new Logger("Content");

/**
 * Maps a database row to an Article, validated with the same schema as the website's MDX files
 * (ported from blognest's postgres-repository). One bad row is skipped and logged, never fatal.
 */
export function rowToArticle(row: ArticleRow): Article | null {
  const parsed = articleFrontmatterSchema.safeParse({
    title: row.title,
    excerpt: row.excerpt,
    category: row.category,
    tags: row.tags,
    author: row.author,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt ?? undefined,
    status: row.status,
    featured: row.featured,
    trending: row.trending,
    editorsPick: row.editorsPick,
    coverImage: row.coverImage,
    coverAlt: row.coverAlt,
    coverWidth: row.coverWidth,
    coverHeight: row.coverHeight,
    images: row.images,
    seoTitle: row.seoTitle ?? undefined,
    seoDescription: row.seoDescription ?? undefined,
    canonicalUrl: row.canonicalUrl ?? undefined,
    noindex: row.noindex,
    ads: row.ads,
  });
  if (!parsed.success) {
    logger.error(`Skipping article "${row.slug}":\n${z.prettifyError(parsed.error)}`);
    return null;
  }
  const stats = readingTime(row.body);
  return {
    ...parsed.data,
    slug: row.slug,
    content: row.body,
    toc: extractToc(row.body),
    wordCount: stats.words,
    readingTimeMinutes: Math.max(1, Math.round(stats.minutes)),
  };
}

export function rowToAuthor(row: AuthorRow): Author | null {
  const parsed = authorSchema.safeParse({ ...row, links: row.links ?? {} });
  if (!parsed.success) {
    logger.error(`Skipping author "${row.slug}":\n${z.prettifyError(parsed.error)}`);
    return null;
  }
  return parsed.data;
}

/** Maps a database row to a Job, validated with the same schema as the website's JSON files. */
export function rowToJob(row: JobRow): Job | null {
  const parsed = jobSchema.safeParse({
    title: row.title,
    company: row.company,
    companyWebsite: row.companyWebsite ?? undefined,
    city: row.city ?? undefined,
    country: row.country,
    workModel: row.workModel,
    employmentType: row.employmentType,
    category: row.category,
    experience: row.experience,
    salary: row.salary ?? undefined,
    summary: row.summary,
    responsibilities: row.responsibilities,
    requirements: row.requirements,
    benefits: row.benefits,
    applyUrl: row.applyUrl ?? undefined,
    applyEmail: row.applyEmail ?? undefined,
    postedAt: row.postedAt,
    deadline: row.deadline ?? undefined,
    status: row.status,
    featured: row.featured,
    sample: row.sample,
  });
  if (!parsed.success) {
    logger.error(`Skipping job "${row.slug}":\n${z.prettifyError(parsed.error)}`);
    return null;
  }
  return { ...parsed.data, slug: row.slug };
}
