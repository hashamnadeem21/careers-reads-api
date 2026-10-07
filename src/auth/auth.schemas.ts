import { z } from "zod";
import { newPasswordSchema } from "./password.js";

export const loginSchema = z.object({
  email: z.email("Enter a valid email").trim().toLowerCase(),
  password: z.string().min(1, "Enter your password").max(200),
});

export const refreshSchema = z.object({ refreshToken: z.string().min(1).max(2000) });

export const changePasswordSchema = z
  .object({
    current: z.string().min(1, "Enter your current password").max(200),
    next: newPasswordSchema,
    confirm: z.string().max(200),
  })
  .refine((v) => v.next === v.confirm, { message: "The passwords don't match", path: ["confirm"] })
  .refine((v) => v.next !== v.current, { message: "Choose a password you haven't used here", path: ["next"] });
