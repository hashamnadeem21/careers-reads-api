import { HttpStatus, Injectable } from "@nestjs/common";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { ApiError } from "../common/api-error.js";
import { limitKey, RateLimitService } from "../common/rate-limit.service.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import {
  articles,
  authors,
  categories,
  jobs,
  messages,
  settings,
  subscribers,
  type CategoryRow,
} from "../db/schema.js";
import type { Article, ArticleSummary, Author } from "../shared/content/schema.js";
import { isPubliclyVisible, toSummary } from "../shared/content/visibility.js";
import type { Job } from "../shared/jobs/schema.js";
import { isJobVisible } from "../shared/jobs/visibility.js";
import {
  adsSettingsSchema,
  siteSettingsSchema,
  type AdsSettings,
  type SiteSettings,
} from "../shared/settings-schema.js";
import { rowToArticle, rowToAuthor, rowToJob } from "./mappers.js";
import type { contactSchema, statsSchema } from "./public.schemas.js";

const FORM_WINDOW_SECONDS = 10 * 60;

/** Crawlers and link previews never count as visits. */
const BOT_PATTERN =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora link preview|lighthouse|pingdom|uptime/i;

const notFound = (what: string) => new ApiError(HttpStatus.NOT_FOUND, "not_found", `This ${what} doesn't exist.`);

export type PublicCategory = Pick<CategoryRow, "slug" | "kind" | "name" | "headline" | "description" | "accent">;

/**
 * Everything the website reads and the few things it writes. Visibility is decided here,
 * never by the caller: drafts, scheduled posts and expired jobs are only ever returned
 * to the website's server when it asks for a preview.
 */
@Injectable()
export class PublicService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** Newest first. With `preview`, drafts and scheduled posts are included. */
  async listArticles(preview: boolean): Promise<Article[]> {
    const rows = await this.db.select().from(articles).orderBy(desc(articles.publishedAt));
    const now = new Date();
    return rows.map(rowToArticle).filter((a): a is Article => a !== null && (preview || isPubliclyVisible(a, now)));
  }

  async listArticleSummaries(preview: boolean): Promise<ArticleSummary[]> {
    return (await this.listArticles(preview)).map(toSummary);
  }

  async getArticle(slug: string, preview: boolean): Promise<Article> {
    const [row] = await this.db.select().from(articles).where(eq(articles.slug, slug)).limit(1);
    const article = row ? rowToArticle(row) : null;
    if (!article || (!preview && !isPubliclyVisible(article))) throw notFound("article");
    return article;
  }

  /** Visible jobs: featured first, then newest. Drafts, future and expired jobs never appear. */
  async listJobs(): Promise<Job[]> {
    const rows = await this.db.select().from(jobs).orderBy(desc(jobs.featured), desc(jobs.postedAt));
    const now = new Date();
    return rows.map(rowToJob).filter((j): j is Job => j !== null && isJobVisible(j, now));
  }

  async getJob(slug: string): Promise<Job> {
    const [row] = await this.db.select().from(jobs).where(eq(jobs.slug, slug)).limit(1);
    const job = row ? rowToJob(row) : null;
    if (!job || !isJobVisible(job)) throw notFound("job");
    return job;
  }

  /** Blog and job categories in display order. */
  listCategories(): Promise<PublicCategory[]> {
    return this.db
      .select({
        slug: categories.slug,
        kind: categories.kind,
        name: categories.name,
        headline: categories.headline,
        description: categories.description,
        accent: categories.accent,
      })
      .from(categories)
      .orderBy(asc(categories.sortOrder), asc(categories.name));
  }

  async listAuthors(): Promise<Author[]> {
    const rows = await this.db.select().from(authors).orderBy(asc(authors.name));
    return rows.map(rowToAuthor).filter((a): a is Author => a !== null);
  }

  async getAuthor(slug: string): Promise<Author> {
    const [row] = await this.db.select().from(authors).where(eq(authors.slug, slug)).limit(1);
    const author = row ? rowToAuthor(row) : null;
    if (!author) throw notFound("author");
    return author;
  }

  /** Ads and site settings; a missing or invalid value is null, so the website falls back to its env. */
  async getSettings(): Promise<{ ads: AdsSettings | null; site: SiteSettings | null }> {
    const rows = await this.db.select().from(settings);
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const ads = adsSettingsSchema.safeParse(byKey.get("ads"));
    const site = siteSettingsSchema.safeParse(byKey.get("site"));
    return { ads: ads.success ? ads.data : null, site: site.success ? site.data : null };
  }

  /** Saves a contact form message to the admin's inbox. 3 per visitor per 10 minutes. */
  async contact(ip: string, input: z.infer<typeof contactSchema>): Promise<void> {
    await this.rateLimit.enforce(
      limitKey("contact", ip),
      3,
      FORM_WINDOW_SECONDS,
      "Too many messages. Please try again in a few minutes.",
    );
    await this.db
      .insert(messages)
      .values({ name: input.name, email: input.email, topic: input.topic || null, message: input.message });
  }

  /** Adds a newsletter subscriber (signing up twice is fine). 5 per visitor per 10 minutes. */
  async subscribe(ip: string, email: string): Promise<void> {
    await this.rateLimit.enforce(
      limitKey("newsletter", ip),
      5,
      FORM_WINDOW_SECONDS,
      "Too many attempts. Please try again in a few minutes.",
    );
    await this.db
      .insert(subscribers)
      .values({ email: email.toLowerCase() })
      .onConflictDoNothing({ target: subscribers.email });
  }

  /**
   * Adds 1 to today's counter for a page. Counts per page per day only: no cookies, IPs or
   * user agents are stored. Bots are ignored; junk or hidden pages are refused.
   * Returns false when the hit was ignored (a bot).
   */
  async recordStat(ip: string, userAgent: string, input: z.infer<typeof statsSchema>): Promise<boolean> {
    if (!userAgent || BOT_PATTERN.test(userAgent)) return false;
    await this.rateLimit.enforce(limitKey("stats", ip), 120, 60, "Too many requests.");

    const [section, slug] = input.path.slice(1).split("/");
    if (input.kind === "apply_click" && section !== "jobs") {
      throw new ApiError(HttpStatus.BAD_REQUEST, "bad_request", "Apply clicks are only counted on jobs.");
    }
    // Only pages that really exist and are public, so junk paths never reach the table.
    if (section === "blog") await this.getArticle(slug, false);
    else await this.getJob(slug);

    await this.db.execute(sql`
      insert into daily_stats (day, path, kind, entity_slug, count)
      values ((now() at time zone 'utc')::date, ${input.path}, ${input.kind}, ${slug}, 1)
      on conflict (day, path, kind) do update set count = daily_stats.count + 1
    `);
    return true;
  }
}
