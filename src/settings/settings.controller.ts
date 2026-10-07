import { Body, Controller, Get, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import type { AuthUser } from "../auth/auth-user.js";
import { CurrentUser, SuperAdminOnly } from "../auth/decorators.js";
import { ApiZodBody, formBody } from "../common/zod.js";
import { adsSettingsSchema, siteSettingsSchema } from "../shared/settings-schema.js";
import { SettingsService } from "./settings.service.js";

/** Field errors come back as `ads.clientId`, `site.social.x`, … */
const settingsSchema = z.object({ ads: adsSettingsSchema, site: siteSettingsSchema });

@ApiTags("settings")
@Controller("settings")
@SuperAdminOnly()
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get() {
    return this.settings.get();
  }

  @Put()
  @ApiZodBody(settingsSchema)
  save(@CurrentUser() user: AuthUser, @Body(formBody(settingsSchema)) body: z.infer<typeof settingsSchema>) {
    return this.settings.save(user, body.ads, body.site);
  }
}
