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
  /**
   * Self-hosted uploads: the public URL UPLOADS_DIR is served at (e.g. https://api.careersreads.com/uploads,
   * served by Nginx). Set → files stay on this server in production too, and URLs are absolute.
   */
  UPLOADS_PUBLIC_URL: optional(z.url().transform((value) => value.replace(/\/+$/, ""))),
  /** Production refuses local uploads unless this is "true" (e2e runs of a production build). */
  ALLOW_LOCAL_UPLOADS: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false")),
  /**
   * CVs and other files that must never be public. A token for a *private* Vercel Blob store
   * (separate from the public media store), or else PRIVATE_FILES_DIR on this server.
   */
  PRIVATE_BLOB_READ_WRITE_TOKEN: optional(z.string()),
  /**
   * Private files on this server's disk (never served by Nginx). Production must set it to a
   * persistent volume when there's no private Blob token. Development: .data/private-files.
   */
  PRIVATE_FILES_DIR: optional(z.string()),
  /** Applications (and their CVs) are deleted this many days after the job's deadline or the application, whichever is later. */
  APPLICATION_RETENTION_DAYS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(30).default(180)),
  /** Resend (https://resend.com) API key. Without it newsletters can be written but not sent. */
  RESEND_API_KEY: optional(z.string().min(1)),
  /** Newsletter sender on a domain verified in Resend, e.g. "Career Reads <newsletter@careersreads.com>". */
  NEWSLETTER_FROM: optional(z.string().min(3)),
  /** Where replies to a newsletter go (e.g. contact@careersreads.com). */
  NEWSLETTER_REPLY_TO: optional(z.email()),
  /** Postal address in every newsletter's footer (anti-spam laws ask for one). */
  NEWSLETTER_POSTAL_ADDRESS: optional(z.string().max(300)),
  /**
   * Where images in emails (logo, banners) load from. Inboxes fetch them from the internet, so a
   * localhost site URL can't work: unset, it's PUBLIC_SITE_URL, or the live site when that is local.
   */
  EMAIL_ASSETS_URL: optional(z.url().transform((value) => value.replace(/\/+$/, ""))),
  /** This API's public URL (e.g. https://api.careersreads.com): unsubscribe links point here. */
  API_PUBLIC_URL: optional(z.url().transform((value) => value.replace(/\/+$/, ""))),
  /** Runs the every-minute scheduler (scheduled newsletters, automation emails). Tests turn it off. */
  SCHEDULER_ENABLED: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("true")),
  /**
   * Serve the API reference (/docs and /docs-json). Off in production unless set to "true": it maps
   * every endpoint, which helps attackers more than anyone else. The admin and website generate
   * their types from a local API.
   */
  API_DOCS: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).optional()),
  /**
   * Google sign-in for candidates on the website: the OAuth "Web application" client ID
   * (…apps.googleusercontent.com). Public by design. Unset = "Continue with Google" is off.
   */
  GOOGLE_CLIENT_ID: optional(z.string().regex(/\.apps\.googleusercontent\.com$/, "GOOGLE_CLIENT_ID should end with .apps.googleusercontent.com")),
  /** How long a candidate stays signed in on the website. */
  CANDIDATE_SESSION_DAYS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(365).default(60)),
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
