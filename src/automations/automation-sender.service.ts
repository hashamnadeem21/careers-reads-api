import { createHash } from "node:crypto";
import { type BeforeApplicationShutdown, Injectable, Logger } from "@nestjs/common";
import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { automationDeliveries, emailAutomations, subscribers } from "../db/schema.js";
import { MAX_BATCH, MailerService } from "../mail/mailer.service.js";
import { composeEmail } from "../newsletters/compose.js";

/** Failed emails are tried this many times in total, this far apart. */
export const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 15 * 60_000;
/** A run holds the rows it's sending this long; after a crash, another run can pick them up. */
const LOCK_MS = 5 * 60_000;
/** A welcome email days late is worse than none (e.g. sending was off for a while). */
export const STALE_AFTER_MS = 3 * 86_400_000;
/** Up to 1,000 emails per run; the rest wait for the next minute. */
const MAX_ROUNDS = 10;
const BATCH_PAUSE_MS = 600;

export interface SendSummary {
  sent: number;
  failed: number;
  retrying: number;
  skipped: number;
}

interface Claimed {
  id: number;
  attempts: number;
  dueAt: Date;
  email: string;
  token: string;
  unsubscribedAt: Date | null;
  active: boolean;
  subject: string;
  previewText: string;
  body: string;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends queued automation emails once they're due (called by the scheduler every minute).
 * Rows are claimed with `for update skip locked` plus a short lock, so overlapping runs and
 * multiple API instances never send the same email twice.
 */
@Injectable()
export class AutomationSender implements BeforeApplicationShutdown {
  private readonly logger = new Logger("Automations");
  private stopping = false;

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly mailer: MailerService,
  ) {}

  beforeApplicationShutdown(): void {
    this.stopping = true;
  }

  async sendDue(now = new Date()): Promise<SendSummary> {
    const summary: SendSummary = { sent: 0, failed: 0, retrying: 0, skipped: 0 };
    if (this.mailer.missingConfig()) return summary;
    for (let round = 0; round < MAX_ROUNDS && !this.stopping; round++) {
      const claimed = await this.claim(now);
      if (claimed.length === 0) break;
      await this.process(claimed, now, summary);
      if (claimed.length < MAX_BATCH) break;
      await pause(BATCH_PAUSE_MS);
    }
    return summary;
  }

  /** Locks the next due batch for this run and returns what's needed to send it. */
  private async claim(now: Date): Promise<Claimed[]> {
    const at = now.toISOString();
    const { rows } = await this.db.execute<{ id: number }>(sql`
      with due as (
        select ${automationDeliveries.id} as id from ${automationDeliveries}
        where ${automationDeliveries.status} = 'pending'
          and ${automationDeliveries.dueAt} <= ${at}::timestamptz
          and (${automationDeliveries.lockedUntil} is null or ${automationDeliveries.lockedUntil} < ${at}::timestamptz)
        order by ${automationDeliveries.dueAt}
        limit ${MAX_BATCH}
        for update skip locked
      )
      update ${automationDeliveries}
      set locked_until = ${new Date(now.getTime() + LOCK_MS).toISOString()}::timestamptz, attempts = attempts + 1
      from due where ${automationDeliveries.id} = due.id
      returning ${automationDeliveries.id}`);
    if (rows.length === 0) return [];
    return this.db
      .select({
        id: automationDeliveries.id,
        attempts: automationDeliveries.attempts,
        dueAt: automationDeliveries.dueAt,
        email: subscribers.email,
        token: subscribers.unsubscribeToken,
        unsubscribedAt: subscribers.unsubscribedAt,
        active: emailAutomations.active,
        subject: emailAutomations.subject,
        previewText: emailAutomations.previewText,
        body: emailAutomations.body,
      })
      .from(automationDeliveries)
      .innerJoin(subscribers, eq(subscribers.id, automationDeliveries.subscriberId))
      .innerJoin(emailAutomations, eq(emailAutomations.id, automationDeliveries.automationId))
      .where(inArray(automationDeliveries.id, rows.map((row) => Number(row.id))))
      .orderBy(automationDeliveries.id);
  }

  private async process(claimed: Claimed[], now: Date, summary: SendSummary): Promise<void> {
    const toSend: Claimed[] = [];
    for (const row of claimed) {
      const reason = row.unsubscribedAt
        ? "They unsubscribed"
        : !row.active
          ? "The automation was switched off"
          : now.getTime() - row.dueAt.getTime() > STALE_AFTER_MS
            ? "More than 3 days late (email sending was off), so it was skipped"
            : null;
      if (reason) {
        await this.finish([row.id], { status: "skipped", error: reason });
        summary.skipped++;
      } else toSend.push(row);
    }
    if (toSend.length === 0) return;

    const emails = toSend.map((row) => composeEmail(row, row.email, row.token));
    const key = `automation-${createHash("sha256")
      .update(toSend.map((row) => `${row.id}:${row.attempts}`).join(","))
      .digest("hex")}`;
    const result = await this.mailer.sendBatch(emails, key);
    if (result.ok) {
      await this.finish(toSend.map((row) => row.id), { status: "sent", sentAt: now, error: null });
      summary.sent += toSend.length;
      return;
    }
    if (toSend.length === 1) {
      await this.failed(toSend[0], result.error, now, summary);
      return;
    }
    // Resend rejects a whole batch for one bad address: send one by one so the rest still go.
    for (const [i, row] of toSend.entries()) {
      if (i > 0) await pause(BATCH_PAUSE_MS);
      const single = await this.mailer.sendBatch([emails[i]], `automation-delivery-${row.id}-${row.attempts}`);
      if (single.ok) {
        await this.finish([row.id], { status: "sent", sentAt: now, error: null });
        summary.sent++;
      } else await this.failed(row, single.error, now, summary);
    }
  }

  /** Tries again in 15 minutes, up to 3 tries in total. */
  private async failed(row: Claimed, error: string, now: Date, summary: SendSummary): Promise<void> {
    if (row.attempts >= MAX_ATTEMPTS) {
      await this.finish([row.id], { status: "failed", error });
      summary.failed++;
      this.logger.warn(`Automation email ${row.id} failed for good: ${error}`);
    } else {
      await this.finish([row.id], { error, dueAt: new Date(now.getTime() + RETRY_AFTER_MS) });
      summary.retrying++;
    }
  }

  private finish(ids: number[], set: Partial<typeof automationDeliveries.$inferInsert>) {
    return this.db
      .update(automationDeliveries)
      .set({ ...set, lockedUntil: null })
      .where(inArray(automationDeliveries.id, ids));
  }
}
