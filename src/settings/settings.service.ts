import { HttpStatus, Injectable } from "@nestjs/common";
import type { AuthUser } from "../auth/auth-user.js";
import { ApiError } from "../common/api-error.js";
import { AuditService } from "../common/audit.service.js";
import { RevalidateSiteService } from "../common/revalidate-site.service.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { settings } from "../db/schema.js";
import {
  type AdsSettings,
  adsSettingsSchema,
  type SiteSettings,
  siteSettingsSchema,
} from "../shared/settings-schema.js";

export const DEFAULT_ADS: AdsSettings = {
  enabled: false,
  showPlaceholders: false,
  clientId: "",
  slots: { "in-article": "", sidebar: "", "below-article": "", listing: "" },
};
export const DEFAULT_SITE: SiteSettings = { contactEmail: "", social: { x: "", linkedin: "", github: "" } };

/** Ads and site settings. Super admins only. */
@Injectable()
export class SettingsService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly audit: AuditService,
    private readonly revalidateSite: RevalidateSiteService,
  ) {}

  /** Saved settings, or defaults. Empty values mean the site uses its environment variables. */
  async get(): Promise<{ ads: AdsSettings; site: SiteSettings }> {
    const rows = await this.db.select().from(settings);
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const ads = adsSettingsSchema.safeParse(byKey.get("ads"));
    const site = siteSettingsSchema.safeParse(byKey.get("site"));
    return { ads: ads.success ? ads.data : DEFAULT_ADS, site: site.success ? site.data : DEFAULT_SITE };
  }

  /** Saves both, then refreshes every page that shows them. */
  async save(user: AuthUser, ads: AdsSettings, site: SiteSettings): Promise<{ message: string }> {
    if (ads.enabled && !ads.clientId) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        "validation_failed",
        "Add your AdSense client ID before turning ads on.",
        { "ads.clientId": "Required when ads are on" },
      );
    }
    await this.db.transaction(async (tx) => {
      for (const [key, value] of [
        ["ads", ads],
        ["site", site],
      ] as const) {
        await tx.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
      }
    });
    await this.audit.log(user, "updated", "settings", null, "Site settings");
    const refreshed = await this.revalidateSite.revalidate({
      tags: ["settings"],
      paths: ["/", "/ads.txt", "/contact", "/about", "/privacy-policy"],
    });
    return {
      message: refreshed.ok
        ? "Settings saved. The site is updated."
        : "Settings saved. The site will pick them up within the hour.",
    };
  }
}
