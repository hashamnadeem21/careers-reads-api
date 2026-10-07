import { randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { z } from "zod";

/** Argon2id with the library's recommended defaults (same as the admin used, so existing hashes keep working). */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** A readable temporary password, e.g. "kq7m-2xzp-9tnc-r4vh". */
export function generateTemporaryPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(16);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

/** Hash used to compare against when the email doesn't exist, so timing doesn't reveal accounts. */
let dummyHash: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword("not-a-real-password-placeholder");
  return dummyHash;
}

/** One password rule for sign-up (invites) and password changes. */
export const newPasswordSchema = z
  .string()
  .min(12, "Use at least 12 characters")
  .max(200)
  .refine((v) => /[a-zA-Z]/.test(v) && /[0-9\W_]/.test(v), "Mix letters with numbers or symbols");
