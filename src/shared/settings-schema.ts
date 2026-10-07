// Owned by blognest-api (originally blognest/src/lib/settings-schema.ts). The website keeps its own copy for its file fallback; keep the rules in step.
import { z } from "zod";

/**
 * Shape of the editable site settings stored in the `settings` table (one row per key).
 * The admin panel validates its Settings form with these schemas, and the site parses
 * stored values with them (falling back to environment variables).
 */
const slotId = z.union([z.literal(""), z.string().trim().regex(/^\d{6,20}$/, "Slot IDs are numbers, e.g. 1234567890")]);
const optionalUrl = z.union([z.literal(""), z.url("Use a full URL starting with https://")]);

export const AD_PLACEMENTS = ["in-article", "sidebar", "below-article", "listing"] as const;

export const adsSettingsSchema = z.object({
  /** Request real ads (production only, and only with a client ID). */
  enabled: z.boolean(),
  /** Show labelled empty boxes where ads will go. Visitors see them too. */
  showPlaceholders: z.boolean(),
  clientId: z.union([z.literal(""), z.string().trim().regex(/^ca-pub-\d{10,20}$/, "AdSense client IDs look like ca-pub-0000000000000000")]),
  slots: z.object({
    "in-article": slotId,
    sidebar: slotId,
    "below-article": slotId,
    listing: slotId,
  }),
});
export type AdsSettings = z.infer<typeof adsSettingsSchema>;

export const siteSettingsSchema = z.object({
  contactEmail: z.union([z.literal(""), z.email("Enter a valid email")]),
  social: z.object({ x: optionalUrl, linkedin: optionalUrl, github: optionalUrl }),
});
export type SiteSettings = z.infer<typeof siteSettingsSchema>;

export const SETTINGS_SCHEMAS = { ads: adsSettingsSchema, site: siteSettingsSchema } as const;
export type SettingsKey = keyof typeof SETTINGS_SCHEMAS;
