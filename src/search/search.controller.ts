import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { and, desc, ilike, or } from "drizzle-orm";
import { z } from "zod";
import type { AuthUser } from "../auth/auth-user.js";
import { CurrentUser } from "../auth/decorators.js";
import { escapeLike } from "../common/slug.js";
import { ApiZodQuery, ZodPipe } from "../common/zod.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { articles, jobs } from "../db/schema.js";
import { jobScope } from "../jobs/job-access.js";

export interface SearchHit {
  kind: "post" | "job";
  slug: string;
  title: string;
  href: string;
}

const searchQuerySchema = z.object({ q: z.string().default("") });

@ApiTags("search")
@Controller("search")
export class SearchController {
  constructor(@InjectDb() private readonly db: Database) {}

  /** Title/slug search for the ⌘K palette: posts and jobs for staff, only their own jobs for companies. */
  @Get()
  @ApiBearerAuth()
  @ApiZodQuery(searchQuerySchema)
  async search(
    @CurrentUser() user: AuthUser,
    @Query(new ZodPipe(searchQuerySchema)) query: z.infer<typeof searchQuerySchema>,
  ): Promise<SearchHit[]> {
    const q = query.q.trim().slice(0, 80);
    if (q.length < 2) return [];
    const pattern = `%${escapeLike(q)}%`;
    const [posts, jobRows] = await Promise.all([
      user.role !== "company"
        ? this.db
            .select({ slug: articles.slug, title: articles.title })
            .from(articles)
            .where(or(ilike(articles.title, pattern), ilike(articles.slug, pattern)))
            .orderBy(desc(articles.savedAt))
            .limit(6)
        : Promise.resolve([]),
      this.db
        .select({ slug: jobs.slug, title: jobs.title, company: jobs.company })
        .from(jobs)
        .where(
          and(jobScope(user), or(ilike(jobs.title, pattern), ilike(jobs.company, pattern), ilike(jobs.slug, pattern))),
        )
        .orderBy(desc(jobs.updatedAt))
        .limit(6),
    ]);
    return [
      ...posts.map((p) => ({ kind: "post" as const, slug: p.slug, title: p.title, href: `/posts/${p.slug}` })),
      ...jobRows.map((j) => ({
        kind: "job" as const,
        slug: j.slug,
        title: `${j.title} · ${j.company}`,
        href: `/jobs/${j.slug}`,
      })),
    ];
  }
}
