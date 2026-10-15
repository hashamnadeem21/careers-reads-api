import { z } from "zod";
import { applicationStatus } from "../db/schema.js";

const optionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .optional()
    .transform((v) => v || undefined);

/** The application form's fields (multipart, so everything arrives as text). The CV is the `cv` file. */
export const applySchema = z.object({
  name: z.string().trim().min(2, "Enter your full name").max(100, "Keep your name under 100 characters"),
  /** Ignored: applications use the signed-in candidate's account email. Kept so older forms still validate. */
  email: z
    .email("Enter a valid email address")
    .max(200)
    .transform((v) => v.toLowerCase())
    .optional(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[\d\s()-]{6,25}$/, "Enter a phone number, like +92 300 1234567"),
  location: optionalText(100, "Keep your location under 100 characters"),
  linkedinUrl: z
    .string()
    .trim()
    .max(300)
    .optional()
    .transform((v) => v || undefined)
    .pipe(
      z
        .url({ protocol: /^https?$/, error: "Enter your full LinkedIn address, like https://linkedin.com/in/you" })
        .optional(),
    ),
  coverLetter: optionalText(5000, "Keep your note under 5,000 characters"),
  /** JSON object of answers keyed by question id. */
  answers: z
    .string()
    .max(60_000)
    .default("{}")
    .transform((v, ctx) => {
      try {
        const parsed: unknown = JSON.parse(v);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        // reported below
      }
      ctx.addIssue({ code: "custom", message: "The answers couldn't be read" });
      return z.NEVER;
    }),
  consent: z.literal("true", { error: "Please agree so the employer can see your application" }),
  /** "true": send the CV saved on their account instead of uploading one. */
  useSavedCv: z.literal("true").optional(),
  /** Hidden from people; bots fill it in. */
  website: z.string().max(500).optional(),
});
export type ApplyFields = z.input<typeof applySchema>;

export const APPLICATION_STATUSES = applicationStatus.enumValues;

export const applicationListQuerySchema = z.object({
  /** A job's slug. */
  job: z.string().max(120).optional(),
  status: z.enum(APPLICATION_STATUSES).optional(),
  /** Searches name, email and phone. */
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type ApplicationListQuery = z.infer<typeof applicationListQuerySchema>;

export const setStatusSchema = z.object({ status: z.enum(APPLICATION_STATUSES) });

export const bulkStatusSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(200),
  status: z.enum(APPLICATION_STATUSES),
});

export const noteSchema = z.object({
  note: z.string().trim().min(1, "Write a note").max(2000, "Keep the note under 2,000 characters"),
});

export const cvQuerySchema = z.object({ download: z.enum(["true", "false"]).optional() });

export const exportQuerySchema = z.object({ job: z.string().max(120).optional() });

export const forgetCandidateSchema = z.object({ email: z.email().transform((v) => v.toLowerCase()) });
