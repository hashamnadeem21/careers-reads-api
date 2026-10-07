import { and, asc, count, eq, gt, sql } from "drizzle-orm";
import { type ContentState, jobState } from "../common/content-state.js";
import type { Database } from "../db/client.js";
import { companies, invites, jobs, users, type CompanyRow } from "../db/schema.js";

/**
 * Company accounts and their job statistics. Stats come from the website's
 * privacy-friendly `daily_stats` counters (page views and Apply clicks per day),
 * joined to jobs by page path. No personal data is involved.
 */

const LIVE = sql`(${jobs.status} = 'published' and ${jobs.postedAt} <= now() and (${jobs.deadline} is null or ${jobs.deadline} + interval '1 day' > now()))`;

export interface CompanySummary extends CompanyRow {
  members: number;
  jobsTotal: number;
  jobsLive: number;
  jobsPending: number;
  views30: number;
  applies30: number;
  viewsAll: number;
  appliesAll: number;
}

export interface TrafficPoint {
  day: string;
  views: number;
  applies: number;
}

export interface JobPerformance {
  slug: string;
  title: string;
  state: ContentState;
  views30: number;
  applies30: number;
  viewsAll: number;
  appliesAll: number;
}

/** Every company with its job counts and traffic (super admin overview). */
export async function listCompanies(db: Database): Promise<CompanySummary[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select c.id,
      (select count(*) from ${users} u where u.company_id = c.id)::int as members,
      (select count(*) from ${jobs} where ${jobs.companyId} = c.id)::int as jobs_total,
      (select count(*) from ${jobs} where ${jobs.companyId} = c.id and ${LIVE})::int as jobs_live,
      (select count(*) from ${jobs} where ${jobs.companyId} = c.id and ${jobs.review} = 'pending')::int as jobs_pending,
      coalesce(sum(s.count) filter (where s.kind = 'view' and s.day > current_date - 30), 0)::int as views30,
      coalesce(sum(s.count) filter (where s.kind = 'apply_click' and s.day > current_date - 30), 0)::int as applies30,
      coalesce(sum(s.count) filter (where s.kind = 'view'), 0)::int as views_all,
      coalesce(sum(s.count) filter (where s.kind = 'apply_click'), 0)::int as applies_all
    from ${companies} c
    left join ${jobs} j on j.company_id = c.id
    left join daily_stats s on s.path = '/jobs/' || j.slug
    group by c.id`);
  const stats = new Map(result.rows.map((r) => [String(r.id), r]));
  const rows = await db.select().from(companies).orderBy(asc(companies.name));
  return rows.map((c) => {
    const s = stats.get(c.id) ?? {};
    const n = (k: string) => Number(s[k] ?? 0);
    return {
      ...c,
      members: n("members"),
      jobsTotal: n("jobs_total"),
      jobsLive: n("jobs_live"),
      jobsPending: n("jobs_pending"),
      views30: n("views30"),
      applies30: n("applies30"),
      viewsAll: n("views_all"),
      appliesAll: n("applies_all"),
    };
  });
}

/** Daily views and Apply clicks across one company's job pages, last 365 days. */
export async function getCompanyTraffic(
  db: Database,
  companyId: string,
): Promise<{ points: TrafficPoint[]; total: number }> {
  const result = await db.execute<{ day: string; views: number; applies: number }>(sql`
    select to_char(d.day, 'YYYY-MM-DD') as day,
      coalesce(sum(s.count) filter (where s.kind = 'view'), 0)::int as views,
      coalesce(sum(s.count) filter (where s.kind = 'apply_click'), 0)::int as applies
    from generate_series((now() at time zone 'utc')::date - 364, (now() at time zone 'utc')::date, '1 day') d(day)
    left join (
      select ds.day, ds.kind, ds.count from daily_stats ds
      join ${jobs} j on ds.path = '/jobs/' || j.slug
      where j.company_id = ${companyId}
    ) s on s.day = d.day
    group by d.day order by d.day`);
  const points = result.rows.map((r) => ({ day: r.day, views: Number(r.views), applies: Number(r.applies) }));
  return { points, total: points.reduce((n, p) => n + p.views + p.applies, 0) };
}

/** Per-job numbers for one company, best performing first. */
export async function getCompanyJobPerformance(db: Database, companyId: string): Promise<JobPerformance[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select j.slug, j.title, j.status, j.review, j.posted_at, j.deadline,
      coalesce(sum(s.count) filter (where s.kind = 'view' and s.day > current_date - 30), 0)::int as views30,
      coalesce(sum(s.count) filter (where s.kind = 'apply_click' and s.day > current_date - 30), 0)::int as applies30,
      coalesce(sum(s.count) filter (where s.kind = 'view'), 0)::int as views_all,
      coalesce(sum(s.count) filter (where s.kind = 'apply_click'), 0)::int as applies_all
    from ${jobs} j
    left join daily_stats s on s.path = '/jobs/' || j.slug
    where j.company_id = ${companyId}
    group by j.slug
    order by views_all desc, j.posted_at desc`);
  return result.rows.map((r) => ({
    slug: String(r.slug),
    title: String(r.title),
    state: jobState({
      status: String(r.status),
      review: r.review as string | null,
      postedAt: r.posted_at as string,
      deadline: r.deadline as string | null,
    }),
    views30: Number(r.views30),
    applies30: Number(r.applies30),
    viewsAll: Number(r.views_all),
    appliesAll: Number(r.applies_all),
  }));
}

/** Headline numbers for a company: live / in review, and the last 30 days vs the 30 before. */
export async function getCompanyTotals(db: Database, companyId: string) {
  const [counts, traffic] = await Promise.all([
    db
      .select({
        live: sql<number>`count(*) filter (where ${LIVE})`.mapWith(Number),
        pending: sql<number>`count(*) filter (where ${jobs.review} = 'pending')`.mapWith(Number),
        rejected: sql<number>`count(*) filter (where ${jobs.review} = 'rejected' and ${jobs.status} = 'draft')`.mapWith(
          Number,
        ),
        total: count(),
      })
      .from(jobs)
      .where(eq(jobs.companyId, companyId)),
    db.execute<Record<string, unknown>>(sql`
      select
        coalesce(sum(ds.count) filter (where ds.kind = 'view' and ds.day > current_date - 30), 0)::int as views,
        coalesce(sum(ds.count) filter (where ds.kind = 'apply_click' and ds.day > current_date - 30), 0)::int as applies,
        coalesce(sum(ds.count) filter (where ds.kind = 'view' and ds.day <= current_date - 30 and ds.day > current_date - 60), 0)::int as views_prev,
        coalesce(sum(ds.count) filter (where ds.kind = 'apply_click' and ds.day <= current_date - 30 and ds.day > current_date - 60), 0)::int as applies_prev
      from daily_stats ds join ${jobs} j on ds.path = '/jobs/' || j.slug
      where j.company_id = ${companyId}`),
  ]);
  const t = traffic.rows[0] ?? {};
  return {
    ...counts[0],
    views: Number(t.views ?? 0),
    applies: Number(t.applies ?? 0),
    viewsPrev: Number(t.views_prev ?? 0),
    appliesPrev: Number(t.applies_prev ?? 0),
  };
}

/** Members and pending invites of one company. */
export async function getCompanyPeople(db: Database, companyId: string) {
  const [members, pending] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, email: users.email, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.companyId, companyId))
      .orderBy(asc(users.createdAt)),
    db
      .select({ email: invites.email, name: invites.name, expiresAt: invites.expiresAt })
      .from(invites)
      .where(and(eq(invites.companyId, companyId), gt(invites.expiresAt, new Date())))
      .orderBy(asc(invites.createdAt)),
  ]);
  return { members, invites: pending };
}
