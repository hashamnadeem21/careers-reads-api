import { createHash } from "node:crypto";
import { HttpStatus, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { ApiError } from "./api-error.js";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

/** Rate-limit keys never contain raw IPs or emails. */
export function limitKey(scope: string, value: string): string {
  return `${scope}:${createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0, 32)}`;
}

/**
 * Fixed-window rate limit stored in Postgres, so it holds across instances.
 * One atomic upsert per call.
 */
@Injectable()
export class RateLimitService {
  constructor(@InjectDb() private readonly db: Database) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const result = await this.db.execute<{ count: number; window_start: Date | string }>(sql`
      insert into rate_limits (key, count, window_start) values (${key}, 1, now())
      on conflict (key) do update set
        count = case when rate_limits.window_start <= now() - make_interval(secs => ${windowSeconds}) then 1 else rate_limits.count + 1 end,
        window_start = case when rate_limits.window_start <= now() - make_interval(secs => ${windowSeconds}) then now() else rate_limits.window_start end
      returning count, window_start
    `);
    const row = result.rows[0];
    const count = Number(row.count);
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetAt: new Date(new Date(row.window_start).getTime() + windowSeconds * 1000),
    };
  }

  /** Like `hit`, but throws a 429 with `message` when the limit is exceeded. */
  async enforce(key: string, limit: number, windowSeconds: number, message: string): Promise<void> {
    const result = await this.hit(key, limit, windowSeconds);
    if (!result.allowed) throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, "rate_limited", message);
  }

  async clear(key: string): Promise<void> {
    await this.db.execute(sql`delete from rate_limits where key = ${key}`);
  }
}
