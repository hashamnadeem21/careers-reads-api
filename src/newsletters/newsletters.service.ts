import { HttpStatus, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, getTableColumns, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { AuthUser } from "../auth/auth-user.js";
import { ApiError } from "../common/api-error.js";
import { AuditService } from "../common/audit.service.js";
import { limitKey, RateLimitService } from "../common/rate-limit.service.js";
import { FORM_ERROR } from "../common/zod.js";
import type { Database, Tx } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { newsletterDeliveries, newsletters, type NewsletterRow, subscribers } from "../db/schema.js";
import { MailerService } from "../mail/mailer.service.js";
import { type Audience, audienceWhere } from "./audience.js";
import { composeEmail, previewEmail } from "./compose.js";
import { NewsletterSender } from "./newsletter-sender.service.js";
import type { NewsletterBody, ScheduleBody } from "./newsletters.schemas.js";

const notFound = (message = "This newsletter no longer exists.") =>
  new ApiError(HttpStatus.NOT_FOUND, "not_found", message);

const { body: _body, ...listColumns } = getTableColumns(newsletters);

/** Drafts and scheduled newsletters can still be edited, tested, sent or (re)scheduled. */
const EDITABLE = ["draft", "scheduled"] as const;

const DAY_MS = 86_400_000;

/** Newsletters: drafts any staff member can write; sending and scheduling are for super admins. */
@Injectable()
export class NewslettersService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
    private readonly mailer: MailerService,
    private readonly sender: NewsletterSender,
  ) {}

  /** Subscribers a newsletter sent now would reach. */
  async activeSubscribers(): Promise<number> {
    const [{ n }] = await this.db.select({ n: count() }).from(subscribers).where(isNull(subscribers.unsubscribedAt));
    return n;
  }

  /** Active subscribers in an audience (the send and schedule dialogs show this). */
  async audienceSize(audience: Audience): Promise<{ count: number }> {
    const [{ n }] = await this.db.select({ n: count() }).from(subscribers).where(audienceWhere(audience));
    return { count: n };
  }

  /** Newest first, without bodies, plus who a send would reach and whether sending is set up. */
  async list() {
    const [items, activeSubscribers] = await Promise.all([
      this.db.select(listColumns).from(newsletters).orderBy(desc(newsletters.createdAt)).limit(200),
      this.activeSubscribers(),
    ]);
    return { items, activeSubscribers, sendingReady: this.mailer.missingConfig() === null };
  }

  async get(id: number) {
    const [row] = await this.db.select().from(newsletters).where(eq(newsletters.id, id)).limit(1);
    if (!row) throw notFound();
    const [activeSubscribers, failures] = await Promise.all([this.activeSubscribers(), this.failures(id)]);
    return { newsletter: row, activeSubscribers, sendingReady: this.mailer.missingConfig() === null, failures };
  }

  /** The most common delivery errors, so the admin can see why some emails didn't go out. */
  private failures(id: number) {
    return this.db
      .select({ error: newsletterDeliveries.error, count: count() })
      .from(newsletterDeliveries)
      .where(and(eq(newsletterDeliveries.newsletterId, id), eq(newsletterDeliveries.status, "failed")))
      .groupBy(newsletterDeliveries.error)
      .orderBy(desc(count()))
      .limit(5);
  }

  private async getEditable(id: number): Promise<NewsletterRow> {
    const [row] = await this.db.select().from(newsletters).where(eq(newsletters.id, id)).limit(1);
    if (!row) throw notFound();
    if (row.status !== "draft" && row.status !== "scheduled") {
      throw new ApiError(HttpStatus.CONFLICT, "already_sent", "This newsletter has been sent and can't be changed.");
    }
    return row;
  }

  async create(user: AuthUser, input: NewsletterBody): Promise<{ message: string; newsletter: NewsletterRow }> {
    const [newsletter] = await this.db
      .insert(newsletters)
      .values({ ...input, createdBy: user.id })
      .returning();
    await this.audit.log(user, "created", "newsletter", String(newsletter.id), newsletter.subject);
    return { message: "Draft saved.", newsletter };
  }

  async update(user: AuthUser, id: number, input: NewsletterBody): Promise<{ message: string; newsletter: NewsletterRow }> {
    await this.getEditable(id);
    const [newsletter] = await this.db
      .update(newsletters)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(newsletters.id, id), inArray(newsletters.status, EDITABLE)))
      .returning();
    if (!newsletter) throw new ApiError(HttpStatus.CONFLICT, "already_sent", "This newsletter was just sent.");
    await this.audit.log(user, "updated", "newsletter", String(id), newsletter.subject);
    return { message: newsletter.status === "scheduled" ? "Changes saved. It goes out as scheduled." : "Draft saved.", newsletter };
  }

  /** Drafts and sent newsletters can go; one that's sending can't. */
  async remove(user: AuthUser, id: number): Promise<void> {
    const [row] = await this.db
      .delete(newsletters)
      .where(and(eq(newsletters.id, id), sql`${newsletters.status} <> 'sending'`))
      .returning();
    if (!row) {
      const [exists] = await this.db.select({ id: newsletters.id }).from(newsletters).where(eq(newsletters.id, id));
      throw exists
        ? new ApiError(HttpStatus.CONFLICT, "sending", "Wait until it has finished sending.")
        : notFound("Already deleted.");
    }
    await this.audit.log(user, "deleted", "newsletter", String(id), row.subject);
  }

  /** The email as subscribers will see it (for the editor's live preview). */
  preview(input: NewsletterBody): { html: string } {
    return previewEmail(input);
  }

  /** Sends the saved draft to one address, subject marked [Test]. 10 per user per 10 minutes. */
  async sendTest(user: AuthUser, id: number, email = user.email): Promise<{ message: string }> {
    const newsletter = await this.getEditable(id);
    this.assertReady(newsletter);
    await this.rateLimit.enforce(
      limitKey("newsletter-test", user.id),
      10,
      600,
      "Too many test emails. Try again in a few minutes.",
    );
    const copy = composeEmail({ ...newsletter, subject: `[Test] ${newsletter.subject}` }, email, "test");
    const result = await this.mailer.sendBatch([copy]);
    if (!result.ok) throw new ApiError(HttpStatus.BAD_GATEWAY, "send_failed", result.error);
    return { message: `Test sent to ${email}.` };
  }

  /**
   * Sends now to the audience. Claims the newsletter (so a double click sends once), records one
   * pending delivery per subscriber, then the sender delivers in the background.
   */
  async send(user: AuthUser, id: number, audience: Audience): Promise<{ message: string; newsletter: NewsletterRow }> {
    this.assertReady(await this.getEditable(id));
    const newsletter = await this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(newsletters)
        .set({
          status: "sending",
          sentBy: user.id,
          scheduledAt: null,
          audienceFrom: audience.from,
          audienceTo: audience.to,
          updatedAt: new Date(),
        })
        .where(and(eq(newsletters.id, id), inArray(newsletters.status, EDITABLE)))
        .returning();
      if (!claimed) throw new ApiError(HttpStatus.CONFLICT, "already_sent", "This newsletter was just sent.");
      const row = await this.queueDeliveries(tx, claimed);
      if (row.recipients === 0) {
        throw new ApiError(HttpStatus.CONFLICT, "no_subscribers", "There are no subscribers in this audience yet.");
      }
      return row;
    });
    await this.audit.log(user, "sent", "newsletter", String(id), newsletter.subject);
    this.sender.start(id);
    const people = `${newsletter.recipients} subscriber${newsletter.recipients === 1 ? "" : "s"}`;
    return { message: `Sending to ${people}. This page updates as it goes.`, newsletter };
  }

  /** Sends it automatically at `sendAt` (at least a minute ahead, at most a year). Rescheduling is fine. */
  async schedule(
    user: AuthUser,
    id: number,
    { sendAt, audience }: ScheduleBody,
    now = new Date(),
  ): Promise<{ message: string; newsletter: NewsletterRow }> {
    this.assertReady(await this.getEditable(id));
    const wait = sendAt.getTime() - now.getTime();
    if (wait < 60_000 || wait > 366 * DAY_MS) {
      throw new ApiError(HttpStatus.BAD_REQUEST, "validation_failed", FORM_ERROR, {
        sendAt: wait < 60_000 ? "Pick a time at least a minute from now" : "Pick a time within the next year",
      });
    }
    const [newsletter] = await this.db
      .update(newsletters)
      .set({
        status: "scheduled",
        scheduledAt: sendAt,
        audienceFrom: audience.from,
        audienceTo: audience.to,
        sentBy: user.id,
        updatedAt: new Date(),
      })
      .where(and(eq(newsletters.id, id), inArray(newsletters.status, EDITABLE)))
      .returning();
    if (!newsletter) throw new ApiError(HttpStatus.CONFLICT, "already_sent", "This newsletter was just sent.");
    await this.audit.log(user, "scheduled", "newsletter", String(id), newsletter.subject);
    return { message: "Scheduled. It goes out automatically at that time.", newsletter };
  }

  /** Takes a scheduled newsletter back to a draft. */
  async unschedule(user: AuthUser, id: number): Promise<{ message: string; newsletter: NewsletterRow }> {
    const [newsletter] = await this.db
      .update(newsletters)
      .set({ status: "draft", scheduledAt: null, sentBy: null, updatedAt: new Date() })
      .where(and(eq(newsletters.id, id), eq(newsletters.status, "scheduled")))
      .returning();
    if (!newsletter) {
      await this.getEditable(id); // 404, or 409 when it has started sending
      throw new ApiError(HttpStatus.CONFLICT, "not_scheduled", "This newsletter isn't scheduled.");
    }
    await this.audit.log(user, "unscheduled", "newsletter", String(id), newsletter.subject);
    return { message: "Unscheduled. It's a draft again.", newsletter };
  }

  /**
   * For the scheduler: starts every scheduled newsletter whose time has come and returns their ids.
   * Each is claimed in its own transaction, so two runs (or API instances) can't both start it.
   */
  async startDue(now = new Date()): Promise<number[]> {
    if (this.mailer.missingConfig()) return [];
    const due = await this.db
      .select({ id: newsletters.id })
      .from(newsletters)
      .where(and(eq(newsletters.status, "scheduled"), lte(newsletters.scheduledAt, now)))
      .orderBy(asc(newsletters.scheduledAt))
      .limit(20);
    const started: number[] = [];
    for (const { id } of due) {
      const newsletter = await this.db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(newsletters)
          .set({ status: "sending", updatedAt: new Date() })
          .where(and(eq(newsletters.id, id), eq(newsletters.status, "scheduled"), lte(newsletters.scheduledAt, now)))
          .returning();
        return claimed ? this.queueDeliveries(tx, claimed) : null;
      });
      if (!newsletter) continue;
      // Nobody in the audience: the sender finds nothing to do and marks it sent (0 recipients).
      this.sender.start(id);
      started.push(id);
    }
    return started;
  }

  /** One pending delivery per active subscriber in the newsletter's audience; returns it with `recipients` set. */
  private async queueDeliveries(tx: Tx, newsletter: NewsletterRow): Promise<NewsletterRow> {
    const audience = { from: newsletter.audienceFrom, to: newsletter.audienceTo };
    await tx.execute(
      sql`insert into ${newsletterDeliveries} (newsletter_id, subscriber_id)
          select ${newsletter.id}, ${subscribers.id} from ${subscribers} where ${audienceWhere(audience)}`,
    );
    const [{ n }] = await tx
      .select({ n: count() })
      .from(newsletterDeliveries)
      .where(eq(newsletterDeliveries.newsletterId, newsletter.id));
    const [row] = await tx.update(newsletters).set({ recipients: n }).where(eq(newsletters.id, newsletter.id)).returning();
    return row;
  }

  /** Tries the failed deliveries of a sent newsletter again. */
  async retryFailed(user: AuthUser, id: number): Promise<{ message: string; newsletter: NewsletterRow }> {
    if (this.mailer.missingConfig()) throw this.notConfigured();
    const newsletter = await this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(newsletters)
        .set({ status: "sending", updatedAt: new Date() })
        .where(and(eq(newsletters.id, id), eq(newsletters.status, "sent"), gt(newsletters.failedCount, 0)))
        .returning();
      if (!claimed) throw new ApiError(HttpStatus.CONFLICT, "nothing_to_retry", "There are no failed emails to retry.");
      await tx
        .update(newsletterDeliveries)
        .set({ status: "pending", error: null })
        .where(and(eq(newsletterDeliveries.newsletterId, id), eq(newsletterDeliveries.status, "failed")));
      return claimed;
    });
    await this.audit.log(user, "retried", "newsletter", String(id), newsletter.subject);
    this.sender.start(id);
    return { message: `Retrying ${newsletter.failedCount} failed email${newsletter.failedCount === 1 ? "" : "s"}.`, newsletter };
  }

  private notConfigured(): ApiError {
    return new ApiError(
      HttpStatus.SERVICE_UNAVAILABLE,
      "email_not_configured",
      `Email sending isn't set up yet. Add ${this.mailer.missingConfig()} to the API's environment.`,
    );
  }

  private assertReady(newsletter: NewsletterRow): void {
    if (this.mailer.missingConfig()) throw this.notConfigured();
    if (!newsletter.body.trim()) {
      throw new ApiError(HttpStatus.BAD_REQUEST, "validation_failed", FORM_ERROR, { body: "Write the newsletter first" });
    }
  }
}
