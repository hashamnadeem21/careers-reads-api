import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getTableColumns, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { imageSize } from "image-size";
import type { Database } from "../db/client.js";
import { articles, authors, categories, jobs, media } from "../db/schema.js";
import { buildImportPlan } from "./import-plan.js";

async function readDir(dir: string, ext: RegExp): Promise<{ name: string; source: string }[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => ext.test(f)).sort();
  } catch {
    return [];
  }
  return Promise.all(names.map(async (name) => ({ name, source: await readFile(path.join(dir, name), "utf8") })));
}

/** `excluded.<column>` for every column except the key, so upserts overwrite. */
function excludedSet(table: PgTable, skip: string[]) {
  return Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([key]) => !skip.includes(key))
      .map(([key, col]) => [key, sql.raw(`excluded."${col.name}"`)]),
  );
}

export interface ImportSummary {
  categories: number;
  authors: number;
  articles: number;
  images: number;
  media: number;
  jobs: number;
  skippedSamples: number;
}

/**
 * Copies the website's `content/` files into the database (every row is upserted, so it's safe
 * to run again) and registers the images they use in the media library.
 */
export async function importContent(db: Database, siteDir: string, includeSamples = false): Promise<ImportSummary> {
  const contentDir = path.join(siteDir, "content");
  const plan = buildImportPlan({
    articleFiles: await readDir(path.join(contentDir, "articles"), /\.mdx?$/),
    authorFiles: await readDir(path.join(contentDir, "authors"), /\.json$/),
    jobFiles: await readDir(path.join(contentDir, "jobs"), /\.json$/),
    includeSamples,
  });

  await db.transaction(async (tx) => {
    if (plan.categories.length) {
      await tx
        .insert(categories)
        .values(plan.categories)
        .onConflictDoUpdate({ target: categories.slug, set: excludedSet(categories, ["slug"]) });
    }
    if (plan.authors.length) {
      await tx
        .insert(authors)
        .values(plan.authors)
        .onConflictDoUpdate({ target: authors.slug, set: excludedSet(authors, ["slug"]) });
    }
    if (plan.articles.length) {
      await tx
        .insert(articles)
        .values(plan.articles)
        .onConflictDoUpdate({ target: articles.slug, set: excludedSet(articles, ["slug", "createdAt", "createdBy"]) });
    }
    if (plan.jobs.length) {
      await tx
        .insert(jobs)
        .values(plan.jobs)
        .onConflictDoUpdate({ target: jobs.slug, set: excludedSet(jobs, ["slug", "createdAt", "createdBy"]) });
    }
  });

  const referenced = new Set<string>();
  for (const a of plan.articles) {
    referenced.add(a.coverImage);
    for (const img of a.images ?? []) referenced.add(img.src);
  }
  for (const a of plan.authors) referenced.add(a.avatar);
  const mediaRows = [...referenced]
    .filter((url) => url.startsWith("/"))
    .map((url) => {
      const file = path.join(siteDir, "public", url);
      if (!existsSync(file)) return null;
      try {
        const size = imageSize(readFileSync(file));
        return { url, alt: "", width: size.width ?? 1600, height: size.height ?? 900, sizeBytes: statSync(file).size };
      } catch {
        return null;
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (mediaRows.length) await db.insert(media).values(mediaRows).onConflictDoNothing({ target: media.url });

  return {
    categories: plan.categories.length,
    authors: plan.authors.length,
    articles: plan.articles.length,
    images: plan.articles.reduce((n, a) => n + (a.images?.length ?? 0), 0),
    media: mediaRows.length,
    jobs: plan.jobs.length,
    skippedSamples: plan.skippedSamples,
  };
}
