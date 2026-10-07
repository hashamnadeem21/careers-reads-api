import { HttpStatus, Injectable } from "@nestjs/common";
import { and, asc, count, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { AuthUser } from "../auth/auth-user.js";
import { ApiError } from "../common/api-error.js";
import { AuditService } from "../common/audit.service.js";
import { RevalidateSiteService } from "../common/revalidate-site.service.js";
import { copySlug, escapeLike } from "../common/slug.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { categories, companies, dailyStats, type JobRow, jobs } from "../db/schema.js";
import type { JobInput } from "../shared/jobs/schema.js";
import { auditVerb, canAccessJob, jobScope, type Publishing, resolvePublishing } from "./job-access.js";
import { type JobBody, parseJobBody } from "./job-input.js";
import type { bulkJobsSchema, JobListQuery, JobStatusFilter } from "./jobs.schemas.js";

export const JOB_PAGE_SIZE = 20;

const LIVE = sql`(${jobs.status} = 'published' and ${jobs.postedAt} <= now() and (${jobs.deadline} is null or ${jobs.deadline} + interval '1 day' > now()))`;

function statusCondition(status: JobStatusFilter): SQL {
  switch (status) {
    case "live":
      return LIVE;
    case "draft":
      return sql`(${jobs.status} = 'draft' and ${jobs.review} is distinct from 'pending')`;
    case "review":
      return eq(jobs.review, "pending");
    case "scheduled":
      return sql`(${jobs.status} = 'published' and ${jobs.postedAt} > now())`;
    case "expired":
      return sql`(${jobs.status} = 'published' and ${jobs.deadline} is not null and ${jobs.deadline} + interval '1 day' <= now())`;
  }
}

const SORTS = { posted: jobs.postedAt, deadline: jobs.deadline, title: jobs.title, updated: jobs.updatedAt } as const;

/** Never reveals whether another company's job exists. */
const notFound = (message = "This job no longer exists. It may have been deleted.") =>
  new ApiError(HttpStatus.NOT_FOUND, "not_found", message);

const invalid = (fields: Record<string, string>) =>
  new ApiError(HttpStatus.BAD_REQUEST, "validation_failed", "Please fix the highlighted fields.", fields);

export interface SaveJobResult {
  job: JobRow;
  /** "submitted" (sent for review), "saved", or "saved-offline" (the site couldn't be refreshed). */
  notice: "submitted" | "saved" | "saved-offline";
  message: string;
}

function toRow(data: JobInput, publishing: Publishing) {
  return {
    title: data.title,
    company: data.company,
    companyWebsite: data.companyWebsite ?? null,
    city: data.city ?? null,
    country: data.country,
    workModel: data.workModel,
    employmentType: data.employmentType,
    category: data.category,
    experience: data.experience,
    salary: data.salary ?? null,
    summary: data.summary,
    responsibilities: data.responsibilities,
    requirements: data.requirements,
    benefits: data.benefits,
    applyUrl: data.applyUrl ?? null,
    applyEmail: data.applyEmail ?? null,
    postedAt: new Date(data.postedAt),
    deadline: data.deadline ? new Date(data.deadline) : null,
    status: publishing.status,
    review: publishing.review,
    featured: data.featured,
    sample: false,
    updatedAt: new Date(),
  };
}

/**
 * Jobs are open to every signed-in role, so each action loads the job through `canAccessJob`:
 * company accounts can only ever touch their own company's jobs.
 */
@Injectable()
export class JobsService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly audit: AuditService,
    private readonly revalidateSite: RevalidateSiteService,
  ) {}

  /** Everything on the public site that shows jobs. */
  private refreshSite(...slugs: string[]) {
    return this.revalidateSite.revalidate({
      tags: ["jobs"],
      paths: ["/", "/jobs", "/sitemap.xml", ...slugs.map((s) => `/jobs/${s}`)],
    });
  }

  private async load(user: AuthUser, slug: string): Promise<JobRow> {
    const [job] = await this.db.select().from(jobs).where(eq(jobs.slug, slug)).limit(1);
    if (!job || !canAccessJob(user, job)) throw notFound();
    return job;
  }

  /** Jobs this user may see, filtered and paged, with the status tab counts. */
  async list(user: AuthUser, params: JobListQuery) {
    const where: SQL[] = [];
    const scope = jobScope(user);
    if (scope) where.push(scope);
    else if (params.company) where.push(eq(jobs.companyId, params.company));
    if (params.q) {
      const p = `%${escapeLike(params.q)}%`;
      where.push(or(ilike(jobs.title, p), ilike(jobs.company, p), ilike(jobs.city, p), ilike(jobs.slug, p))!);
    }
    if (params.status) where.push(statusCondition(params.status));
    if (params.category) where.push(eq(jobs.category, params.category));
    const condition = where.length ? and(...where) : undefined;
    const column = SORTS[params.sort];
    const order = params.dir === "asc" ? sql`${column} asc nulls last` : sql`${column} desc nulls last`;

    const [rows, [{ total }], counts] = await Promise.all([
      this.db
        .select({ job: jobs, categoryName: categories.name, accountName: companies.name })
        .from(jobs)
        .leftJoin(categories, eq(categories.slug, jobs.category))
        .leftJoin(companies, eq(companies.id, jobs.companyId))
        .where(condition)
        .orderBy(order, asc(jobs.slug))
        .limit(JOB_PAGE_SIZE)
        .offset((params.page - 1) * JOB_PAGE_SIZE),
      this.db.select({ total: count() }).from(jobs).where(condition),
      this.statusCounts(user),
    ]);
    return { rows, total, page: params.page, pageSize: JOB_PAGE_SIZE, counts };
  }

  async statusCounts(user: AuthUser): Promise<Record<JobStatusFilter | "all", number>> {
    const [row] = await this.db
      .select({
        all: count(),
        live: sql<number>`count(*) filter (where ${statusCondition("live")})`.mapWith(Number),
        draft: sql<number>`count(*) filter (where ${statusCondition("draft")})`.mapWith(Number),
        review: sql<number>`count(*) filter (where ${statusCondition("review")})`.mapWith(Number),
        scheduled: sql<number>`count(*) filter (where ${statusCondition("scheduled")})`.mapWith(Number),
        expired: sql<number>`count(*) filter (where ${statusCondition("expired")})`.mapWith(Number),
      })
      .from(jobs)
      .where(jobScope(user));
    return row;
  }

  /** Company jobs waiting for review (the staff sidebar badge). */
  async pendingReviewCount(): Promise<{ count: number }> {
    const [{ n }] = await this.db.select({ n: count() }).from(jobs).where(eq(jobs.review, "pending"));
    return { count: n };
  }

  /** Job categories for the form. */
  categories() {
    return this.db
      .select({ slug: categories.slug, name: categories.name })
      .from(categories)
      .where(eq(categories.kind, "job"))
      .orderBy(asc(categories.sortOrder), asc(categories.name));
  }

  /** One job with its all-time views and Apply clicks. */
  async get(user: AuthUser, slug: string) {
    const job = await this.load(user, slug);
    const result = await this.db.execute<{ views: number; applies: number }>(sql`
      select coalesce(sum(count) filter (where kind = 'view'), 0)::int as views,
             coalesce(sum(count) filter (where kind = 'apply_click'), 0)::int as applies
      from ${dailyStats} where path = ${`/jobs/${slug}`}`);
    const stats = result.rows[0];
    return { job, stats: { views: Number(stats?.views ?? 0), applies: Number(stats?.applies ?? 0) } };
  }

  /**
   * Create (`originalSlug` null) or update a job.
   * Company accounts: the company name comes from their account, "Featured" stays as it was,
   * and publishing goes through review unless the company is trusted.
   */
  async save(user: AuthUser, originalSlug: string | null, body: JobBody): Promise<SaveJobResult> {
    const parsed = parseJobBody(body);
    if (user.role === "company" && parsed.data) parsed.data.company = user.companyName ?? parsed.data.company;
    if (!parsed.data) throw invalid(parsed.errors);
    const { data, slug } = parsed;

    const [category] = await this.db
      .select({ slug: categories.slug })
      .from(categories)
      .where(and(eq(categories.slug, data.category), eq(categories.kind, "job")))
      .limit(1);
    if (!category) throw invalid({ category: "Pick a job category" });

    const existing = originalSlug ? await this.load(user, originalSlug) : null;

    // Which company account owns the job.
    let companyId: string | null;
    if (user.role === "company") {
      companyId = user.companyId;
      data.featured = existing?.featured ?? false; // featuring is a Career Reads decision
    } else {
      companyId = z.uuid().safeParse(body.companyId).success ? body.companyId : null;
      if (companyId) {
        const [company] = await this.db
          .select({ name: companies.name })
          .from(companies)
          .where(eq(companies.id, companyId))
          .limit(1);
        if (!company) throw invalid({ companyId: "That company no longer exists" });
        data.company = company.name; // company-account jobs always show the account's name
      }
    }

    if (slug !== originalSlug) {
      const [taken] = await this.db.select({ slug: jobs.slug }).from(jobs).where(eq(jobs.slug, slug)).limit(1);
      if (taken) throw invalid({ slug: "This address is already used by another job. Try a different one." });
    }

    const before = existing ? { status: existing.status, review: existing.review } : null;
    const publishing = resolvePublishing(user, data.status, { companyId, review: existing?.review ?? null });
    const row = {
      ...toRow(data, publishing),
      companyId,
      reviewNote: publishing.review === "rejected" ? (existing?.reviewNote ?? null) : null,
    };

    let saved: JobRow;
    if (existing) {
      saved = await this.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(jobs)
          .set({ ...row, slug })
          .where(eq(jobs.slug, existing.slug))
          .returning();
        if (slug !== existing.slug) {
          // Keep the job's stats when its URL changes.
          await tx
            .update(dailyStats)
            .set({ entitySlug: slug, path: `/jobs/${slug}` })
            .where(eq(dailyStats.path, `/jobs/${existing.slug}`));
        }
        return updated;
      });
    } else {
      [saved] = await this.db
        .insert(jobs)
        .values({ ...row, slug, createdBy: user.id })
        .returning();
    }

    await this.audit.log(user, auditVerb(before, publishing), "job", slug, data.title);
    const site = await this.refreshSite(slug, ...(existing && existing.slug !== slug ? [existing.slug] : []));

    if (publishing.review === "pending" && before?.review !== "pending") {
      return {
        job: saved,
        notice: "submitted",
        message: "Sent for review. It goes live as soon as Career Reads approves it.",
      };
    }
    return site.ok
      ? { job: saved, notice: "saved", message: "Saved. The site is up to date." }
      : { job: saved, notice: "saved-offline", message: "Saved. The site will update within the hour." };
  }

  /** Copy a job into a new draft ("Frontend Developer (copy)"), owned by the same company. */
  async duplicate(user: AuthUser, slug: string): Promise<{ slug: string; message: string }> {
    const job = await this.load(user, slug);
    const newSlug = await copySlug(this.db, jobs, jobs.slug, job.slug);
    const {
      slug: _slug,
      createdAt: _createdAt,
      createdBy: _createdBy,
      updatedAt: _updatedAt,
      review: _review,
      reviewNote: _reviewNote,
      ...rest
    } = job;
    await this.db.insert(jobs).values({
      ...rest,
      slug: newSlug,
      title: `${job.title} (copy)`.slice(0, 100),
      status: "draft",
      review: null,
      reviewNote: null,
      featured: false,
      sample: false,
      postedAt: new Date(),
      deadline: null,
      createdBy: user.id,
    });
    await this.audit.log(user, "duplicated", "job", newSlug, job.title);
    return { slug: newSlug, message: "Copied as a new draft." };
  }

  /** Close applications now: the deadline becomes yesterday, so the job leaves the site immediately. */
  async close(user: AuthUser, slug: string): Promise<{ message: string }> {
    const job = await this.load(user, slug);
    const yesterday = new Date();
    yesterday.setUTCHours(0, 0, 0, 0);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await this.db.update(jobs).set({ deadline: yesterday, updatedAt: new Date() }).where(eq(jobs.slug, job.slug));
    await this.audit.log(user, "closed", "job", job.slug, job.title);
    const site = await this.refreshSite(job.slug);
    return {
      message: site.ok
        ? "Job closed. It's no longer on the site."
        : "Job closed. The site will update within the hour.",
    };
  }

  /** Publish / unpublish. For companies that aren't trusted, "publish" sends the job for review. */
  async setStatus(user: AuthUser, slug: string, requested: "draft" | "published"): Promise<{ message: string }> {
    const job = await this.load(user, slug);
    const after = resolvePublishing(user, requested, job);
    await this.db
      .update(jobs)
      .set({ ...after, reviewNote: after.review === "rejected" ? job.reviewNote : null, updatedAt: new Date() })
      .where(eq(jobs.slug, job.slug));
    await this.audit.log(
      user,
      auditVerb({ status: job.status, review: job.review }, after),
      "job",
      job.slug,
      job.title,
    );
    const site = await this.refreshSite(job.slug);
    if (after.review === "pending" && requested === "published") {
      return { message: "Sent for review. It goes live as soon as Career Reads approves it." };
    }
    const verb = after.status === "published" ? "Published" : "Unpublished";
    return { message: site.ok ? `${verb}.` : `${verb}. The site will update within the hour.` };
  }

  async remove(user: AuthUser, slug: string): Promise<void> {
    const job = await this.load(user, slug);
    await this.db.transaction(async (tx) => {
      await tx.delete(jobs).where(eq(jobs.slug, job.slug));
      await tx.delete(dailyStats).where(eq(dailyStats.path, `/jobs/${job.slug}`));
    });
    await this.audit.log(user, "deleted", "job", job.slug, job.title);
    await this.refreshSite(job.slug);
  }

  /** Only jobs this user may access are touched; anything else is silently skipped. */
  async bulk(user: AuthUser, { action, slugs }: z.infer<typeof bulkJobsSchema>): Promise<{ message: string }> {
    const rows = await this.db
      .select()
      .from(jobs)
      .where(and(inArray(jobs.slug, slugs), jobScope(user)));
    if (!rows.length) throw notFound("Nothing to update.");
    const found = rows.map((r) => r.slug);

    let submitted = 0;
    if (action === "delete") {
      await this.db.transaction(async (tx) => {
        await tx.delete(jobs).where(inArray(jobs.slug, found));
        await tx.delete(dailyStats).where(
          inArray(
            dailyStats.path,
            found.map((s) => `/jobs/${s}`),
          ),
        );
      });
      for (const r of rows) await this.audit.log(user, "deleted", "job", r.slug, r.title);
    } else {
      const requested = action === "publish" ? "published" : "draft";
      for (const r of rows) {
        const after = resolvePublishing(user, requested, r);
        if (after.review === "pending" && r.review !== "pending") submitted++;
        await this.db
          .update(jobs)
          .set({ ...after, reviewNote: after.review === "rejected" ? r.reviewNote : null, updatedAt: new Date() })
          .where(eq(jobs.slug, r.slug));
        await this.audit.log(user, auditVerb({ status: r.status, review: r.review }, after), "job", r.slug, r.title);
      }
    }
    await this.refreshSite(...found);
    const n = `${rows.length} job${rows.length === 1 ? "" : "s"}`;
    if (submitted > 0) return { message: `${n} sent for review.` };
    const verb = action === "delete" ? "deleted" : action === "publish" ? "published" : "unpublished";
    return { message: `${n} ${verb}.` };
  }

  /** Staff: approve a company's job. It goes live (or is scheduled) right away. */
  async approve(user: AuthUser, slug: string): Promise<{ message: string }> {
    const job = await this.load(user, slug);
    if (job.review !== "pending") {
      throw new ApiError(HttpStatus.CONFLICT, "not_pending", "This job isn't waiting for review.");
    }
    await this.db
      .update(jobs)
      .set({ status: "published", review: "approved", reviewNote: null, updatedAt: new Date() })
      .where(eq(jobs.slug, job.slug));
    await this.audit.log(user, "approved", "job", job.slug, job.title);
    const site = await this.refreshSite(job.slug);
    return { message: site.ok ? "Approved and published." : "Approved. The site will update within the hour." };
  }

  /** Staff: send a company's job back with a note explaining what to change. */
  async reject(user: AuthUser, slug: string, note: string): Promise<{ message: string }> {
    const job = await this.load(user, slug);
    if (job.review !== "pending" && job.status !== "published") {
      throw new ApiError(HttpStatus.CONFLICT, "not_pending", "This job isn't waiting for review.");
    }
    await this.db
      .update(jobs)
      .set({ status: "draft", review: "rejected", reviewNote: note, updatedAt: new Date() })
      .where(eq(jobs.slug, job.slug));
    await this.audit.log(user, "sent back", "job", job.slug, job.title);
    await this.refreshSite(job.slug);
    return { message: "Sent back to the company with your note." };
  }
}
