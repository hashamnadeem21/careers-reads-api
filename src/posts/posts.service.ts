import { HttpStatus, Injectable } from "@nestjs/common";
import { and, asc, count, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import type { AuthUser } from "../auth/auth-user.js";
import { ApiError } from "../common/api-error.js";
import { AuditService } from "../common/audit.service.js";
import { RevalidateSiteService } from "../common/revalidate-site.service.js";
import { copySlug, escapeLike } from "../common/slug.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { type ArticleRow, articles, authors, categories, dailyStats } from "../db/schema.js";
import { checkMdxBody } from "./mdx-check.js";
import { checkDraft, type PostIntent, resolvePublishing } from "./post-draft.js";
import type { bulkPostsSchema, PostListQuery, SavePostInput } from "./posts.schemas.js";

export const POST_PAGE_SIZE = 20;

const SORTS = { published: articles.publishedAt, title: articles.title, updated: articles.savedAt } as const;

function statusCondition(status: "live" | "draft" | "scheduled"): SQL {
  if (status === "draft") return eq(articles.status, "draft");
  if (status === "scheduled") return sql`(${articles.status} = 'published' and ${articles.publishedAt} > now())`;
  return sql`(${articles.status} = 'published' and ${articles.publishedAt} <= now())`;
}

export interface SavePostResult {
  slug: string;
  status: "draft" | "published";
  publishedAt: string;
  savedAt: string;
  message: string;
  /** False when the public site couldn't be told to refresh. */
  siteRefreshed: boolean;
  /** Images placed under headings that no longer exist (they show in the middle instead). */
  missingSections: number[];
}

const notFound = (message = "This post no longer exists. It may have been deleted.") =>
  new ApiError(HttpStatus.NOT_FOUND, "not_found", message);

const SAVE_MESSAGES: Record<Exclude<PostIntent, "schedule">, string> = {
  autosave: "Draft autosaved",
  draft: "Draft saved",
  publish: "Published",
  update: "Changes published",
  unpublish: "Unpublished. It's a draft again.",
};

/** Posts are staff-only. Every write: validate, write, audit, refresh the site if visitors could see it. */
@Injectable()
export class PostsService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly audit: AuditService,
    private readonly revalidateSite: RevalidateSiteService,
  ) {}

  /** Every page on the public site that can show these posts. */
  private async refreshSite(posts: { slug: string; category: string; author: string }[], extraSlugs: string[] = []) {
    const result = await this.revalidateSite.revalidate({
      tags: ["articles"],
      paths: [
        "/",
        "/blog",
        "/latest",
        "/trending",
        "/rss.xml",
        "/sitemap.xml",
        ...posts.flatMap((p) => [`/blog/${p.slug}`, `/category/${p.category}`, `/authors/${p.author}`]),
        ...extraSlugs.map((s) => `/blog/${s}`),
      ],
    });
    return result.ok;
  }

  async list(params: PostListQuery) {
    const where: SQL[] = [];
    if (params.q) {
      const p = `%${escapeLike(params.q)}%`;
      where.push(
        or(ilike(articles.title, p), ilike(articles.slug, p), sql`array_to_string(${articles.tags}, ' ') ilike ${p}`)!,
      );
    }
    if (params.status) where.push(statusCondition(params.status));
    if (params.category) where.push(eq(articles.category, params.category));
    const condition = where.length ? and(...where) : undefined;
    const column = SORTS[params.sort];
    const [rows, [{ total }], counts] = await Promise.all([
      this.db
        .select({
          slug: articles.slug,
          title: articles.title,
          category: articles.category,
          categoryName: categories.name,
          coverImage: articles.coverImage,
          status: articles.status,
          publishedAt: articles.publishedAt,
          savedAt: articles.savedAt,
          featured: articles.featured,
          authorName: authors.name,
        })
        .from(articles)
        .leftJoin(categories, eq(categories.slug, articles.category))
        .leftJoin(authors, eq(authors.slug, articles.author))
        .where(condition)
        .orderBy(params.dir === "asc" ? sql`${column} asc` : sql`${column} desc`, asc(articles.slug))
        .limit(POST_PAGE_SIZE)
        .offset((params.page - 1) * POST_PAGE_SIZE),
      this.db.select({ total: count() }).from(articles).where(condition),
      this.statusCounts(),
    ]);
    return { rows, total, page: params.page, pageSize: POST_PAGE_SIZE, counts };
  }

  /** Tab counts for the posts list: all, live, draft, scheduled. */
  async statusCounts() {
    const [row] = await this.db
      .select({
        all: count(),
        live: sql<number>`count(*) filter (where ${statusCondition("live")})`.mapWith(Number),
        draft: sql<number>`count(*) filter (where ${statusCondition("draft")})`.mapWith(Number),
        scheduled: sql<number>`count(*) filter (where ${statusCondition("scheduled")})`.mapWith(Number),
      })
      .from(articles);
    return row;
  }

  /** Blog categories and authors for the editor's dropdowns. */
  async editorOptions() {
    const [cats, people] = await Promise.all([
      this.db
        .select({ slug: categories.slug, name: categories.name })
        .from(categories)
        .where(eq(categories.kind, "blog"))
        .orderBy(asc(categories.sortOrder), asc(categories.name)),
      this.db.select({ slug: authors.slug, name: authors.name }).from(authors).orderBy(asc(authors.name)),
    ]);
    return { categories: cats, authors: people };
  }

  async get(slug: string): Promise<ArticleRow> {
    const [row] = await this.db.select().from(articles).where(eq(articles.slug, slug)).limit(1);
    if (!row) throw notFound();
    return row;
  }

  /** Create (`originalSlug` null) or update a post. Failed checks are a 400 with `fields`. */
  async save(user: AuthUser, originalSlug: string | null, input: SavePostInput): Promise<SavePostResult> {
    const { intent, scheduleAt, ...draft } = input;
    const existing = originalSlug ? await this.get(originalSlug) : undefined;
    // Autosave never changes what visitors see: it only works on drafts.
    if (intent === "autosave" && existing?.status === "published") {
      throw new ApiError(
        HttpStatus.CONFLICT,
        "autosave_published",
        "Published posts aren't autosaved. Use Update to publish your changes.",
      );
    }

    const now = new Date();
    const publishing = resolvePublishing(
      { status: existing?.status ?? "draft", publishedAt: existing?.publishedAt ?? null },
      intent,
      now,
      scheduleAt,
    );
    if ("error" in publishing) {
      throw new ApiError(HttpStatus.BAD_REQUEST, "validation_failed", publishing.error, {
        publishedAt: publishing.error,
      });
    }

    const check = checkDraft(draft, publishing);
    const errors = { ...check.errors };
    const [category, author, taken] = await Promise.all([
      this.db
        .select({ slug: categories.slug })
        .from(categories)
        .where(and(eq(categories.slug, draft.category), eq(categories.kind, "blog")))
        .limit(1),
      this.db.select({ slug: authors.slug }).from(authors).where(eq(authors.slug, draft.author)).limit(1),
      draft.slug !== originalSlug
        ? this.db.select({ slug: articles.slug }).from(articles).where(eq(articles.slug, draft.slug)).limit(1)
        : Promise.resolve([]),
    ]);
    if (!errors.body) {
      const mdxProblem = await checkMdxBody(draft.body);
      if (mdxProblem) errors.body = mdxProblem;
    }
    if (!category.length) errors.category ??= "Pick a category";
    if (!author.length) errors.author ??= "Pick an author";
    if (taken.length) errors.slug = "Another post already uses this slug";

    if (!check.data || Object.keys(errors).length) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        "validation_failed",
        intent === "autosave"
          ? "Not autosaved yet: some required fields are empty."
          : "Please fix the highlighted fields.",
        errors,
      );
    }

    const fm = check.data;
    const row = {
      slug: draft.slug,
      title: fm.title,
      excerpt: fm.excerpt,
      body: draft.body,
      category: fm.category,
      tags: fm.tags,
      author: fm.author,
      status: fm.status,
      publishedAt: new Date(fm.publishedAt),
      // A visible "Updated" date only when a live post is edited.
      updatedAt: existing?.status === "published" && intent === "update" ? now : (existing?.updatedAt ?? null),
      featured: fm.featured,
      trending: fm.trending,
      editorsPick: fm.editorsPick,
      coverImage: fm.coverImage,
      coverAlt: fm.coverAlt,
      coverWidth: fm.coverWidth,
      coverHeight: fm.coverHeight,
      images: fm.images.map((i) => ({ ...i, caption: i.caption ?? undefined })),
      seoTitle: fm.seoTitle ?? null,
      seoDescription: fm.seoDescription ?? null,
      canonicalUrl: fm.canonicalUrl ?? null,
      noindex: fm.noindex,
      ads: fm.ads,
      savedAt: now,
    };

    if (existing) {
      await this.db.transaction(async (tx) => {
        await tx.update(articles).set(row).where(eq(articles.slug, existing.slug));
        if (existing.slug !== draft.slug) {
          // Keep the post's stats when its URL changes.
          await tx
            .update(dailyStats)
            .set({ entitySlug: draft.slug, path: `/blog/${draft.slug}` })
            .where(eq(dailyStats.path, `/blog/${existing.slug}`));
        }
      });
    } else {
      await this.db.insert(articles).values({ ...row, createdBy: user.id });
    }

    const wasLive = existing?.status === "published";
    const isLive = row.status === "published";
    const action =
      intent === "autosave"
        ? null
        : intent === "schedule"
          ? "scheduled"
          : isLive && !wasLive
            ? "published"
            : !isLive && wasLive
              ? "unpublished"
              : existing
                ? "updated"
                : "created";
    if (action) await this.audit.log(user, action, "post", draft.slug, fm.title);

    // Drafts never appear on the site, so only refresh when something visible changed.
    const siteRefreshed =
      isLive || wasLive
        ? await this.refreshSite([row], existing && existing.slug !== draft.slug ? [existing.slug] : [])
        : true;

    const message =
      intent === "schedule"
        ? `Scheduled for ${row.publishedAt.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`
        : SAVE_MESSAGES[intent];
    return {
      slug: draft.slug,
      status: row.status,
      publishedAt: row.publishedAt.toISOString(),
      savedAt: now.toISOString(),
      message: siteRefreshed
        ? message
        : `${message}. The site couldn't be refreshed right now; it will update within the hour.`,
      siteRefreshed,
      missingSections: check.missingSections,
    };
  }

  async remove(user: AuthUser, slug: string): Promise<void> {
    const post = await this.get(slug).catch(() => {
      throw notFound("Already deleted.");
    });
    await this.db.transaction(async (tx) => {
      await tx.delete(articles).where(eq(articles.slug, post.slug));
      await tx.delete(dailyStats).where(eq(dailyStats.path, `/blog/${post.slug}`));
    });
    await this.audit.log(user, "deleted", "post", post.slug, post.title);
    if (post.status === "published") await this.refreshSite([post]);
  }

  /** Copies a post into a new draft ("… (copy)"), never featured. */
  async duplicate(user: AuthUser, slug: string): Promise<{ slug: string; message: string }> {
    const post = await this.get(slug);
    const newSlug = await copySlug(this.db, articles, articles.slug, post.slug);
    const { slug: _slug, createdAt: _c, createdBy: _b, savedAt: _s, updatedAt: _u, ...rest } = post;
    await this.db.insert(articles).values({
      ...rest,
      slug: newSlug,
      title: `${post.title} (copy)`.slice(0, 110),
      status: "draft",
      featured: false,
      trending: false,
      editorsPick: false,
      publishedAt: new Date(),
      createdBy: user.id,
    });
    await this.audit.log(user, "duplicated", "post", newSlug, post.title);
    return { slug: newSlug, message: "Copied as a new draft." };
  }

  async bulk(user: AuthUser, { action, slugs }: z.infer<typeof bulkPostsSchema>): Promise<{ message: string }> {
    const rows = await this.db.select().from(articles).where(inArray(articles.slug, slugs));
    if (!rows.length) throw notFound("Nothing to update.");
    const found = rows.map((r) => r.slug);
    if (action === "delete") {
      await this.db.transaction(async (tx) => {
        await tx.delete(articles).where(inArray(articles.slug, found));
        await tx.delete(dailyStats).where(
          inArray(
            dailyStats.path,
            found.map((s) => `/blog/${s}`),
          ),
        );
      });
    } else {
      const now = new Date();
      await this.db.transaction(async (tx) => {
        for (const r of rows) {
          await tx
            .update(articles)
            .set({
              status: action === "publish" ? "published" : "draft",
              publishedAt: action === "publish" && r.status === "draft" ? now : r.publishedAt,
              savedAt: now,
            })
            .where(eq(articles.slug, r.slug));
        }
      });
    }
    const verb = action === "delete" ? "deleted" : action === "publish" ? "published" : "unpublished";
    for (const r of rows) await this.audit.log(user, verb, "post", r.slug, r.title);
    await this.refreshSite(rows);
    return { message: `${rows.length} post${rows.length === 1 ? "" : "s"} ${verb}.` };
  }
}
