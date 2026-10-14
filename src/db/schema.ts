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
  unique,
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
export const statKind = pgEnum("stat_kind", ["view", "apply_click", "visit"]);
export const themePref = pgEnum("theme_pref", ["light", "dark", "system"]);
/** draft → sending (deliveries going out) → sent. */
export const newsletterStatus = pgEnum("newsletter_status", ["draft", "scheduled", "sending", "sent"]);
export const deliveryStatus = pgEnum("delivery_status", ["pending", "sent", "failed"]);
/** What starts an automation. More triggers can be added later. */
export const automationTrigger = pgEnum("automation_trigger", ["subscribed"]);
/** skipped: they unsubscribed, the automation was switched off, or it was days overdue. */
export const automationDeliveryStatus = pgEnum("automation_delivery_status", ["pending", "sent", "failed", "skipped"]);

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
    /**
     * The job ad as sanitized HTML from the admin's rich-text editor. When set, the site shows it
     * instead of the summary and lists, and the summary is derived from it. Null on older jobs.
     */
    description: text("description"),
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
  /** Secret in every newsletter's unsubscribe link. Never sent to the admin. */
  unsubscribeToken: uuid("unsubscribe_token").notNull().unique().defaultRandom(),
  /** Set when they unsubscribe; they get no newsletters until they sign up again. */
  unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/** Newsletters written in the admin (Markdown body), sent now or at a scheduled time to an audience. */
export const newsletters = pgTable(
  "newsletters",
  {
    id: serial("id").primaryKey(),
    subject: text("subject").notNull(),
    /** The grey line inboxes show after the subject. */
    previewText: text("preview_text").notNull().default(""),
    body: text("body").notNull().default(""),
    status: newsletterStatus("status").notNull().default("draft"),
    /** When a scheduled newsletter goes out (status "scheduled"). */
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    /** Audience: active subscribers who signed up in [from, to). Both null = everyone active. */
    audienceFrom: timestamp("audience_from", { withTimezone: true }),
    audienceTo: timestamp("audience_to", { withTimezone: true }),
    /** Counters, kept in step with newsletter_deliveries while sending. */
    recipients: integer("recipients").notNull().default(0),
    sentCount: integer("sent_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    sentBy: uuid("sent_by").references(() => users.id, { onDelete: "set null" }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("newsletters_created_idx").on(t.createdAt.desc()),
    index("newsletters_status_scheduled_idx").on(t.status, t.scheduledAt),
  ],
);

/** One row per subscriber per sent newsletter, so a resumed send never emails anyone twice. */
export const newsletterDeliveries = pgTable(
  "newsletter_deliveries",
  {
    newsletterId: integer("newsletter_id")
      .notNull()
      .references(() => newsletters.id, { onDelete: "cascade" }),
    subscriberId: integer("subscriber_id")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    status: deliveryStatus("status").notNull().default("pending"),
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.newsletterId, t.subscriberId] }),
    index("newsletter_deliveries_status_idx").on(t.newsletterId, t.status),
  ],
);

/**
 * Emails sent automatically when something happens (e.g. the welcome email when someone
 * subscribes), optionally after a delay. Only works between `startsAt` and `endsAt` while active.
 */
export const emailAutomations = pgTable("email_automations", {
  id: serial("id").primaryKey(),
  /** Admin-facing name, e.g. "Welcome email". */
  name: text("name").notNull(),
  trigger: automationTrigger("trigger").notNull().default("subscribed"),
  /** How long after the trigger it's sent (0 = straight away). */
  delayMinutes: integer("delay_minutes").notNull().default(0),
  subject: text("subject").notNull(),
  previewText: text("preview_text").notNull().default(""),
  body: text("body").notNull().default(""),
  active: boolean("active").notNull().default(false),
  /** Launch date: only triggers from here on count. Null = as soon as it's switched on. */
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per subscriber per automation, queued when the trigger happens and sent by the
 * scheduler once `dueAt` passes. The unique pair means nobody gets the same automation twice.
 */
export const automationDeliveries = pgTable(
  "automation_deliveries",
  {
    id: serial("id").primaryKey(),
    automationId: integer("automation_id")
      .notNull()
      .references(() => emailAutomations.id, { onDelete: "cascade" }),
    subscriberId: integer("subscriber_id")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    status: automationDeliveryStatus("status").notNull().default("pending"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    /** Set while a scheduler run is sending it, so a second run (or API instance) skips it. */
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("automation_deliveries_once").on(t.automationId, t.subscriberId),
    index("automation_deliveries_due_idx").on(t.dueAt).where(sql`${t.status} = 'pending'`),
    index("automation_deliveries_automation_idx").on(t.automationId, t.createdAt.desc()),
  ],
);

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

/**
 * Who is on the site right now. `id` is a random number each browser tab makes up and keeps in
 * memory only (no cookie); the row goes when the tab leaves, or after a minute without a heartbeat.
 */
export const liveVisitors = pgTable(
  "live_visitors",
  {
    id: uuid("id").primaryKey(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("live_visitors_last_seen_idx").on(t.lastSeen)],
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
export type NewsletterRow = typeof newsletters.$inferSelect;
export type NewsletterStatus = (typeof newsletterStatus.enumValues)[number];
export type AutomationRow = typeof emailAutomations.$inferSelect;
export type AutomationDeliveryStatus = (typeof automationDeliveryStatus.enumValues)[number];
export type CompanyRow = typeof companies.$inferSelect;
export type Role = (typeof userRole.enumValues)[number];
export type JobReview = (typeof jobReview.enumValues)[number];
