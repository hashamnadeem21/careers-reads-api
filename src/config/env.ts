import { z } from "zod";

/**
 * Validated environment for the API. Read lazily so scripts and tests can set
 * process.env first.
 */
const emptyToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());
const origin = (fallback: string) =>
  z.preprocess(
    emptyToUndefined,
    z
      .url()
      .default(fallback)
      .transform((value) => value.replace(/\/+$/, "")),
  );

const envSchema = z.object({
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(4000)),
  /** Proxies in front of the API (Railway/Render/Fly: 1). req.ip is the address before them. */
  TRUST_PROXY: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).default(1)),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "DATABASE_URL must be a postgres:// connection string"),
  /** Signs access and refresh tokens. Generate with: openssl rand -hex 32 */
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters (openssl rand -hex 32)"),
  ACCESS_TOKEN_TTL_SECONDS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(60).default(900)),
  REFRESH_TOKEN_DAYS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).default(30)),
  /**
   * Keys the admin and website servers send as `X-Api-Key`. Only requests with one of them may
   * pass the visitor's address in `X-Client-IP` (used for rate limits).
   */
  ADMIN_API_KEY: optional(z.string().min(32, "ADMIN_API_KEY must be at least 32 characters")),
  SITE_API_KEY: optional(z.string().min(32, "SITE_API_KEY must be at least 32 characters")),
  /** The admin panel's origin, used to build invite links. */
  ADMIN_URL: origin("http://localhost:3001"),
  /** The website's origin, used to refresh its cache after saves. */
  PUBLIC_SITE_URL: origin("http://localhost:3000"),
  /** Shared with the website's /api/revalidate. */
  REVALIDATE_SECRET: optional(z.string().min(16)),
  /** Vercel Blob token. Set in production: uploads go to Blob instead of UPLOADS_DIR. */
  BLOB_READ_WRITE_TOKEN: optional(z.string()),
  /** Local uploads (development): the website's public/uploads, so /uploads/… URLs keep working. */
  UPLOADS_DIR: z.preprocess(emptyToUndefined, z.string().default("../blognest/public/uploads")),
  /** Production refuses local uploads unless this is "true" (e2e runs of a production build). */
  ALLOW_LOCAL_UPLOADS: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false")),
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
