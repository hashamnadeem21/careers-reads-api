import matter from "gray-matter";
import { z } from "zod";
import type { articles, authors, categories, jobs } from "../db/schema.js";
import { categoryList } from "../shared/categories.js";
import { articleFrontmatterSchema, authorSchema, SLUG_PATTERN } from "../shared/content/schema.js";
import { jobCategoryList } from "../shared/jobs/categories.js";
import { jobSchema } from "../shared/jobs/schema.js";

export interface SourceFile {
  name: string;
  source: string;
}

export interface ImportPlan {
  categories: (typeof categories.$inferInsert)[];
  authors: (typeof authors.$inferInsert)[];
  articles: (typeof articles.$inferInsert)[];
  jobs: (typeof jobs.$inferInsert)[];
  skippedSamples: number;
}

function slugFromFile(name: string, ext: RegExp): string {
  const slug = name.replace(ext, "");
  if (!SLUG_PATTERN.test(slug)) throw new Error(`File name "${name}" must be a lowercase kebab-case slug.`);
  return slug;
}

function parseOrThrow<T extends z.ZodType>(schema: T, data: unknown, file: string): z.infer<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`Invalid content in ${file}:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/**
 * Turns the site's content files into database rows, validating each one with
 * the same Zod schemas the site uses. Pure: no I/O, so it is unit-tested.
 */
export function buildImportPlan(input: {
  articleFiles: SourceFile[];
  authorFiles: SourceFile[];
  jobFiles: SourceFile[];
  includeSamples?: boolean;
}): ImportPlan {
  const categoryRows: ImportPlan["categories"] = [
    ...categoryList.map((c, i) => ({
      slug: c.slug,
      kind: "blog" as const,
      name: c.name,
      headline: c.headline,
      description: c.description,
      accent: c.accent,
      sortOrder: i,
    })),
    ...jobCategoryList.map((c, i) => ({
      slug: c.slug,
      kind: "job" as const,
      name: c.name,
      headline: null,
      description: c.description,
      accent: null,
      sortOrder: i,
    })),
  ];

  const authorRows = input.authorFiles.map(({ name, source }) => {
    const author = parseOrThrow(authorSchema, JSON.parse(source), name);
    return { ...author, links: author.links ?? {} };
  });

  const articleRows = input.articleFiles.map(({ name, source }) => {
    const slug = slugFromFile(name, /\.mdx?$/);
    const { data, content } = matter(source);
    const fm = parseOrThrow(articleFrontmatterSchema, data, name);
    return {
      slug,
      title: fm.title,
      excerpt: fm.excerpt,
      body: content.replace(/^\n+/, ""),
      category: fm.category,
      tags: fm.tags,
      author: fm.author,
      status: fm.status,
      publishedAt: new Date(fm.publishedAt),
      updatedAt: fm.updatedAt ? new Date(fm.updatedAt) : null,
      featured: fm.featured,
      trending: fm.trending,
      editorsPick: fm.editorsPick,
      coverImage: fm.coverImage,
      coverAlt: fm.coverAlt,
      coverWidth: fm.coverWidth,
      coverHeight: fm.coverHeight,
      images: fm.images,
      seoTitle: fm.seoTitle ?? null,
      seoDescription: fm.seoDescription ?? null,
      canonicalUrl: fm.canonicalUrl ?? null,
      noindex: fm.noindex,
      ads: fm.ads,
    };
  });

  let skippedSamples = 0;
  const jobRows: ImportPlan["jobs"] = [];
  for (const { name, source } of input.jobFiles) {
    const slug = slugFromFile(name, /\.json$/);
    const job = parseOrThrow(jobSchema, JSON.parse(source), name);
    if (job.sample) {
      skippedSamples++;
      if (!input.includeSamples) continue;
    }
    jobRows.push({
      slug,
      title: job.title,
      company: job.company,
      companyWebsite: job.companyWebsite ?? null,
      city: job.city ?? null,
      country: job.country,
      workModel: job.workModel,
      employmentType: job.employmentType,
      category: job.category,
      experience: job.experience,
      salary: job.salary ?? null,
      summary: job.summary,
      responsibilities: job.responsibilities,
      requirements: job.requirements,
      benefits: job.benefits,
      applyUrl: job.applyUrl ?? null,
      applyEmail: job.applyEmail ?? null,
      postedAt: new Date(job.postedAt),
      deadline: job.deadline ? new Date(job.deadline) : null,
      status: job.status,
      featured: job.featured,
      sample: job.sample,
    });
  }

  return { categories: categoryRows, authors: authorRows, articles: articleRows, jobs: jobRows, skippedSamples };
}
