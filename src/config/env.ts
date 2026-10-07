import { z } from "zod";

/**
 * Validated environment for the API. Read lazily so scripts and tests can set
 * process.env first. Later phases add JWT_SECRET, SITE_API_KEY, REVALIDATE_SECRET, etc.
 */
const emptyToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const envSchema = z.object({
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(4000)),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "DATABASE_URL must be a postgres:// connection string"),
  /** Comma-separated browser origins allowed by CORS. Empty = CORS off (server-to-server only). */
  CORS_ORIGINS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .optional()
      .transform((value) => (value ? value.split(",").map((origin) => origin.trim().replace(/\/+$/, "")) : [])),
  ),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  cached = parsed.data;
  return cached;
}

/** Tests change process.env between files; this forgets the cached copy. */
export function resetEnvCache(): void {
  cached = null;
}

export const isProduction = process.env.NODE_ENV === "production";
