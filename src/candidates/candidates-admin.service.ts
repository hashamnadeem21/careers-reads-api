import { HttpStatus, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gte, ilike, isNotNull, lt, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { AuthUser } from "../auth/auth-user.js";
import { ApiError } from "../common/api-error.js";
import { AuditService } from "../common/audit.service.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { applications, candidateAuthMethod, candidateEvents, candidates, jobs, subscribers } from "../db/schema.js";

export const PAGE_SIZE = 25;

export const candidateListQuerySchema = z.object({
  /** Name or email. */
  q: z.string().trim().max(100).optional(),
  method: z.enum(candidateAuthMethod.enumValues.filter((m) => m !== "apply") as ["google", "password"]).optional(),
  subscribed: z.enum(["yes", "no"]).optional(),
  /** Signed up on or after / before (YYYY-MM-DD, UTC). */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type CandidateListQuery = z.infer<typeof candidateListQuerySchema>;

/*
 * Correlated subqueries name the outer columns in full: in a single-table select Drizzle writes
 * ${candidates.id} as a bare "id", which inside the subquery would mean the inner table's column.
 */
/** A live newsletter subscription for this candidate's email. */
const subscribedSql = sql<boolean>`exists (select 1 from ${subscribers} s where s.email = "candidates"."email" and s.unsubscribed_at is null)`;
/** Every application, including ones held until the email is confirmed. */
const applicationsSql = sql<number>`(select count(*) from ${applications} a where a.candidate_id = "candidates"."id")`.mapWith(Number);

function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Candidate accounts for the super admin: who signed up, how, when they last signed in, their
 * history, and a CSV for email marketing (the "Subscribed" column is who agreed to marketing email).
 */
@Injectable()
export class CandidatesAdminService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  private conditions(query: Omit<CandidateListQuery, "page">): SQL {
    const where: SQL[] = [isNotNull(candidates.accountCreatedAt)];
    if (query.q) {
      const pattern = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(or(ilike(candidates.name, pattern), ilike(candidates.email, pattern)) as SQL);
    }
    if (query.method) where.push(eq(candidates.signupMethod, query.method));
    if (query.subscribed === "yes") where.push(subscribedSql);
    if (query.subscribed === "no") where.push(sql`not ${subscribedSql}`);
    if (query.from) where.push(gte(candidates.accountCreatedAt, new Date(`${query.from}T00:00:00Z`)));
    if (query.to) where.push(lt(candidates.accountCreatedAt, new Date(new Date(`${query.to}T00:00:00Z`).getTime() + 86_400_000)));
    return and(...where) as SQL;
  }

  private columns() {
    return {
      id: candidates.id,
      name: candidates.name,
      email: candidates.email,
      avatarUrl: candidates.avatarUrl,
      signupMethod: candidates.signupMethod,
      emailVerified: sql<boolean>`${candidates.emailVerifiedAt} is not null`,
      accountCreatedAt: candidates.accountCreatedAt,
      lastSignInAt: candidates.lastSignInAt,
      signInCount: candidates.signInCount,
      applications: applicationsSql,
      subscribed: subscribedSql,
    };
  }

  async list(query: CandidateListQuery) {
    const condition = this.conditions(query);
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const [items, [{ total }], [stats]] = await Promise.all([
      this.db
        .select(this.columns())
        .from(candidates)
        .where(condition)
        .orderBy(desc(candidates.accountCreatedAt), desc(candidates.id))
        .limit(PAGE_SIZE)
        .offset((query.page - 1) * PAGE_SIZE),
      this.db.select({ total: count() }).from(candidates).where(condition),
      this.db
        .select({
          accounts: count(),
          newThisWeek: sql<number>`count(*) filter (where ${candidates.accountCreatedAt} >= ${weekAgo.toISOString()}::timestamptz)`.mapWith(Number),
          google: sql<number>`count(*) filter (where ${candidates.signupMethod} = 'google')`.mapWith(Number),
          password: sql<number>`count(*) filter (where ${candidates.signupMethod} = 'password')`.mapWith(Number),
          subscribed: sql<number>`count(*) filter (where ${subscribedSql})`.mapWith(Number),
          activeThisWeek: sql<number>`count(*) filter (where ${candidates.lastSignInAt} >= ${weekAgo.toISOString()}::timestamptz)`.mapWith(Number),
        })
        .from(candidates)
        .where(isNotNull(candidates.accountCreatedAt)),
    ]);
    return { items, total, page: query.page, pageSize: PAGE_SIZE, stats };
  }

  async get(id: string) {
    const [candidate] = await this.db
      .select(this.columns())
      .from(candidates)
      .where(and(eq(candidates.id, id), isNotNull(candidates.accountCreatedAt)))
      .limit(1);
    if (!candidate) throw new ApiError(HttpStatus.NOT_FOUND, "not_found", "This candidate doesn't exist (or deleted their account).");
    const [history, applied] = await Promise.all([
      this.db
        .select({
          id: candidateEvents.id,
          kind: candidateEvents.kind,
          method: candidateEvents.method,
          createdAt: candidateEvents.createdAt,
          job: { slug: jobs.slug, title: jobs.title },
        })
        .from(candidateEvents)
        .leftJoin(jobs, eq(jobs.id, candidateEvents.jobId))
        .where(eq(candidateEvents.candidateId, id))
        .orderBy(desc(candidateEvents.createdAt), desc(candidateEvents.id))
        .limit(200),
      this.db
        .select({
          id: applications.id,
          status: applications.status,
          awaitingConfirmation: applications.awaitingConfirmation,
          createdAt: applications.createdAt,
          job: { slug: jobs.slug, title: jobs.title, company: jobs.company },
        })
        .from(applications)
        .innerJoin(jobs, eq(jobs.id, applications.jobId))
        .where(eq(applications.candidateId, id))
        .orderBy(desc(applications.createdAt)),
    ]);
    return { candidate, history: history.map((e) => ({ ...e, job: e.job?.slug ? e.job : null })), applications: applied };
  }

  /** Every account matching the filters (no paging), for email marketing. */
  async exportCsv(user: AuthUser, query: Omit<CandidateListQuery, "page">): Promise<string> {
    const rows = await this.db
      .select(this.columns())
      .from(candidates)
      .where(this.conditions(query))
      .orderBy(desc(candidates.accountCreatedAt));
    const date = (d: Date | null) => (d ? d.toISOString().replace("T", " ").slice(0, 16) : "");
    const header = ["Name", "Email", "Signed up with", "Email confirmed", "Signed up", "Last sign-in", "Sign-ins", "Applications", "Subscribed to newsletter"];
    const lines = rows.map((r) =>
      [
        r.name,
        r.email,
        r.signupMethod === "google" ? "Google" : "Email and password",
        r.emailVerified ? "Yes" : "No",
        date(r.accountCreatedAt),
        date(r.lastSignInAt),
        String(r.signInCount),
        String(r.applications),
        r.subscribed ? "Yes" : "No",
      ]
        .map(csvCell)
        .join(","),
    );
    await this.audit.log(user, "exported", "candidate", null, `${rows.length} candidate${rows.length === 1 ? "" : "s"}`);
    return [header.join(","), ...lines].join("\r\n");
  }

  /** Deletes the account, its history, applications and CVs, and their newsletter subscription. */
  async remove(user: AuthUser, id: string): Promise<{ message: string }> {
    const [candidate] = await this.db.select().from(candidates).where(eq(candidates.id, id)).limit(1);
    if (!candidate) return { message: "Already deleted." };
    await this.db.transaction(async (tx) => {
      await tx.delete(subscribers).where(eq(subscribers.email, candidate.email));
      await tx.delete(candidates).where(eq(candidates.id, id));
    });
    await this.audit.log(user, "deleted", "candidate", null, candidate.name);
    return { message: `${candidate.name}'s account and applications were deleted.` };
  }
}
