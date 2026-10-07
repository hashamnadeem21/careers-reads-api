/**
 * Copies the public site's file content into the database. Safe to run again: every row is upserted.
 *
 *   npm run db:import                        articles, authors, categories, real jobs
 *   npm run db:import -- --include-samples   also import `sample: true` jobs (development only)
 *
 * Reads the website's files from BLOGNEST_DIR (default ../blognest) and writes to DATABASE_URL.
 */
import path from "node:path";
import { config } from "dotenv";
import { connectDb } from "../src/db/client.js";
import { importContent } from "../src/import/import-content.js";

config({ path: [".env.local", ".env"], quiet: true });

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set (see .env.example).");
  process.exit(1);
}
const connection = connectDb(process.env.DATABASE_URL);
const siteDir = path.resolve(process.env.BLOGNEST_DIR ?? "../blognest");
const includeSamples = process.argv.includes("--include-samples");

importContent(connection.db, siteDir, includeSamples)
  .then((n) => {
    console.log(`Imported from ${siteDir}:`);
    console.log(`  ${n.categories} categories`);
    console.log(`  ${n.authors} authors`);
    console.log(`  ${n.articles} articles (${n.images} in-post images)`);
    console.log(`  ${n.media} existing images registered in the media library`);
    console.log(`  ${n.jobs} jobs (${n.skippedSamples} sample jobs ${includeSamples ? "included" : "skipped"})`);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => connection.end());
