/**
 * Career Reads database schema. This repo (blognest-api) owns it and its migrations:
 * edit it here, then `npm run db:generate` and `npm run db:migrate`.
 * Until the admin and website switch to the API (plan phases 4 and 7), they keep
 * read-only copies at `src/db/schema.ts`: copy this file across whenever it changes.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * super_admin: the owner; everything, including users, companies and settings.
 * editor: editorial staff; posts, jobs, categories, authors, media, messages.
 * company: an employer account; only its own company's jobs and their stats.
 */
export const userRole = pgEnum("user_role", ["super_admin", "editor", "company"]);
/** Moderation of jobs posted by company accounts. Null for jobs posted by staff. */
export const jobReview = pgEnum("job_review", ["pending", "approved", "rejected"]);
export const contentStatus = pgEnum("content_status", ["draft", "published"]);
export const categoryKind = pgEnum("category_kind", ["blog", "job"]);
export const authorType = pgEnum("author_type", ["Person", "Organization"]);
export const statKind = pgEnum("stat_kind", ["view", "apply_click"]);
export const themePref = pgEnum("theme_pref", ["light", "dark", "system"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** Employers that post jobs through their own company accounts. */
export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  website: text("website"),
  /** Trusted companies publish without review. */
  autoPublish: boolean("auto_publish").notNull().default(false),
  /** Paused companies can't sign in; their jobs stay as they are. */
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: userRole("role").notNull().default("editor"),
  /** Set for (and only for) company accounts. */
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
  /** Set for temporary passwords (first admin, invites); cleared on change. */
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  createdAt: createdAt(),
}, (t) => [
  index("users_company_idx").on(t.companyId),
  check("users_company_role", sql`(${t.role}::text = 'company') = (${t.companyId} is not null)`),
]);

/** Server-side sessions. `id` is the SHA-256 of the cookie token, never the token itself. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const authors = pgTable("authors", {
  slug: text("slug").primaryKey(),
  name: text("name").notNull(),
  type: authorType("type").notNull().default("Person"),
  role: text("role").notNull(),
  bio: text("bio").notNull(),
  avatar: text("avatar").notNull(),
  links: jsonb("links").$type<{ website?: string; x?: string; linkedin?: string }>().notNull().default({}),
});

export const categories = pgTable("categories", {
  slug: text("slug").primaryKey(),
  kind: categoryKind("kind").notNull(),
  name: text("name").notNull(),
  headline: text("headline"),
  description: text("description").notNull(),
  /** Tailwind gradient stops for blog category accents, e.g. "from-sky-500 to-indigo-500". */
  accent: text("accent"),
  sortOrder: integer("sort_order").notNull().default(0),
});

export interface ArticleImageRow {
  src: string;
  alt: string;
  caption?: string;
  width: number;
  height: number;
  placement: string;
}

export const articles = pgTable(
  "articles",
  {
    slug: text("slug").primaryKey(),
    title: text("title").notNull(),
    excerpt: text("excerpt").notNull(),
    body: text("body").notNull(),
    category: text("category")
      .notNull()
      .references(() => categories.slug, { onUpdate: "cascade" }),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    author: text("author")
      .notNull()
      .references(() => authors.slug, { onUpdate: "cascade" }),
    status: contentStatus("status").notNull().default("draft"),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    featured: boolean("featured").notNull().default(false),
    trending: boolean("trending").notNull().default(false),
    editorsPick: boolean("editors_pick").notNull().default(false),
    coverImage: text("cover_image").notNull(),
    coverAlt: text("cover_alt").notNull(),
    coverWidth: integer("cover_width").notNull().default(1600),
    coverHeight: integer("cover_height").notNull().default(900),
    images: jsonb("images").$type<ArticleImageRow[]>().notNull().default([]),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    canonicalUrl: text("canonical_url"),
    noindex: boolean("noindex").notNull().default(false),
    ads: boolean("ads").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    /** Last time anything was saved (drives autosave and "recently edited"). */
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("articles_status_published_idx").on(t.status, t.publishedAt.desc()),
    index("articles_category_idx").on(t.category),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    slug: text("slug").primaryKey(),
    title: text("title").notNull(),
    /** Display name shown on the site. For company-account jobs it always equals companies.name. */
    company: text("company").notNull(),
    /** The company account that owns this job (null = posted by BlogNest staff). */
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    review: jobReview("review"),
    /** Why a job was sent back to the company (shown to them). */
    reviewNote: text("review_note"),
    companyWebsite: text("company_website"),
    city: text("city"),
    country: text("country").notNull(),
    workModel: text("work_model").notNull(),
    employmentType: text("employment_type").notNull(),
    category: text("category")
      .notNull()
      .references(() => categories.slug, { onUpdate: "cascade" }),
    experience: text("experience").notNull(),
    salary: text("salary"),
    summary: text("summary").notNull(),
    responsibilities: text("responsibilities").array().notNull().default(sql`'{}'::text[]`),
    requirements: text("requirements").array().notNull().default(sql`'{}'::text[]`),
    benefits: text("benefits").array().notNull().default(sql`'{}'::text[]`),
    applyUrl: text("apply_url"),
    applyEmail: text("apply_email"),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    deadline: timestamp("deadline", { withTimezone: true }),
    status: contentStatus("status").notNull().default("draft"),
    featured: boolean("featured").notNull().default(false),
    /** Example listing imported for development; never shown in production. */
    sample: boolean("sample").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("jobs_status_posted_idx").on(t.status, t.postedAt.desc()),
    index("jobs_category_idx").on(t.category),
    index("jobs_company_idx").on(t.companyId),
    index("jobs_review_idx").on(t.review),
  ],
);

export const media = pgTable("media", {
  id: uuid("id").primaryKey().defaultRandom(),
  url: text("url").notNull().unique(),
  alt: text("alt").notNull().default(""),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  topic: text("topic"),
  message: text("message").notNull(),
  read: boolean("read").notNull().default(false),
  createdAt: createdAt(),
});

export const subscribers = pgTable("subscribers", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  confirmed: boolean("confirmed").notNull().default(false),
  createdAt: createdAt(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entitySlug: text("entity_slug"),
    /** Short human-readable label, e.g. the job title at the time of the change. */
    label: text("label"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_created_idx").on(t.createdAt.desc())],
);

/** Privacy-friendly counters: no cookies, no IPs, no personal data. */
export const dailyStats = pgTable(
  "daily_stats",
  {
    day: date("day", { mode: "string" }).notNull(),
    path: text("path").notNull(),
    kind: statKind("kind").notNull(),
    entitySlug: text("entity_slug"),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.path, t.kind] }), index("daily_stats_entity_idx").on(t.entitySlug)],
);

export interface DashboardLayout {
  order: string[];
  hidden: string[];
  mixStyle?: "bubble" | "donut";
}

export const userPrefs = pgTable("user_prefs", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  theme: themePref("theme").notNull().default("system"),
  dashboardLayout: jsonb("dashboard_layout").$type<DashboardLayout>(),
});

/** Fixed-window counters shared by every server instance (login, stats beacon). */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
});

/** One-time invite links. `tokenHash` is the SHA-256 of the token in the link. */
export const invites = pgTable("invites", {
  tokenHash: text("token_hash").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  role: userRole("role").notNull(),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
  invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export type User = typeof users.$inferSelect;
export type ArticleRow = typeof articles.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type AuthorRow = typeof authors.$inferSelect;
export type MediaRow = typeof media.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type SubscriberRow = typeof subscribers.$inferSelect;
export type CompanyRow = typeof companies.$inferSelect;
export type Role = (typeof userRole.enumValues)[number];
export type JobReview = (typeof jobReview.enumValues)[number];
