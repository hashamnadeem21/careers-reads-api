import { HttpStatus, Injectable } from "@nestjs/common";
import { asc, count, eq } from "drizzle-orm";
import type { AuthUser } from "../auth/auth-user.js";
import { ApiError } from "../common/api-error.js";
import { AuditService } from "../common/audit.service.js";
import { RevalidateSiteService } from "../common/revalidate-site.service.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { articles, categories, type CategoryRow, jobs } from "../db/schema.js";
import type { CategoryInput } from "./categories.schemas.js";

const notFound = (message = "This category no longer exists.") =>
  new ApiError(HttpStatus.NOT_FOUND, "not_found", message);

/** Blog and job categories. Staff only. */
@Injectable()
export class CategoriesService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly audit: AuditService,
    private readonly revalidateSite: RevalidateSiteService,
  ) {}

  /** Category names appear across the site (menus, cards, filters), so refresh broadly. */
  private refreshSite(kind: "blog" | "job", ...slugs: string[]) {
    return this.revalidateSite.revalidate({
      tags: ["categories", kind === "blog" ? "articles" : "jobs"],
      paths: [
        "/",
        "/sitemap.xml",
        ...(kind === "blog" ? ["/blog", "/about", ...slugs.map((s) => `/category/${s}`)] : ["/jobs"]),
      ],
    });
  }

  /** Every category in display order, with how many posts or jobs use it. */
  async list(kind?: "blog" | "job"): Promise<(CategoryRow & { used: number })[]> {
    const [rows, postCounts, jobCounts] = await Promise.all([
      this.db
        .select()
        .from(categories)
        .where(kind ? eq(categories.kind, kind) : undefined)
        .orderBy(asc(categories.sortOrder), asc(categories.name)),
      this.db.select({ slug: articles.category, n: count() }).from(articles).groupBy(articles.category),
      this.db.select({ slug: jobs.category, n: count() }).from(jobs).groupBy(jobs.category),
    ]);
    const used = new Map<string, number>();
    for (const r of [...postCounts, ...jobCounts]) used.set(r.slug, (used.get(r.slug) ?? 0) + r.n);
    return rows.map((c) => ({ ...c, used: used.get(c.slug) ?? 0 }));
  }

  /** Create (`originalSlug` null) or update. Renamed slugs follow into posts and jobs (ON UPDATE CASCADE). */
  async save(
    user: AuthUser,
    originalSlug: string | null,
    data: CategoryInput,
  ): Promise<{ message: string; category: CategoryRow }> {
    if (data.slug !== originalSlug) {
      const [taken] = await this.db
        .select({ slug: categories.slug })
        .from(categories)
        .where(eq(categories.slug, data.slug))
        .limit(1);
      if (taken) {
        throw new ApiError(HttpStatus.CONFLICT, "slug_taken", "That slug is taken.", {
          slug: "Another category (blog or job) already uses this slug",
        });
      }
    }
    const values = {
      slug: data.slug,
      kind: data.kind,
      name: data.name,
      headline: data.kind === "blog" ? data.headline : null,
      description: data.description,
      accent: data.kind === "blog" ? data.accent : null,
    };
    let category: CategoryRow;
    if (originalSlug) {
      const [existing] = await this.db.select().from(categories).where(eq(categories.slug, originalSlug)).limit(1);
      if (!existing) throw notFound();
      if (existing.kind !== data.kind) {
        throw new ApiError(HttpStatus.CONFLICT, "kind_change", "A category can't move between blog and jobs.");
      }
      [category] = await this.db.update(categories).set(values).where(eq(categories.slug, originalSlug)).returning();
    } else {
      const [{ n }] = await this.db.select({ n: count() }).from(categories).where(eq(categories.kind, data.kind));
      [category] = await this.db
        .insert(categories)
        .values({ ...values, sortOrder: n })
        .returning();
    }
    await this.audit.log(user, originalSlug ? "updated" : "created", "category", data.slug, data.name);
    await this.refreshSite(data.kind, data.slug, ...(originalSlug && originalSlug !== data.slug ? [originalSlug] : []));
    return { message: originalSlug ? "Category saved." : "Category added.", category };
  }

  /** `slugs` must be exactly the categories of that kind, in their new order. */
  async reorder(user: AuthUser, kind: "blog" | "job", order: string[]): Promise<{ message: string }> {
    const rows = await this.db.select({ slug: categories.slug }).from(categories).where(eq(categories.kind, kind));
    const known = new Set(rows.map((r) => r.slug));
    if (order.length !== known.size || new Set(order).size !== order.length || !order.every((s) => known.has(s))) {
      throw new ApiError(HttpStatus.CONFLICT, "list_changed", "The list changed. Reload and try again.");
    }
    await this.db.transaction(async (tx) => {
      for (const [i, slug] of order.entries()) {
        await tx.update(categories).set({ sortOrder: i }).where(eq(categories.slug, slug));
      }
    });
    await this.audit.log(user, "reordered", "category", null, `${kind} categories`);
    await this.refreshSite(kind, ...order);
    return { message: "Order saved." };
  }

  /** Blocked (409 `in_use`) while any post or job uses the category. */
  async remove(user: AuthUser, slug: string): Promise<void> {
    const [cat] = await this.db.select().from(categories).where(eq(categories.slug, slug)).limit(1);
    if (!cat) throw notFound("Already deleted.");
    const [[posts], [jobRows]] = await Promise.all([
      this.db.select({ n: count() }).from(articles).where(eq(articles.category, cat.slug)),
      this.db.select({ n: count() }).from(jobs).where(eq(jobs.category, cat.slug)),
    ]);
    const used = posts.n + jobRows.n;
    if (used > 0) {
      throw new ApiError(
        HttpStatus.CONFLICT,
        "in_use",
        `"${cat.name}" is used by ${used} ${cat.kind === "blog" ? "post" : "job"}${used === 1 ? "" : "s"}. Move them to another category first.`,
      );
    }
    await this.db.delete(categories).where(eq(categories.slug, cat.slug));
    await this.audit.log(user, "deleted", "category", cat.slug, cat.name);
    await this.refreshSite(cat.kind, cat.slug);
  }
}
