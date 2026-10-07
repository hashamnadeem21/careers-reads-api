import path from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { connectDb, type DbConnection } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";

/** Separate database for tests: never the dev or production one. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:54329/blognest_test";

export const TEST_JWT_SECRET = "test-jwt-secret-0123456789abcdef0123456789abcdef";
export const TEST_ADMIN_API_KEY = "test-admin-key-0123456789abcdef0123456789abcdef";

const TABLES = [
  "sessions",
  "invites",
  "user_prefs",
  "audit_log",
  "daily_stats",
  "rate_limits",
  "media",
  "messages",
  "subscribers",
  "settings",
  "articles",
  "jobs",
  "authors",
  "categories",
  "users",
  "companies",
];

/** Points the app at the test database and applies migrations. Close the returned connection in afterAll. */
export async function connectTestDb(): Promise<DbConnection> {
  if (/neon\.tech/.test(TEST_DATABASE_URL)) throw new Error("Tests must not run against Neon.");
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
  process.env.REVALIDATE_SECRET = "";
  resetEnvCache();
  const connection = connectDb(TEST_DATABASE_URL);
  await migrate(connection.db, { migrationsFolder: path.join(process.cwd(), "src/db/migrations") });
  return connection;
}

export async function resetTestDb({ db }: DbConnection): Promise<void> {
  await db.execute(sql.raw(`truncate ${TABLES.map((t) => `"${t}"`).join(", ")} restart identity cascade`));
}
