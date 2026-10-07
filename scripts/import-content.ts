/**
 * Copies the public site's file content into the database. Safe to run again: every row is upserted.
 *
 *   npm run db:import                        articles, authors, categories, real jobs
 *   npm run db:import -- --include-samples   also import `sample: true` jobs (development only)
 *
 * Reads the website's files from BLOGNEST_DIR (default ../blognest) and writes to DATABASE_URL.
 */
import { config } from "dotenv";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getTableColumns, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { connectDb } from "../src/db/client.js";
import { existsSync, statSync, readFileSync } from "node:fs";
import { imageSize } from "image-size";
import { articles, authors, categories, jobs, media } from "../src/db/schema.js";
import { buildImportPlan } from "../src/import/import-plan.js";

config({ path: [".env.local", ".env"], quiet: true });

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set (see .env.example).");
  process.exit(1);
}
const connection = connectDb(process.env.DATABASE_URL);

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

async function main() {
  const siteDir = path.resolve(process.env.BLOGNEST_DIR ?? "../blognest");
  const includeSamples = process.argv.includes("--include-samples");
  const contentDir = path.join(siteDir, "content");

  const plan = buildImportPlan({
    articleFiles: await readDir(path.join(contentDir, "articles"), /\.mdx?$/),
    authorFiles: await readDir(path.join(contentDir, "authors"), /\.json$/),
    jobFiles: await readDir(path.join(contentDir, "jobs"), /\.json$/),
    includeSamples,
  });

  const { db } = connection;
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
        .onConflictDoUpdate({
          target: articles.slug,
          set: excludedSet(articles, ["slug", "createdAt", "createdBy"]),
        });
    }
    if (plan.jobs.length) {
      await tx
        .insert(jobs)
        .values(plan.jobs)
        .onConflictDoUpdate({ target: jobs.slug, set: excludedSet(jobs, ["slug", "createdAt", "createdBy"]) });
    }
  });

  // Register every image the content already uses, so it shows in the media library.
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

  const images = plan.articles.reduce((n, a) => n + (a.images?.length ?? 0), 0);
  console.log(`Imported from ${siteDir}:`);
  console.log(`  ${plan.categories.length} categories`);
  console.log(`  ${plan.authors.length} authors`);
  console.log(`  ${plan.articles.length} articles (${images} in-post images)`);
  console.log(`  ${mediaRows.length} existing images registered in the media library`);
  console.log(`  ${plan.jobs.length} jobs (${plan.skippedSamples} sample jobs ${includeSamples ? "included" : "skipped"})`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => connection.end());
