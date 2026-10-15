import { z } from "zod";
import { companyRequestStatus } from "../db/schema.js";
import { companySchema } from "../companies/companies.schemas.js";
import { inviteFields } from "../users/users.schemas.js";

/** The website's form offers exactly these (keep `blognest/src/lib/employers/options.ts` in step). */
export const INDUSTRIES = [
  "Software & IT",
  "Finance & Banking",
  "Healthcare",
  "Education",
  "Marketing & Advertising",
  "Retail & E-commerce",
  "Manufacturing",
  "Telecommunications",
  "Consulting & Professional Services",
  "Government & Non-profit",
  "Other",
] as const;

export const COMPANY_SIZES = ["1-10", "11-50", "51-200", "201-1000", "1000+"] as const;

const text = (min: number, max: number, required: string) =>
  z.string().trim().min(min, required).max(max, `Keep it under ${max} characters`);

/** "For employers" on the website: a company asks for an account. Sent by the website's server. */
export const companyRequestSchema = z.object({
  companyName: text(2, 100, "Enter your company's name"),
  website: companySchema.shape.website,
  industry: z.enum(INDUSTRIES, { error: "Choose your industry" }),
  companySize: z.enum(COMPANY_SIZES, { error: "Choose your company's size" }),
  location: text(2, 100, "Enter your city and country"),
  contactName: text(2, 80, "Enter your full name"),
  contactEmail: z.string().trim().toLowerCase().max(200).pipe(z.email("Enter a valid work email")),
  contactPhone: z
    .string()
    .trim()
    .regex(/^\+?[\d\s()-]{6,25}$/, "Enter a phone number, like +92 300 1234567"),
  contactRole: text(2, 80, "Enter your job title"),
  hiringPlans: z
    .string()
    .trim()
    .max(2000, "Keep it under 2,000 characters")
    .refine((v) => (v.match(/https?:\/\//gi) ?? []).length <= 3, "Please include no more than three links")
    .optional()
    .transform((v) => v || undefined),
  /** They agreed to the Terms and Privacy Policy. */
  consent: z.literal(true, { error: "Please agree to continue" }),
});
export type CompanyRequestInput = z.infer<typeof companyRequestSchema>;

export const companyRequestListQuerySchema = z.object({
  status: z.enum([...companyRequestStatus.enumValues, "all"]).default("pending"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type CompanyRequestListQuery = z.infer<typeof companyRequestListQuerySchema>;

/**
 * Approving: the company as it should be set up (the reviewer can tidy what was typed) and the
 * person who gets its first admin account.
 */
export const approveCompanyRequestSchema = z.object({
  companyName: companySchema.shape.name,
  website: companySchema.shape.website,
  autoPublish: z.boolean().default(false),
  onsiteApplyEnabled: z.boolean().default(true),
  contactName: inviteFields.name,
  contactEmail: inviteFields.email,
});
export type ApproveCompanyRequest = z.infer<typeof approveCompanyRequestSchema>;

export const rejectCompanyRequestSchema = z.object({
  /** Shown to them in the email when `notify` is on. */
  reason: z
    .string()
    .trim()
    .max(1000, "Keep it under 1,000 characters")
    .optional()
    .transform((v) => v || undefined),
  notify: z.boolean().default(true),
});
export type RejectCompanyRequest = z.infer<typeof rejectCompanyRequestSchema>;
