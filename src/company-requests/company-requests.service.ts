import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { and, count, desc, eq, sql } from "drizzle-orm";
import type { AuthUser } from "../auth/auth-user.js";
import { ApiError } from "../common/api-error.js";
import { AuditService } from "../common/audit.service.js";
import { limitKey, RateLimitService } from "../common/rate-limit.service.js";
import { CompaniesService } from "../companies/companies.service.js";
import { env } from "../config/env.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { companies, type CompanyRequestRow, companyRequests, users } from "../db/schema.js";
import { MailerService, type OutgoingEmail } from "../mail/mailer.service.js";
import type { InviteCreated } from "../users/invites.service.js";
import { type EmailSettings, requestDeclinedEmail, requestReceivedEmail, reviewRequestEmail } from "./company-request-emails.js";
import type { ApproveCompanyRequest, CompanyRequestInput, CompanyRequestListQuery, RejectCompanyRequest } from "./company-requests.schemas.js";

const PAGE_SIZE = 25;
/** 3 requests per visitor per hour, and 3 per email address per day. */
const IP_LIMIT = 3;
const IP_WINDOW_SECONDS = 60 * 60;
const EMAIL_LIMIT = 3;
const EMAIL_WINDOW_SECONDS = 24 * 60 * 60;

export interface CompanyRequestDetail {
  request: CompanyRequestRow & { reviewedByName: string | null; approvedCompanyName: string | null };
  /** Things the reviewer should know before approving. */
  checks: {
    /** The contact's email already signs in to the admin (approving would fail). */
    emailHasAccount: boolean;
    /** A company with this name already exists. */
    companyNameTaken: boolean;
    /** Earlier requests from the same email address. */
    previousRequests: number;
  };
}

const notFound = () => new ApiError(HttpStatus.NOT_FOUND, "not_found", "This request doesn't exist.");
const alreadyReviewed = () =>
  new ApiError(HttpStatus.CONFLICT, "already_reviewed", "This request has already been reviewed. Refresh to see what was decided.");

/**
 * Company account requests from the website's "For employers" page. Super admins review them:
 * approving creates the company and invites the contact (the usual 7-day invite email) as its
 * first admin account; turning one down can tell them why.
 */
@Injectable()
export class CompanyRequestsService {
  private readonly logger = new Logger("CompanyRequests");

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly rateLimit: RateLimitService,
    private readonly companies: CompaniesService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
  ) {}

  /**
   * Saves a request and emails the company a receipt and the super admins a heads-up. A second
   * request from an email address whose first is still waiting changes nothing (and sends nothing).
   */
  async submit(ip: string, input: CompanyRequestInput): Promise<{ message: string }> {
    await this.rateLimit.enforce(limitKey("company-request", ip), IP_LIMIT, IP_WINDOW_SECONDS, "Too many requests. Please try again in an hour.");
    await this.rateLimit.enforce(
      limitKey("company-request-email", input.contactEmail),
      EMAIL_LIMIT,
      EMAIL_WINDOW_SECONDS,
      "Too many requests from this email address today. Please try again tomorrow.",
    );
    const message = `Thanks! We've received your request. We'll review it within two working days and email you at ${input.contactEmail}.`;
    const [request] = await this.db
      .insert(companyRequests)
      .values({
        companyName: input.companyName,
        website: input.website ?? null,
        industry: input.industry,
        companySize: input.companySize,
        location: input.location,
        contactName: input.contactName,
        contactEmail: input.contactEmail,
        contactPhone: input.contactPhone,
        contactRole: input.contactRole,
        hiringPlans: input.hiringPlans ?? null,
      })
      .onConflictDoNothing() // the one-pending-request-per-email index
      .returning();
    if (!request) return { message };

    const settings = this.emailSettings();
    const admins = await this.db.select({ email: users.email }).from(users).where(eq(users.role, "super_admin"));
    await this.send([requestReceivedEmail(request, settings), ...admins.map((a) => reviewRequestEmail(a.email, request, settings))], "request emails");
    return { message };
  }

  async list(query: CompanyRequestListQuery) {
    const where = query.status === "all" ? undefined : eq(companyRequests.status, query.status);
    const [items, [{ total }], [counts]] = await Promise.all([
      this.db
        .select({
          id: companyRequests.id,
          companyName: companyRequests.companyName,
          industry: companyRequests.industry,
          companySize: companyRequests.companySize,
          location: companyRequests.location,
          contactName: companyRequests.contactName,
          contactEmail: companyRequests.contactEmail,
          contactRole: companyRequests.contactRole,
          status: companyRequests.status,
          createdAt: companyRequests.createdAt,
          reviewedAt: companyRequests.reviewedAt,
        })
        .from(companyRequests)
        .where(where)
        // Oldest first while waiting (first come, first served); newest first otherwise.
        .orderBy(query.status === "pending" ? companyRequests.createdAt : desc(companyRequests.createdAt), desc(companyRequests.id))
        .limit(PAGE_SIZE)
        .offset((query.page - 1) * PAGE_SIZE),
      this.db.select({ total: count() }).from(companyRequests).where(where),
      this.db
        .select({
          pending: sql<number>`count(*) filter (where ${companyRequests.status} = 'pending')`.mapWith(Number),
          approved: sql<number>`count(*) filter (where ${companyRequests.status} = 'approved')`.mapWith(Number),
          rejected: sql<number>`count(*) filter (where ${companyRequests.status} = 'rejected')`.mapWith(Number),
        })
        .from(companyRequests),
    ]);
    return { items, total, page: query.page, pageSize: PAGE_SIZE, counts };
  }

  async get(id: string): Promise<CompanyRequestDetail> {
    const [row] = await this.db
      .select({ request: companyRequests, reviewedByName: users.name, approvedCompanyName: companies.name })
      .from(companyRequests)
      .leftJoin(users, eq(users.id, companyRequests.reviewedBy))
      .leftJoin(companies, eq(companies.id, companyRequests.companyId))
      .where(eq(companyRequests.id, id))
      .limit(1);
    if (!row) throw notFound();
    const { request } = row;
    const [[account], [sameName], [{ previous }]] = await Promise.all([
      this.db.select({ id: users.id }).from(users).where(eq(users.email, request.contactEmail)).limit(1),
      this.db
        .select({ id: companies.id })
        .from(companies)
        .where(sql`lower(${companies.name}) = lower(${request.companyName})`)
        .limit(1),
      this.db
        .select({ previous: count() })
        .from(companyRequests)
        .where(and(eq(companyRequests.contactEmail, request.contactEmail), sql`${companyRequests.createdAt} < ${request.createdAt.toISOString()}::timestamptz`)),
    ]);
    return {
      request: { ...request, reviewedByName: row.reviewedByName, approvedCompanyName: row.approvedCompanyName },
      checks: {
        emailHasAccount: Boolean(account),
        companyNameTaken: Boolean(sameName) && request.status === "pending",
        previousRequests: previous,
      },
    };
  }

  /**
   * Creates the company (as the reviewer set it up) and invites the contact as its first admin.
   * Everything that could stop the invite is checked before the company is created.
   */
  async approve(admin: AuthUser, id: string, input: ApproveCompanyRequest): Promise<{ message: string; companyId: string; invite: InviteCreated }> {
    const request = await this.pending(id);
    const [account] = await this.db.select({ id: users.id }).from(users).where(eq(users.email, input.contactEmail)).limit(1);
    if (account) {
      throw new ApiError(HttpStatus.CONFLICT, "already_member", "This email already has an admin account. Use a different email for the company's account.", {
        contactEmail: "Already has an admin account",
      });
    }
    const [sameName] = await this.db.select({ id: companies.id }).from(companies).where(eq(companies.name, input.companyName)).limit(1);
    if (sameName) {
      throw new ApiError(HttpStatus.CONFLICT, "name_taken", "A company with this name already exists.", {
        companyName: "A company with this name already exists",
      });
    }
    const company = await this.companies.create(admin, {
      name: input.companyName,
      website: input.website,
      autoPublish: input.autoPublish,
      onsiteApplyEnabled: input.onsiteApplyEnabled,
    });
    const [updated] = await this.db
      .update(companyRequests)
      .set({ status: "approved", reviewedBy: admin.id, reviewedAt: new Date(), companyId: company.id, reviewNote: null })
      .where(and(eq(companyRequests.id, request.id), eq(companyRequests.status, "pending")))
      .returning({ id: companyRequests.id });
    if (!updated) {
      // Someone else reviewed it at the same moment: undo the company we just made.
      await this.companies.remove(admin, company.id);
      throw alreadyReviewed();
    }
    const invite = await this.companies.invite(admin, company.id, { email: input.contactEmail, name: input.contactName });
    await this.audit.log(admin, "approved", "company_request", request.id, request.companyName);
    return {
      message: invite.emailed
        ? `${company.name} is set up, and ${input.contactName} has been emailed an invite to their company account.`
        : `${company.name} is set up, but the invite email couldn't be sent. Copy the invite link and send it to ${input.contactName}.`,
      companyId: company.id,
      invite,
    };
  }

  /** Turns a request down, telling them (with the reason, if given) when `notify` is on. */
  async reject(admin: AuthUser, id: string, input: RejectCompanyRequest): Promise<{ message: string; emailed: boolean }> {
    const request = await this.pending(id);
    const [updated] = await this.db
      .update(companyRequests)
      .set({ status: "rejected", reviewedBy: admin.id, reviewedAt: new Date(), reviewNote: input.reason ?? null })
      .where(and(eq(companyRequests.id, request.id), eq(companyRequests.status, "pending")))
      .returning({ id: companyRequests.id });
    if (!updated) throw alreadyReviewed();
    await this.audit.log(admin, "rejected", "company_request", request.id, request.companyName);
    if (!input.notify) return { message: `Request from ${request.companyName} turned down. They weren't emailed.`, emailed: false };
    const emailed = await this.send([requestDeclinedEmail(request, input.reason, this.emailSettings())], "decline email");
    return {
      message: emailed
        ? `Request from ${request.companyName} turned down, and ${request.contactName} has been emailed.`
        : `Request from ${request.companyName} turned down, but the email to ${request.contactName} couldn't be sent.`,
      emailed,
    };
  }

  /** Requests waiting for review (the admin sidebar's badge). */
  async pendingCount(): Promise<number> {
    const [{ pending }] = await this.db.select({ pending: count() }).from(companyRequests).where(eq(companyRequests.status, "pending"));
    return pending;
  }

  private async pending(id: string): Promise<CompanyRequestRow> {
    const [request] = await this.db.select().from(companyRequests).where(eq(companyRequests.id, id)).limit(1);
    if (!request) throw notFound();
    if (request.status !== "pending") throw alreadyReviewed();
    return request;
  }

  private emailSettings(): EmailSettings {
    const { PUBLIC_SITE_URL, ADMIN_URL, NEWSLETTER_POSTAL_ADDRESS } = env();
    return { siteUrl: PUBLIC_SITE_URL, adminUrl: ADMIN_URL, postalAddress: NEWSLETTER_POSTAL_ADDRESS };
  }

  /** Best effort: a failed email never fails the request. Without email set up, it's logged. */
  private async send(emails: OutgoingEmail[], what: string): Promise<boolean> {
    const missing = this.mailer.missingConfig();
    if (missing) {
      this.logger.warn(`Couldn't send ${what}: email isn't set up (${missing}).`);
      return false;
    }
    const result = await this.mailer.sendBatch(emails);
    if (!result.ok) this.logger.warn(`Couldn't send ${what}: ${result.error}`);
    return result.ok;
  }
}
