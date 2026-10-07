import { Body, Controller, HttpCode, HttpStatus, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import type { AuthUser } from "../auth/auth-user.js";
import { CurrentUser, StaffOnly } from "../auth/decorators.js";
import { ApiZodBody, ZodPipe } from "../common/zod.js";
import { dashboardLayoutSchema, type ResolvedLayout, resolveLayout } from "../dashboard/dashboard-layout.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { userPrefs } from "../db/schema.js";

const themeSchema = z.object({ theme: z.enum(["light", "dark", "system"]) });

/** The signed-in user's own preferences. */
@ApiTags("preferences")
@Controller("me")
export class PreferencesController {
  constructor(@InjectDb() private readonly db: Database) {}

  /** Any signed-in user. The admin mirrors it to its theme cookie. */
  @Put("theme")
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(themeSchema)
  async theme(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(themeSchema)) { theme }: z.infer<typeof themeSchema>,
  ): Promise<{ theme: string }> {
    await this.db
      .insert(userPrefs)
      .values({ userId: user.id, theme })
      .onConflictDoUpdate({ target: userPrefs.userId, set: { theme } });
    return { theme };
  }

  /** Dashboard card order, hidden cards and chart style. Returns the resolved layout. */
  @Put("dashboard-layout")
  @StaffOnly()
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(dashboardLayoutSchema)
  async dashboardLayout(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(dashboardLayoutSchema)) layout: z.infer<typeof dashboardLayoutSchema>,
  ): Promise<ResolvedLayout> {
    await this.db
      .insert(userPrefs)
      .values({ userId: user.id, dashboardLayout: layout })
      .onConflictDoUpdate({ target: userPrefs.userId, set: { dashboardLayout: layout } });
    return resolveLayout(layout);
  }
}
