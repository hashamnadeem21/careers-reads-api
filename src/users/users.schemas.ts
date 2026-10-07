import { z } from "zod";
import { newPasswordSchema } from "../auth/password.js";

/** Roles managed on the Users page. Company accounts are invited from Companies. */
export const staffRoleSchema = z.enum(["super_admin", "editor"]);

export const inviteFields = {
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email")),
  name: z.string().trim().min(2, "Enter their name").max(80),
};

export const inviteStaffSchema = z.object({ ...inviteFields, role: staffRoleSchema });

export const revokeInviteSchema = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()) });

export const changeRoleSchema = z.object({ role: staffRoleSchema });

export const acceptInviteSchema = z
  .object({
    name: z.string().trim().min(2, "Enter your name").max(80),
    password: newPasswordSchema,
    confirm: z.string().max(200),
  })
  .refine((v) => v.password === v.confirm, { message: "The passwords don't match", path: ["confirm"] });
