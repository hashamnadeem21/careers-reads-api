import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { newsletterDeliveries, newsletters, subscribers } from "../db/schema.js";
import { MAX_BATCH, MailerService } from "../mail/mailer.service.js";
import { composeEmail } from "./compose.js";

/** Resend's default limit is 2 requests a second; full batches pause between calls. */
const BATCH_PAUSE_MS = 600;

/** Brings a newsletter's counters in step with its delivery rows. */
export function refreshCounts(db: Database, id: number) {
  const tally = (status?: "sent" | "failed") =>
    sql`(select count(*)::int from ${newsletterDeliveries} where ${newsletterDeliveries.newsletterId} = ${id}${
      status ? sql` and ${newsletterDeliveries.status} = ${status}` : sql``
    })`;
  return db
    .update(newsletters)
    .set({ recipients: tally(), sentCount: tally("sent"), failedCount: tally("failed") })
    .where(eq(newsletters.id, id));
}

/**
 * Delivers newsletters in the background, 100 emails per call. Each subscriber's delivery row
 * moves pending → sent/failed, so a send interrupted by a restart picks up where it stopped
 * (on boot) without emailing anyone twice. Assumes one API instance sends at a time.
 */
@Injectable()
export class NewsletterSender implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger("Newsletters");
  private readonly running = new Map<number, Promise<void>>();
  private stopping = false;

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly mailer: MailerService,
  ) {}

  /** Resumes sends a restart interrupted. */
  async onApplicationBootstrap(): Promise<void> {
    if (this.mailer.missingConfig()) return;
    const unfinished = await this.db
      .select({ id: newsletters.id })
      .from(newsletters)
      .where(eq(newsletters.status, "sending"));
    for (const { id } of unfinished) this.start(id);
  }

  /** Lets batches in flight finish recording their results before the database closes. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled(this.running.values());
  }

  /** Starts delivering a newsletter in the background (no-op if it's already going). */
  start(id: number): void {
    if (this.running.has(id)) return;
    const run = this.deliver(id)
      .catch((error: unknown) => {
        this.logger.error(`Newsletter ${id} stopped: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => this.running.delete(id));
    this.running.set(id, run);
  }

  /** Resolves when the newsletter's background send has finished (immediately if none). */
  async settled(id: number): Promise<void> {
    await this.running.get(id);
  }

  private async deliver(id: number): Promise<void> {
    const [newsletter] = await this.db.select().from(newsletters).where(eq(newsletters.id, id)).limit(1);
    if (newsletter?.status !== "sending") return;

    while (!this.stopping) {
      const batch = await this.db
        .select({
          subscriberId: newsletterDeliveries.subscriberId,
          email: subscribers.email,
          token: subscribers.unsubscribeToken,
        })
        .from(newsletterDeliveries)
        .innerJoin(subscribers, eq(subscribers.id, newsletterDeliveries.subscriberId))
        .where(
          and(
            eq(newsletterDeliveries.newsletterId, id),
            eq(newsletterDeliveries.status, "pending"),
            sql`${subscribers.unsubscribedAt} is null`,
          ),
        )
        .orderBy(asc(newsletterDeliveries.subscriberId))
        .limit(MAX_BATCH);
      if (batch.length === 0) break;

      const ids = batch.map((row) => row.subscriberId);
      // Same key for the same batch of the same send attempt, so a resumed call can't double-send.
      const key = `newsletter-${id}-${newsletter.updatedAt.getTime()}-${ids[0]}-${ids.at(-1)}`;
      const result = await this.mailer.sendBatch(
        batch.map((row) => composeEmail(newsletter, row.email, row.token)),
        key,
      );
      await this.db
        .update(newsletterDeliveries)
        .set(result.ok ? { status: "sent", sentAt: new Date(), error: null } : { status: "failed", error: result.error })
        .where(and(eq(newsletterDeliveries.newsletterId, id), inArray(newsletterDeliveries.subscriberId, ids)));
      await refreshCounts(this.db, id);
      if (batch.length === MAX_BATCH) await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
    }
    if (this.stopping) return;

    // Whoever is still pending unsubscribed after the send started: they're left out.
    await this.db
      .delete(newsletterDeliveries)
      .where(and(eq(newsletterDeliveries.newsletterId, id), eq(newsletterDeliveries.status, "pending")));
    await refreshCounts(this.db, id);
    await this.db
      .update(newsletters)
      .set({ status: "sent", sentAt: new Date() })
      .where(and(eq(newsletters.id, id), eq(newsletters.status, "sending")));
    this.logger.log(`Newsletter ${id} finished sending.`);
  }
}
