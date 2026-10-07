import { HttpStatus, Injectable } from "@nestjs/common";
import { asc, count, eq } from "drizzle-orm";
import type { AuthUser } from "../auth/auth-user.js";
import { ApiError } from "../common/api-error.js";
import { AuditService } from "../common/audit.service.js";
import { RevalidateSiteService } from "../common/revalidate-site.service.js";
import { FORM_ERROR } from "../common/zod.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { articles, type AuthorRow, authors } from "../db/schema.js";
import { authorSchema } from "../shared/content/schema.js";
import type { AuthorBody } from "./authors.schemas.js";

const notFound = (message = "This author no longer exists.") =>
  new ApiError(HttpStatus.NOT_FOUND, "not_found", message);

/** Bylines. Staff only. */
@Injectable()
export class AuthorsService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly audit: AuditService,
    private readonly revalidateSite: RevalidateSiteService,
  ) {}

  private refreshSite(...slugs: string[]) {
    return this.revalidateSite.revalidate({
      tags: ["authors", "articles"],
      paths: ["/", "/about", "/blog", "/sitemap.xml", ...slugs.map((s) => `/authors/${s}`)],
    });
  }

  /** Every author by name, each with how many posts they wrote. */
  async list(): Promise<(AuthorRow & { posts: number })[]> {
    const [rows, counts] = await Promise.all([
      this.db.select().from(authors).orderBy(asc(authors.name)),
      this.db.select({ slug: articles.author, n: count() }).from(articles).groupBy(articles.author),
    ]);
    const posts = new Map(counts.map((c) => [c.slug, c.n]));
    return rows.map((a) => ({ ...a, posts: posts.get(a.slug) ?? 0 }));
  }

  /** Validated with the site's own authorSchema. A renamed slug follows into posts (ON UPDATE CASCADE). */
  async save(
    user: AuthUser,
    originalSlug: string | null,
    input: AuthorBody,
  ): Promise<{ message: string; author: AuthorRow }> {
    const blank = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);
    const parsed = authorSchema.safeParse({
      slug: input.slug,
      name: input.name,
      type: input.type,
      role: input.role,
      bio: input.bio,
      avatar: input.avatar,
      links: { website: blank(input.links.website), x: blank(input.links.x), linkedin: blank(input.links.linkedin) },
    });
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        fields[issue.path.join(".")] ??= issue.path[0] === "avatar" ? "Choose a photo or logo" : issue.message;
      }
      throw new ApiError(HttpStatus.BAD_REQUEST, "validation_failed", FORM_ERROR, fields);
    }
    const data = parsed.data;
    if (data.slug !== originalSlug) {
      const [taken] = await this.db
        .select({ slug: authors.slug })
        .from(authors)
        .where(eq(authors.slug, data.slug))
        .limit(1);
      if (taken) {
        throw new ApiError(HttpStatus.CONFLICT, "slug_taken", "That slug is taken.", {
          slug: "Another author already uses this slug",
        });
      }
    }
    const links = Object.fromEntries(Object.entries(data.links).filter(([, v]) => v));
    let author: AuthorRow | undefined;
    if (originalSlug) {
      [author] = await this.db
        .update(authors)
        .set({ ...data, links })
        .where(eq(authors.slug, originalSlug))
        .returning();
      if (!author) throw notFound();
    } else {
      [author] = await this.db
        .insert(authors)
        .values({ ...data, links })
        .returning();
    }
    await this.audit.log(user, originalSlug ? "updated" : "created", "author", data.slug, data.name);
    await this.refreshSite(data.slug, ...(originalSlug && originalSlug !== data.slug ? [originalSlug] : []));
    return { message: originalSlug ? "Author saved." : "Author added.", author };
  }

  /** Blocked (409 `in_use`) while the author has posts. */
  async remove(user: AuthUser, slug: string): Promise<void> {
    const [author] = await this.db.select().from(authors).where(eq(authors.slug, slug)).limit(1);
    if (!author) throw notFound("Already deleted.");
    const [{ n }] = await this.db.select({ n: count() }).from(articles).where(eq(articles.author, author.slug));
    if (n > 0) {
      throw new ApiError(
        HttpStatus.CONFLICT,
        "in_use",
        `${author.name} is the author of ${n} post${n === 1 ? "" : "s"}. Reassign them first.`,
      );
    }
    await this.db.delete(authors).where(eq(authors.slug, author.slug));
    await this.audit.log(user, "deleted", "author", author.slug, author.name);
    await this.refreshSite(author.slug);
  }
}
