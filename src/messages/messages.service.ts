import { HttpStatus, Injectable } from "@nestjs/common";
import { asc, count, desc, eq, getTableColumns, inArray, isNull } from "drizzle-orm";
import type { AuthUser } from "../auth/auth-user.js";
import { ApiError } from "../common/api-error.js";
import { AuditService } from "../common/audit.service.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { type MessageRow, messages, subscribers } from "../db/schema.js";

/** Neutralises spreadsheet formulas (CSV injection) and quotes every field. */
export function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

const { unsubscribeToken: _token, ...subscriberColumns } = getTableColumns(subscribers);

/** The contact form inbox and newsletter subscribers. Staff only. */
@Injectable()
export class MessagesService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  private async counts() {
    const [[{ unread }], [{ subscribers: subs }]] = await Promise.all([
      this.db.select({ unread: count() }).from(messages).where(eq(messages.read, false)),
      this.db.select({ subscribers: count() }).from(subscribers).where(isNull(subscribers.unsubscribedAt)),
    ]);
    return { unread, subscribers: subs };
  }

  /** The newest 200 messages, plus the unread and subscriber counts for the tabs. */
  async listMessages() {
    const [items, counts] = await Promise.all([
      this.db.select().from(messages).orderBy(desc(messages.createdAt)).limit(200),
      this.counts(),
    ]);
    return { items, ...counts };
  }

  /** The newest 500 subscribers (never their unsubscribe tokens), plus the counts for the tabs. */
  async listSubscribers() {
    const [items, counts] = await Promise.all([
      this.db.select(subscriberColumns).from(subscribers).orderBy(desc(subscribers.createdAt)).limit(500),
      this.counts(),
    ]);
    return { items, ...counts };
  }

  async setRead(id: number, read: boolean): Promise<MessageRow> {
    const [row] = await this.db.update(messages).set({ read }).where(eq(messages.id, id)).returning();
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, "not_found", "This message was deleted.");
    return row;
  }

  async removeMessage(user: AuthUser, id: number): Promise<void> {
    const [row] = await this.db.delete(messages).where(eq(messages.id, id)).returning();
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, "not_found", "Already deleted.");
    await this.audit.log(user, "deleted", "message", null, `message from ${row.name}`);
  }

  async removeSubscribers(user: AuthUser, ids: number[]): Promise<{ message: string; removed: number }> {
    const rows = await this.db.delete(subscribers).where(inArray(subscribers.id, ids)).returning();
    const label = `${rows.length} subscriber${rows.length === 1 ? "" : "s"}`;
    await this.audit.log(user, "removed", "subscriber", null, label);
    return { message: `${label} removed.`, removed: rows.length };
  }

  /**
   * Every subscriber, oldest first: email, status, subscribed_at, unsubscribed_at. Unsubscribed
   * people stay in the file (marked) so an import elsewhere can respect their choice.
   */
  async subscribersCsv(): Promise<string> {
    const rows = await this.db.select(subscriberColumns).from(subscribers).orderBy(asc(subscribers.createdAt));
    const lines = [
      ["email", "status", "subscribed_at", "unsubscribed_at"].join(","),
      ...rows.map((r) =>
        [
          csvField(r.email),
          r.unsubscribedAt ? "unsubscribed" : "subscribed",
          r.createdAt.toISOString(),
          r.unsubscribedAt?.toISOString() ?? "",
        ].join(","),
      ),
    ];
    return `${lines.join("\n")}\n`;
  }
}
