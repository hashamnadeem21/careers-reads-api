import { Controller, Get, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { count, eq } from "drizzle-orm";
import { z } from "zod";
import type { AuthUser } from "../auth/auth-user.js";
import { CurrentUser, StaffOnly } from "../auth/decorators.js";
import { ApiZodQuery, ZodPipe } from "../common/zod.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { jobs, messages, userPrefs } from "../db/schema.js";
import { resolveLayout } from "./dashboard-layout.js";
import * as queries from "./dashboard.queries.js";

export const ACTIVITY_PAGE_SIZE = 30;
const activityQuerySchema = z.object({
  page: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(1).default(1)),
});

/** The staff dashboard. Company accounts use `GET /companies/:id/dashboard`. */
@ApiTags("dashboard")
@Controller("dashboard")
@StaffOnly()
export class DashboardController {
  constructor(@InjectDb() private readonly db: Database) {}

  /** Everything the dashboard shows, plus this user's card layout. Traffic is 365 daily points. */
  @Get()
  async dashboard(@CurrentUser() user: AuthUser) {
    const [stats, traffic, topCategories, mix, recent, lists, featured, activity, [prefs]] = await Promise.all([
      queries.getStatCards(this.db),
      queries.getTraffic(this.db),
      queries.getTopJobCategories(this.db),
      queries.getContentMix(this.db),
      queries.getRecentContent(this.db),
      queries.getWorkLists(this.db),
      queries.getFeaturedJob(this.db),
      queries.getActivity(this.db, 8),
      this.db.select().from(userPrefs).where(eq(userPrefs.userId, user.id)).limit(1),
    ]);
    return {
      stats,
      traffic,
      topCategories,
      mix,
      recent,
      lists,
      featured,
      activity,
      layout: resolveLayout(prefs?.dashboardLayout),
    };
  }

  /** Sidebar counters: unread messages and company jobs waiting for review. */
  @Get("badges")
  async badges(): Promise<{ unreadMessages: number; pendingJobs: number }> {
    const [[{ unread }], [{ pending }]] = await Promise.all([
      this.db.select({ unread: count() }).from(messages).where(eq(messages.read, false)),
      this.db.select({ pending: count() }).from(jobs).where(eq(jobs.review, "pending")),
    ]);
    return { unreadMessages: unread, pendingJobs: pending };
  }
}

/** Who changed what, newest first. */
@ApiTags("dashboard")
@Controller("activity")
@StaffOnly()
export class ActivityController {
  constructor(@InjectDb() private readonly db: Database) {}

  /** 30 per page. */
  @Get()
  @ApiZodQuery(activityQuerySchema)
  async list(@Query(new ZodPipe(activityQuerySchema)) { page }: z.infer<typeof activityQuerySchema>) {
    const [items, total] = await Promise.all([
      queries.getActivity(this.db, ACTIVITY_PAGE_SIZE, (page - 1) * ACTIVITY_PAGE_SIZE),
      queries.countActivity(this.db),
    ]);
    return { items, total, page, pageSize: ACTIVITY_PAGE_SIZE };
  }
}
