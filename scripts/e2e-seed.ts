/**
 * Test-only: prepares a database for the admin's Playwright suite. Migrates, empties every table,
 * imports the website's content and creates the QA companies and accounts it describes.
 *
 *   DATABASE_URL=postgres://…/blognest_test E2E_SEED='{"companies":{…},"users":{…}}' npm run e2e:seed
 *
 * Refuses any database whose name doesn't end in "_test", and Neon.
 */
import path from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { z } from "zod";
import { hashPassword } from "../src/auth/password.js";
import { connectDb } from "../src/db/client.js";
import { companies, users } from "../src/db/schema.js";
import { importContent } from "../src/import/import-content.js";

const seedSchema = z.object({
  companies: z.record(
    z.string(),
    z.object({ name: z.string(), website: z.url().nullable(), autoPublish: z.boolean() }),
  ),
  users: z.record(
    z.string(),
    z.object({
      email: z.email(),
      name: z.string(),
      role: z.enum(["super_admin", "editor", "company"]),
      password: z.string().min(12),
      company: z.string().nullable(),
    }),
  ),
});

const url = process.env.DATABASE_URL ?? "";
if (/neon\.tech/.test(url) || !/_test(\?|$)/.test(url)) {
  console.error("e2e:seed only runs against a local database whose name ends in _test.");
  process.exit(1);
}
const seed = seedSchema.parse(JSON.parse(process.env.E2E_SEED ?? "{}"));
const connection = connectDb(url);
const { db } = connection;

async function main() {
  await migrate(db, { migrationsFolder: path.join(import.meta.dirname, "../src/db/migrations") });
  const tables = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
  );
  await db.execute(
    sql.raw(`truncate ${tables.rows.map((t) => `"${t.tablename}"`).join(", ")} restart identity cascade`),
  );
  const imported = await importContent(db, path.resolve(process.env.BLOGNEST_DIR ?? "../blognest"));

  const companyIds: Record<string, string> = {};
  for (const [key, company] of Object.entries(seed.companies)) {
    const [row] = await db.insert(companies).values(company).returning();
    companyIds[key] = row.id;
  }
  for (const user of Object.values(seed.users)) {
    await db.insert(users).values({
      email: user.email,
      name: user.name,
      role: user.role,
      companyId: user.company ? companyIds[user.company] : null,
      passwordHash: await hashPassword(user.password),
      mustChangePassword: false,
    });
  }
  console.log(
    `e2e database ready: ${imported.articles} articles, ${imported.categories} categories, ${Object.keys(seed.users).length} QA users`,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => connection.end());
