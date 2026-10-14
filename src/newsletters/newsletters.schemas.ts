import { z } from "zod";
import { audienceSchema, EVERYONE } from "./audience.js";

/** A full https:// link or a path on the website ("/jobs"). Empty = not set. */
const link = (message: string) =>
  z
    .string()
    .trim()
    .max(500, "Keep the link under 500 characters")
    .refine((v) => v === "" || /^(https?:\/\/\S+|\/\S*)$/i.test(v), message)
    .default("");

/** The admin's newsletter form. Drafts may be incomplete; `assertSendable` checks before sending. */
export const newsletterBodySchema = z.object({
  subject: z.string().trim().min(1, "Add a subject").max(150, "Keep the subject under 150 characters"),
  previewText: z.string().trim().max(200, "Keep the preview text under 200 characters").default(""),
  body: z.string().max(100_000, "This newsletter is too long").default(""),
  heroImage: link("Pick an image from the media library or paste an https:// link").refine(
    (v) => !/\.svg(\?|#|$)/i.test(v),
    "Gmail and Outlook don't show SVG images. Pick a PNG or JPG",
  ),
  /** Without a label, a button with a link says "Read more". */
  ctaLabel: z.string().trim().max(40, "Keep the button text under 40 characters").default(""),
  ctaUrl: link("Use a full https:// link or a site path like /jobs"),
});
export type NewsletterBody = z.infer<typeof newsletterBodySchema>;

/** Live preview of unsaved edits. Same limits, but nothing is required. */
export const newsletterPreviewSchema = newsletterBodySchema.extend({ subject: z.string().max(150).default("") });

/** A test send goes to one address (the signed-in user's own by default). */
export const testSendSchema = z.object({ email: z.email("Enter a valid email").optional() });

const audienceField = { audience: audienceSchema.default(EVERYONE) };

/** Sending now: who to (default everyone active). The body is optional. */
export const sendSchema = z.object(audienceField).default({ audience: EVERYONE });
export type SendBody = z.infer<typeof sendSchema>;

/** Sending later. The service checks the time is in the future. */
export const scheduleSchema = z.object({
  ...audienceField,
  sendAt: z.iso
    .datetime({ offset: true, error: "Pick a date and time" })
    .transform((value) => new Date(value)),
});
export type ScheduleBody = z.infer<typeof scheduleSchema>;
