import { z } from "zod";
import { automationTrigger } from "../db/schema.js";
import { newsletterBodySchema } from "../newsletters/newsletters.schemas.js";

/** Up to 90 days after the trigger. */
export const MAX_DELAY_MINUTES = 90 * 24 * 60;

const instant = z.iso
  .datetime({ offset: true, error: "Pick a valid date" })
  .nullish()
  .transform((value) => (value ? new Date(value) : null));

/** The admin's automation form: the email (same fields as a newsletter) plus when it fires. */
export const automationBodySchema = newsletterBodySchema
  .extend({
    name: z.string().trim().min(1, "Give it a name").max(80, "Keep the name under 80 characters"),
    trigger: z.enum(automationTrigger.enumValues).default("subscribed"),
    delayMinutes: z
      .number({ error: "Enter a delay" })
      .int("Whole minutes only")
      .min(0, "The delay can't be negative")
      .max(MAX_DELAY_MINUTES, "Keep the delay under 90 days")
      .default(0),
    /** Launch date: triggers before it are ignored. Empty = as soon as it's switched on. */
    startsAt: instant,
    endsAt: instant,
  })
  .refine((a) => !a.startsAt || !a.endsAt || a.startsAt < a.endsAt, {
    path: ["endsAt"],
    message: "The end date must be after the launch date",
  });
export type AutomationBody = z.infer<typeof automationBodySchema>;

export const automationStatusSchema = z.object({ active: z.boolean() });
