import { z } from "zod";

const email = z.string().trim().toLowerCase().max(254).pipe(z.email("Enter a valid email address"));

/** Candidate passwords: friendlier than staff ones (8+), still capped so hashing stays cheap. */
export const candidatePasswordSchema = z
  .string()
  .min(8, "Use at least 8 characters")
  .max(128, "Use 128 characters or fewer");

export const googleSignInSchema = z.object({
  /** The ID token from the "Sign in with Google" button. */
  credential: z.string().min(20).max(5000),
});

export const signupSchema = z.object({
  name: z.string().trim().min(2, "Enter your name").max(80, "Use 80 characters or fewer"),
  email,
  password: candidatePasswordSchema,
  acceptTerms: z.literal(true, { error: "Please agree to the Terms of Service and Privacy Policy" }),
});

export const candidateLoginSchema = z.object({
  email,
  password: z.string().min(1, "Enter your password").max(200),
});

export const emailOnlySchema = z.object({ email });

export const tokenSchema = z.object({ token: z.string().min(20).max(200) });

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: candidatePasswordSchema,
});
