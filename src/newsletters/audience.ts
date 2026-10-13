import { and, gte, isNull, lt, type SQL } from "drizzle-orm";
import { z } from "zod";
import { subscribers } from "../db/schema.js";

const instant = z.iso
  .datetime({ offset: true, error: "Pick a valid date" })
  .nullish()
  .transform((value) => (value ? new Date(value) : null));

/**
 * Who a newsletter goes to: active subscribers who signed up in [from, to). Leave both empty for
 * everyone. The admin sends day boundaries in the editor's timezone.
 */
export const audienceSchema = z
  .object({ from: instant, to: instant })
  .refine((a) => !a.from || !a.to || a.from < a.to, { path: ["to"], message: "The end date must be after the start date" });
export type Audience = z.infer<typeof audienceSchema>;

export const EVERYONE: Audience = { from: null, to: null };

/** Active subscribers in the audience. */
export function audienceWhere({ from, to }: Audience): SQL {
  return and(
    isNull(subscribers.unsubscribedAt),
    from ? gte(subscribers.createdAt, from) : undefined,
    to ? lt(subscribers.createdAt, to) : undefined,
  ) as SQL;
}
