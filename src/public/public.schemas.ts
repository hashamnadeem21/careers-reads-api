import { z } from "zod";

/** `?preview=1`: drafts and scheduled posts too. Only honoured for the website's server key. */
export const articlesQuerySchema = z.object({
  preview: z.enum(["1", "true", "0", "false"]).optional(),
  /** `summary` drops the MDX body and table of contents. */
  view: z.enum(["full", "summary"]).default("full"),
});

export const articleQuerySchema = articlesQuerySchema.pick({ preview: true });

/** Trim/lowercase BEFORE validating, so pasted addresses with stray spaces are accepted. */
const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "Email address is too long.")
  .pipe(z.email("Please enter a valid email address."));

export const contactTopics = ["general", "feedback", "correction", "advertising", "partnership"] as const;

/** The website checks the honeypot and fill time itself; the API stores what passes. */
export const contactSchema = z.object({
  name: z.string().trim().min(2, "Please enter your name.").max(80, "Name is too long."),
  email: emailField,
  topic: z.enum(contactTopics, { error: "Please choose a topic." }),
  message: z
    .string()
    .trim()
    .min(20, "Please write at least 20 characters.")
    .max(5000, "Please keep your message under 5,000 characters.")
    .refine((m) => (m.match(/https?:\/\//gi) ?? []).length <= 3, "Please include no more than three links."),
});

export const subscribeSchema = z.object({ email: emailField });

export const statsSchema = z
  .object({
    path: z.string().regex(/^\/(blog|jobs)\/[a-z0-9]+(?:-[a-z0-9]+)*$/),
    kind: z.enum(["view", "apply_click"]),
  })
  .strict();
