import { neonConfig, Pool as NeonPool } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import ws from "ws";
import * as schema from "./schema.js";

export { schema };

/**
 * Both drivers expose the same Drizzle query builder; we type the client as the
 * node-postgres flavour so callers don't care which one is underneath.
 */
export type Database = NodePgDatabase<typeof schema>;

export interface DbConnection {
  db: Database;
  end: () => Promise<void>;
}

/** Neon in production (WebSocket pool, supports transactions); plain Postgres everywhere else. */
export function connectDb(url: string): DbConnection {
  if (/\.neon\.tech[:/]/.test(url)) {
    neonConfig.webSocketConstructor = ws;
    const pool = new NeonPool({ connectionString: url });
    return { db: drizzleNeon(pool, { schema }) as unknown as Database, end: () => pool.end() };
  }
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return { db: drizzleNodePg(pool, { schema }), end: () => pool.end() };
}
