import { Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { subscribers } from "../db/schema.js";

const token = z.uuid();

/** Looks subscribers up by the secret token in their unsubscribe link. */
@Injectable()
export class SubscriptionsService {
  constructor(@InjectDb() private readonly db: Database) {}

  /** The subscriber behind a link, or null for a malformed or unknown token. */
  async findByToken(value: string): Promise<{ email: string; unsubscribed: boolean } | null> {
    if (!token.safeParse(value).success) return null;
    const [row] = await this.db
      .select({ email: subscribers.email, unsubscribedAt: subscribers.unsubscribedAt })
      .from(subscribers)
      .where(eq(subscribers.unsubscribeToken, value))
      .limit(1);
    return row ? { email: row.email, unsubscribed: row.unsubscribedAt !== null } : null;
  }

  /** Stops their newsletters. Safe to repeat. Returns false for an unknown token. */
  async unsubscribe(value: string): Promise<boolean> {
    if (!(await this.findByToken(value))) return false;
    await this.db
      .update(subscribers)
      .set({ unsubscribedAt: new Date() })
      .where(and(eq(subscribers.unsubscribeToken, value), isNull(subscribers.unsubscribedAt)));
    return true;
  }
}
