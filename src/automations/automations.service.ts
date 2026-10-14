import { HttpStatus, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, getTableColumns, sql } from "drizzle-orm";
import type { AuthUser } from "../auth/auth-user.js";
import { ApiError } from "../common/api-error.js";
import { AuditService } from "../common/audit.service.js";
import { limitKey, RateLimitService } from "../common/rate-limit.service.js";
import { FORM_ERROR } from "../common/zod.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import {
  automationDeliveries,
  type AutomationDeliveryStatus,
  type AutomationRow,
  candidates,
  emailAutomations,
  subscribers,
} from "../db/schema.js";
import { candidateWelcomeEmail } from "../candidates/candidate-emails.js";
import { env } from "../config/env.js";
import { MailerService } from "../mail/mailer.service.js";
import { composeEmail } from "../newsletters/compose.js";
import type { AutomationBody } from "./automations.schemas.js";

const notFound = (message = "This automation no longer exists.") =>
  new ApiError(HttpStatus.NOT_FOUND, "not_found", message);

export type DeliveryStats = Record<AutomationDeliveryStatus, number>;
const noStats = (): DeliveryStats => ({ pending: 0, sent: 0, failed: 0, skipped: 0 });

const { body: _body, ...listColumns } = getTableColumns(emailAutomations);

/**
 * Automations: emails sent automatically when something happens (e.g. someone subscribes).
 * Staff write and test them; only super admins switch them on or off.
 */
@Injectable()
export class AutomationsService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
    private readonly mailer: MailerService,
  ) {}

  /** All automations (no bodies) in send order, each with its delivery counts. */
  async list() {
    const [items, stats] = await Promise.all([
      this.db
        .select(listColumns)
        .from(emailAutomations)
        .orderBy(asc(emailAutomations.trigger), asc(emailAutomations.delayMinutes), asc(emailAutomations.id)),
      this.stats(),
    ]);
    return {
      items: items.map((item) => ({ ...item, stats: stats.get(item.id) ?? noStats() })),
      sendingReady: this.mailer.missingConfig() === null,
    };
  }

  /** The automation, its counts, why any failed, and the latest 25 deliveries. */
  async get(id: number) {
    const automation = await this.find(id);
    const [stats, failures, recent] = await Promise.all([
      this.stats(id),
      this.db
        .select({ error: automationDeliveries.error, count: count() })
        .from(automationDeliveries)
        .where(and(eq(automationDeliveries.automationId, id), eq(automationDeliveries.status, "failed")))
        .groupBy(automationDeliveries.error)
        .orderBy(desc(count()))
        .limit(5),
      this.db
        .select({
          id: automationDeliveries.id,
          email: sql<string>`coalesce(${subscribers.email}, ${candidates.email})`,
          status: automationDeliveries.status,
          dueAt: automationDeliveries.dueAt,
          sentAt: automationDeliveries.sentAt,
          error: automationDeliveries.error,
        })
        .from(automationDeliveries)
        .leftJoin(subscribers, eq(subscribers.id, automationDeliveries.subscriberId))
        .leftJoin(candidates, eq(candidates.id, automationDeliveries.candidateId))
        .where(eq(automationDeliveries.automationId, id))
        .orderBy(desc(automationDeliveries.createdAt), desc(automationDeliveries.id))
        .limit(25),
    ]);
    return {
      automation,
      stats: stats.get(id) ?? noStats(),
      failures,
      recent,
      sendingReady: this.mailer.missingConfig() === null,
    };
  }

  async create(user: AuthUser, input: AutomationBody): Promise<{ message: string; automation: AutomationRow }> {
    const [automation] = await this.db
      .insert(emailAutomations)
      .values({ ...input, active: false, createdBy: user.id })
      .returning();
    await this.audit.log(user, "created", "automation", String(automation.id), automation.name);
    return { message: "Automation saved. Switch it on when it's ready.", automation };
  }

  /** Edits apply to emails not sent yet, including ones already queued. */
  async update(user: AuthUser, id: number, input: AutomationBody): Promise<{ message: string; automation: AutomationRow }> {
    const current = await this.find(id);
    if (current.active) this.assertSendable(input);
    const [automation] = await this.db
      .update(emailAutomations)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(emailAutomations.id, id))
      .returning();
    if (!automation) throw notFound();
    await this.audit.log(user, "updated", "automation", String(id), automation.name);
    return { message: "Automation saved.", automation };
  }

  /**
   * On: new triggers queue emails from now (or the launch date). Off: nothing new is queued and
   * emails still waiting are skipped.
   */
  async setActive(user: AuthUser, id: number, active: boolean): Promise<{ message: string; automation: AutomationRow }> {
    const current = await this.find(id);
    if (active) {
      if (this.mailer.missingConfig()) throw this.notConfigured();
      this.assertSendable(current);
    }
    const automation = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(emailAutomations)
        .set({ active, updatedAt: new Date() })
        .where(eq(emailAutomations.id, id))
        .returning();
      if (!active) {
        await tx
          .update(automationDeliveries)
          .set({ status: "skipped", error: "The automation was switched off", lockedUntil: null })
          .where(and(eq(automationDeliveries.automationId, id), eq(automationDeliveries.status, "pending")));
      }
      return row;
    });
    await this.audit.log(user, active ? "activated" : "deactivated", "automation", String(id), automation.name);
    return {
      message: active ? "Switched on. New subscribers will get it automatically." : "Switched off. Nothing more will be sent.",
      automation,
    };
  }

  async remove(user: AuthUser, id: number): Promise<void> {
    const [row] = await this.db.delete(emailAutomations).where(eq(emailAutomations.id, id)).returning();
    if (!row) throw notFound("Already deleted.");
    await this.audit.log(user, "deleted", "automation", String(id), row.name);
  }

  /** Sends the saved email to one address, subject marked [Test]. 10 per user per 10 minutes. */
  async sendTest(user: AuthUser, id: number, email = user.email): Promise<{ message: string }> {
    const automation = await this.find(id);
    if (this.mailer.missingConfig()) throw this.notConfigured();
    this.assertSendable(automation);
    await this.rateLimit.enforce(
      limitKey("newsletter-test", user.id),
      10,
      600,
      "Too many test emails. Try again in a few minutes.",
    );
    const content = { ...automation, subject: `[Test] ${automation.subject}` };
    // The candidate welcome, as a password sign-up sees it: their first name and the confirm button.
    const copy =
      automation.trigger === "candidate_signed_up"
        ? candidateWelcomeEmail(content, { email, name: user.name }, `${env().PUBLIC_SITE_URL}/account/confirm-email?token=test-link`)
        : composeEmail(content, email, "test");
    const result = await this.mailer.sendBatch([copy]);
    if (!result.ok) throw new ApiError(HttpStatus.BAD_GATEWAY, "send_failed", result.error);
    return { message: `Test sent to ${email}.` };
  }

  /** Queues the emails that failed for good to be tried again on the next run. */
  async retryFailed(user: AuthUser, id: number): Promise<{ message: string }> {
    const automation = await this.find(id);
    if (this.mailer.missingConfig()) throw this.notConfigured();
    const retried = await this.db
      .update(automationDeliveries)
      .set({ status: "pending", attempts: 0, error: null, dueAt: new Date() })
      .where(and(eq(automationDeliveries.automationId, id), eq(automationDeliveries.status, "failed")))
      .returning({ id: automationDeliveries.id });
    if (retried.length === 0) throw new ApiError(HttpStatus.CONFLICT, "nothing_to_retry", "There are no failed emails to retry.");
    await this.audit.log(user, "retried", "automation", String(id), automation.name);
    const n = retried.length;
    return { message: `Retrying ${n} email${n === 1 ? "" : "s"} within a minute.` };
  }

  private async find(id: number): Promise<AutomationRow> {
    const [row] = await this.db.select().from(emailAutomations).where(eq(emailAutomations.id, id)).limit(1);
    if (!row) throw notFound();
    return row;
  }

  /** Delivery counts per automation (one, or all). */
  private async stats(id?: number): Promise<Map<number, DeliveryStats>> {
    const rows = await this.db
      .select({ automationId: automationDeliveries.automationId, status: automationDeliveries.status, n: count() })
      .from(automationDeliveries)
      .where(id === undefined ? sql`true` : eq(automationDeliveries.automationId, id))
      .groupBy(automationDeliveries.automationId, automationDeliveries.status);
    const map = new Map<number, DeliveryStats>();
    for (const row of rows) {
      const stats = map.get(row.automationId) ?? noStats();
      stats[row.status] = row.n;
      map.set(row.automationId, stats);
    }
    return map;
  }

  private assertSendable(automation: Pick<AutomationRow, "body">): void {
    if (!automation.body.trim()) {
      throw new ApiError(HttpStatus.BAD_REQUEST, "validation_failed", FORM_ERROR, { body: "Write the email first" });
    }
  }

  private notConfigured(): ApiError {
    return new ApiError(
      HttpStatus.SERVICE_UNAVAILABLE,
      "email_not_configured",
      `Email sending isn't set up yet. Add ${this.mailer.missingConfig()} to the API's environment.`,
    );
  }
}
