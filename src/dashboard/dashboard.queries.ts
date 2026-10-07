import { and, count, desc, eq, gt, lte, sql, type SQL } from "drizzle-orm";
import { articleState, type ContentState, daysLeft, jobState } from "../common/content-state.js";
import { isProduction } from "../config/env.js";
import type { Database } from "../db/client.js";
import { articles, auditLog, categories, jobs, messages, subscribers, users } from "../db/schema.js";

/**
 * Dashboard numbers (port of the admin's `lib/dashboard/queries.ts`). Everything comes from
 * real rows: when there is no data the admin shows an empty state, never a made-up figure.
 */

const WEEKS = 12;

export interface StatSummary {
  value: number;
  /** % change vs 30 days ago; null when there is nothing to compare with. */
  delta: number | null;
  /** Oldest → newest. */
  spark: number[];
}

function pctChange(now: number, before: number): number | null {
  if (before === 0) return null;
  return Math.round(((now - before) / before) * 1000) / 10;
}

/** SQL for "is this job publicly visible at time t" (mirrors isJobVisible on the site). */
function jobVisibleAt(t: SQL) {
  return sql`(${jobs.status} = 'published'
    and ${jobs.postedAt} <= ${t}
    and (${jobs.deadline} is null or ${jobs.deadline} + interval '1 day' > ${t})
    ${isProduction ? sql`and ${jobs.sample} = false` : sql``})`;
}

/** Week-end timestamps for the sparkline, oldest first, ending now. */
const weekEnds = sql`(select now() - make_interval(weeks => g) as t from generate_series(${WEEKS - 1}, 0, -1) g)`;

async function cumulativeSeries(db: Database, countAt: (t: SQL) => SQL): Promise<number[]> {
  const result = await db.execute<{ n: number }>(
    sql`select (${countAt(sql`w.t`)})::int as n from ${weekEnds} w order by w.t`,
  );
  return result.rows.map((r) => Number(r.n));
}

export async function getStatCards(db: Database) {
  const monthAgo = sql`now() - interval '30 days'`;
  const postsAt = (t: SQL) =>
    sql`select count(*) from ${articles} where ${articles.status} = 'published' and ${articles.publishedAt} <= ${t}`;
  const jobsAt = (t: SQL) => sql`select count(*) from ${jobs} where ${jobVisibleAt(t)}`;
  const subsAt = (t: SQL) => sql`select count(*) from ${subscribers} where ${subscribers.createdAt} <= ${t}`;

  const [posts, jobsSpark, subs, [{ unread }], messagesPerDay, prevRows] = await Promise.all([
    cumulativeSeries(db, postsAt),
    cumulativeSeries(db, jobsAt),
    cumulativeSeries(db, subsAt),
    db.select({ unread: count() }).from(messages).where(eq(messages.read, false)),
    db.execute<{ n: number }>(sql`
      select coalesce(count(m.id), 0)::int as n
      from generate_series((now() at time zone 'utc')::date - 13, (now() at time zone 'utc')::date, '1 day') d(day)
      left join ${messages} m on (m.created_at at time zone 'utc')::date = d.day
      group by d.day order by d.day`),
    db.execute<{ posts: number; jobs: number; subs: number }>(sql`
      select (${postsAt(monthAgo)})::int as posts, (${jobsAt(monthAgo)})::int as jobs, (${subsAt(monthAgo)})::int as subs`),
  ]);
  const prev = prevRows.rows[0];
  const summary = (spark: number[], before: number): StatSummary => {
    const value = spark.at(-1) ?? 0;
    return { value, delta: pctChange(value, Number(before)), spark };
  };
  return {
    posts: summary(posts, prev.posts),
    jobs: summary(jobsSpark, prev.jobs),
    subscribers: summary(subs, prev.subs),
    unreadMessages: {
      value: unread,
      delta: null,
      spark: messagesPerDay.rows.map((r) => Number(r.n)),
    } satisfies StatSummary,
  };
}

export interface TrafficPoint {
  day: string;
  views: number;
  applies: number;
}

/** Daily page views and apply clicks for the last 365 days (zeros filled in). The admin buckets them by range. */
export async function getTraffic(db: Database): Promise<{ points: TrafficPoint[]; total: number }> {
  const result = await db.execute<{ day: string; views: number; applies: number }>(sql`
    select to_char(d.day, 'YYYY-MM-DD') as day,
      coalesce(sum(s.count) filter (where s.kind = 'view'), 0)::int as views,
      coalesce(sum(s.count) filter (where s.kind = 'apply_click'), 0)::int as applies
    from generate_series((now() at time zone 'utc')::date - 364, (now() at time zone 'utc')::date, '1 day') d(day)
    left join daily_stats s on s.day = d.day
    group by d.day order by d.day`);
  const points = result.rows.map((r) => ({ day: r.day, views: Number(r.views), applies: Number(r.applies) }));
  return { points, total: points.reduce((n, p) => n + p.views + p.applies, 0) };
}

/** Job page views in the last 30 days, grouped by job category. */
export async function getTopJobCategories(db: Database, limit = 6) {
  const result = await db.execute<{ slug: string; name: string; value: number }>(sql`
    select c.slug, c.name, sum(s.count)::int as value
    from daily_stats s
    join ${jobs} j on j.slug = s.entity_slug
    join ${categories} c on c.slug = j.category
    where s.kind = 'view' and s.path like '/jobs/%' and s.day > (now() at time zone 'utc')::date - 30
    group by c.slug, c.name
    order by value desc
    limit ${limit}`);
  return result.rows.map((r) => ({ ...r, value: Number(r.value) }));
}

export type MixSlice = {
  slug: string;
  name: string;
  value: number;
};

/** Live posts and active jobs per category. */
export async function getContentMix(db: Database): Promise<{ posts: MixSlice[]; jobs: MixSlice[] }> {
  const [postRows, jobRows] = await Promise.all([
    db.execute<MixSlice>(sql`
      select c.slug, c.name, count(a.slug)::int as value
      from ${categories} c join ${articles} a on a.category = c.slug
      where a.status = 'published' and a.published_at <= now()
      group by c.slug, c.name order by value desc, c.name`),
    db.execute<MixSlice>(sql`
      select c.slug, c.name, count(${jobs.slug})::int as value
      from ${categories} c join ${jobs} on ${jobs.category} = c.slug
      where ${jobVisibleAt(sql`now()`)}
      group by c.slug, c.name order by value desc, c.name`),
  ]);
  const norm = (rows: MixSlice[]) => rows.map((r) => ({ ...r, value: Number(r.value) }));
  return { posts: norm(postRows.rows), jobs: norm(jobRows.rows) };
}

export interface ContentRow {
  kind: "post" | "job";
  slug: string;
  title: string;
  subtitle: string;
  image: string | null;
  date: string;
  state: ContentState;
  href: string;
}

export async function getRecentContent(db: Database, limit = 6): Promise<ContentRow[]> {
  const [posts, jobRows] = await Promise.all([
    db.select().from(articles).orderBy(desc(articles.savedAt)).limit(limit),
    db.select().from(jobs).orderBy(desc(jobs.updatedAt)).limit(limit),
  ]);
  const t = new Date();
  return [
    ...posts.map((p) => ({
      kind: "post" as const,
      slug: p.slug,
      title: p.title,
      subtitle: p.category,
      image: p.coverImage,
      date: p.savedAt.toISOString(),
      state: articleState(p, t),
      href: `/posts/${p.slug}`,
    })),
    ...jobRows.map((j) => ({
      kind: "job" as const,
      slug: j.slug,
      title: j.title,
      subtitle: j.company,
      image: null,
      date: j.updatedAt.toISOString(),
      state: jobState(j, t),
      href: `/jobs/${j.slug}`,
    })),
  ]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}

export interface ListItem {
  slug: string;
  title: string;
  href: string;
  meta: string;
  date: string | null;
}

/** Drafts, scheduled posts and jobs closing within 7 days. */
export async function getWorkLists(
  db: Database,
): Promise<{ drafts: ListItem[]; scheduled: ListItem[]; expiring: ListItem[] }> {
  const [draftPosts, draftJobs, scheduled, expiring] = await Promise.all([
    db.select().from(articles).where(eq(articles.status, "draft")).orderBy(desc(articles.savedAt)).limit(5),
    db.select().from(jobs).where(eq(jobs.status, "draft")).orderBy(desc(jobs.updatedAt)).limit(5),
    db
      .select()
      .from(articles)
      .where(and(eq(articles.status, "published"), gt(articles.publishedAt, sql`now()`)))
      .orderBy(articles.publishedAt)
      .limit(5),
    db
      .select()
      .from(jobs)
      .where(and(jobVisibleAt(sql`now()`), lte(jobs.deadline, sql`now() + interval '7 days'`)))
      .orderBy(jobs.deadline)
      .limit(5),
  ]);
  return {
    drafts: [
      ...draftPosts.map((p) => ({
        slug: p.slug,
        title: p.title,
        href: `/posts/${p.slug}`,
        meta: "Post",
        date: p.savedAt.toISOString(),
      })),
      ...draftJobs.map((j) => ({
        slug: j.slug,
        title: j.title,
        href: `/jobs/${j.slug}`,
        meta: "Job",
        date: j.updatedAt.toISOString(),
      })),
    ]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 5),
    scheduled: scheduled.map((p) => ({
      slug: p.slug,
      title: p.title,
      href: `/posts/${p.slug}`,
      meta: "Publishes",
      date: p.publishedAt.toISOString(),
    })),
    expiring: expiring.map((j) => {
      const left = daysLeft(j.deadline);
      return {
        slug: j.slug,
        title: j.title,
        href: `/jobs/${j.slug}`,
        meta: left === 0 ? "Closes today" : `Closes in ${left} day${left === 1 ? "" : "s"}`,
        date: j.deadline?.toISOString() ?? null,
      };
    }),
  };
}

export async function getFeaturedJob(db: Database) {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.featured, true), jobVisibleAt(sql`now()`)))
    .orderBy(sql`${jobs.deadline} asc nulls last`, desc(jobs.postedAt))
    .limit(1);
  if (!job) return null;
  return {
    slug: job.slug,
    title: job.title,
    company: job.company,
    location: job.city ? `${job.city}, ${job.country}` : job.country,
    daysLeft: daysLeft(job.deadline),
  };
}

export interface ActivityItem {
  id: number;
  userName: string | null;
  action: string;
  entity: string;
  label: string | null;
  /** Admin path for the changed thing, or null (deleted, or no page). */
  href: string | null;
  createdAt: string;
}

const entityHref: Record<string, (slug: string) => string> = {
  job: (s) => `/jobs/${s}`,
  post: (s) => `/posts/${s}`,
  category: () => "/categories",
  author: () => "/authors",
  media: () => "/media",
  settings: () => "/settings",
  user: () => "/users",
  company: (id) => `/companies/${id}`,
};

export async function getActivity(db: Database, limit = 8, offset = 0): Promise<ActivityItem[]> {
  const rows = await db
    .select({
      id: auditLog.id,
      userName: users.name,
      action: auditLog.action,
      entity: auditLog.entity,
      entitySlug: auditLog.entitySlug,
      label: auditLog.label,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit)
    .offset(offset);
  return rows.map((r) => ({
    id: r.id,
    userName: r.userName,
    action: r.action,
    entity: r.entity,
    label: r.label,
    href: r.entitySlug && r.action !== "deleted" ? (entityHref[r.entity]?.(r.entitySlug) ?? null) : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function countActivity(db: Database): Promise<number> {
  const [{ total }] = await db.select({ total: count() }).from(auditLog);
  return total;
}
