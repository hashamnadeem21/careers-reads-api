import { Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { env } from "../config/env.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { applications, jobs, users } from "../db/schema.js";
import { MailerService, type OutgoingEmail } from "../mail/mailer.service.js";
import { candidateEmail, employerEmail, type EmailSettings } from "./application-emails.js";

/** Give up on an application's emails after this many failed runs, or once it's this old. */
const MAX_ATTEMPTS = 5;
const NOTIFY_WINDOW_HOURS = 48;
const BATCH = 25;

export interface NotifySummary {
  sent: number;
  failed: number;
}

/**
 * Background work for applications, run by the scheduler every minute: the "new application" and
 * "application sent" emails, and deleting applications past the retention period.
 */
@Injectable()
export class ApplicationNotifier {
  private readonly logger = new Logger("ApplicationNotifier");

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly mailer: MailerService,
  ) {}

  /** Who hears about a new application: the company's people, or for Career Reads jobs whoever posted it (else the super admins). */
  private async employerRecipients(companyId: string | null, createdBy: string | null): Promise<string[]> {
    if (companyId) {
      const rows = await this.db.select({ email: users.email }).from(users).where(eq(users.companyId, companyId));
      return rows.map((r) => r.email);
    }
    if (createdBy) {
      const [poster] = await this.db.select({ email: users.email }).from(users).where(eq(users.id, createdBy)).limit(1);
      if (poster) return [poster.email];
    }
    const admins = await this.db.select({ email: users.email }).from(users).where(eq(users.role, "super_admin"));
    return admins.map((r) => r.email);
  }

  /** Sends the emails for applications that don't have them yet. Without email set up, it waits. */
  async sendDue(now = new Date()): Promise<NotifySummary> {
    if (this.mailer.missingConfig()) return { sent: 0, failed: 0 };
    const { PUBLIC_SITE_URL, ADMIN_URL, NEWSLETTER_POSTAL_ADDRESS } = env();
    const settings: EmailSettings = {
      siteUrl: PUBLIC_SITE_URL,
      adminUrl: ADMIN_URL,
      postalAddress: NEWSLETTER_POSTAL_ADDRESS,
    };
    const due = await this.db
      .select({
        id: applications.id,
        name: applications.name,
        email: applications.email,
        location: applications.location,
        companyId: applications.companyId,
        job: { slug: jobs.slug, title: jobs.title, company: jobs.company, createdBy: jobs.createdBy },
      })
      .from(applications)
      .innerJoin(jobs, eq(jobs.id, applications.jobId))
      .where(
        and(
          isNull(applications.notifiedAt),
          lt(applications.notifyAttempts, MAX_ATTEMPTS),
          gt(applications.createdAt, new Date(now.getTime() - NOTIFY_WINDOW_HOURS * 3_600_000)),
        ),
      )
      .orderBy(asc(applications.createdAt))
      .limit(BATCH);

    const summary: NotifySummary = { sent: 0, failed: 0 };
    for (const row of due) {
      const data = { applicationId: row.id, name: row.name, email: row.email, location: row.location, job: row.job };
      const recipients = await this.employerRecipients(row.companyId, row.job.createdBy);
      const emails: OutgoingEmail[] = [
        candidateEmail(data, settings),
        ...recipients.map((to) => employerEmail(to, data, settings)),
      ].slice(0, 100);
      // The same key on a retry makes Resend skip a batch that already went out.
      const result = await this.mailer.sendBatch(emails, `application-${row.id}`);
      if (result.ok) {
        await this.db.update(applications).set({ notifiedAt: now }).where(eq(applications.id, row.id));
        summary.sent++;
      } else {
        await this.db
          .update(applications)
          .set({ notifyAttempts: sql`${applications.notifyAttempts} + 1` })
          .where(eq(applications.id, row.id));
        summary.failed++;
      }
    }
    return summary;
  }

  /**
   * Deletes applications APPLICATION_RETENTION_DAYS after the later of the job's deadline and the
   * application itself. Their CVs go in the files sweep. Returns how many were deleted.
   */
  async purgeExpired(now = new Date(), limit = 500): Promise<number> {
    const days = env().APPLICATION_RETENTION_DAYS;
    const expired = await this.db
      .select({ id: applications.id })
      .from(applications)
      .innerJoin(jobs, eq(jobs.id, applications.jobId))
      .where(
        sql`greatest(${applications.createdAt}, coalesce(${jobs.deadline}, ${applications.createdAt})) + make_interval(days => ${days}) < ${now}`,
      )
      .limit(limit);
    if (!expired.length) return 0;
    await this.db.delete(applications).where(
      inArray(
        applications.id,
        expired.map((r) => r.id),
      ),
    );
    this.logger.log(`Deleted ${expired.length} application(s) past the ${days}-day retention period.`);
    return expired.length;
  }
}
