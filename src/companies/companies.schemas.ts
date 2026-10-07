import { z } from "zod";
import { inviteFields } from "../users/users.schemas.js";

export const companySchema = z.object({
  name: z.string().trim().min(2, "Enter the company name").max(100, "Keep it under 100 characters"),
  website: z
    .string()
    .trim()
    .max(300)
    .nullish()
    .transform((v) => v || undefined)
    .pipe(z.url("Enter a full address, like https://company.com").optional()),
  autoPublish: z.boolean().default(false),
});

export const setActiveSchema = z.object({ active: z.boolean() });

export const inviteCompanyUserSchema = z.object(inviteFields);
