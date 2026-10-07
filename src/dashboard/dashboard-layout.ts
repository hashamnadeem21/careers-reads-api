import { z } from "zod";
import type { DashboardLayout } from "../db/schema.js";

/** Every dashboard card a user can show, hide and reorder (labels live in the admin). */
export const DASHBOARD_CARD_IDS = [
  "stats",
  "traffic",
  "top-categories",
  "content-mix",
  "recent",
  "drafts",
  "scheduled",
  "expiring",
  "rail",
] as const;
export type DashboardCardId = (typeof DASHBOARD_CARD_IDS)[number];

const cardId = z.enum(DASHBOARD_CARD_IDS);

export const dashboardLayoutSchema = z.object({
  order: z.array(cardId).max(DASHBOARD_CARD_IDS.length),
  hidden: z.array(cardId).max(DASHBOARD_CARD_IDS.length),
  mixStyle: z.enum(["bubble", "donut"]).optional(),
});

export interface ResolvedLayout {
  order: DashboardCardId[];
  hidden: DashboardCardId[];
  mixStyle: "bubble" | "donut";
}

/** Fills in cards added after the user last saved, drops unknown ids and duplicates. */
export function resolveLayout(saved: DashboardLayout | null | undefined): ResolvedLayout {
  const parsed = dashboardLayoutSchema.safeParse(saved ?? {});
  const order = parsed.success ? parsed.data.order.filter((id, i, all) => all.indexOf(id) === i) : [];
  return {
    order: [...order, ...DASHBOARD_CARD_IDS.filter((id) => !order.includes(id))],
    hidden: parsed.success ? parsed.data.hidden : [],
    mixStyle: (parsed.success && parsed.data.mixStyle) || "donut",
  };
}
