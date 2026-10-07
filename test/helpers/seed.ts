import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { hashPassword } from "../../src/auth/password.js";
import type { Database } from "../../src/db/client.js";
import { articles, authors, categories, companies, jobs, users, type Role } from "../../src/db/schema.js";
import { TEST_ADMIN_API_KEY, TEST_SITE_API_KEY } from "./test-db.js";

export const PASSWORD = "correct-horse-battery-1";

let passwordHash: Promise<string> | null = null;

export async function createUser(
  db: Database,
  input: { role?: Role; companyId?: string | null; mustChangePassword?: boolean; email?: string; name?: string } = {},
) {
  passwordHash ??= hashPassword(PASSWORD);
  const [user] = await db
    .insert(users)
    .values({
      email: input.email ?? `${randomUUID()}@example.com`,
      name: input.name ?? "Test Person",
      role: input.role ?? "editor",
      companyId: input.companyId ?? null,
      mustChangePassword: input.mustChangePassword ?? false,
      passwordHash: await passwordHash,
    })
    .returning();
  return user;
}

export async function createCompany(db: Database, input: { name?: string; active?: boolean } = {}) {
  const [company] = await db
    .insert(companies)
    .values({ name: input.name ?? `Company ${randomUUID().slice(0, 8)}`, active: input.active ?? true })
    .returning();
  return company;
}

/**
 * As the admin server would call the API: with its server key and the visitor's IP. Each call
 * gets a fresh IP by default so the per-IP login limit doesn't trip across tests.
 */
export function asAdminServer(ip = `198.51.100.${Math.floor(Math.random() * 250)}-${randomUUID().slice(0, 4)}`) {
  return { "x-api-key": TEST_ADMIN_API_KEY, "x-client-ip": ip };
}

export async function login(app: NestExpressApplication, email: string, password = PASSWORD) {
  const res = await request(app.getHttpServer()).post("/auth/login").set(asAdminServer()).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { accessToken: string; refreshToken: string; user: { id: string } };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const DAY = 86_400_000;
export const daysFromNow = (days: number) => new Date(Date.now() + days * DAY);

/** As the website server would call the API. */
export function asSiteServer(ip = `203.0.113.${Math.floor(Math.random() * 250)}-${randomUUID().slice(0, 4)}`) {
  return { "x-api-key": TEST_SITE_API_KEY, "x-client-ip": ip };
}

export async function createCategory(db: Database, input: Partial<typeof categories.$inferInsert> = {}) {
  const [row] = await db
    .insert(categories)
    .values({
      slug: input.slug ?? `cat-${randomUUID().slice(0, 8)}`,
      kind: input.kind ?? "blog",
      name: input.name ?? "Technology",
      description: input.description ?? "Plain-language explainers on technology.",
      ...input,
    })
    .returning();
  return row;
}

export async function createAuthor(db: Database, input: Partial<typeof authors.$inferInsert> = {}) {
  const [row] = await db
    .insert(authors)
    .values({
      slug: input.slug ?? `author-${randomUUID().slice(0, 8)}`,
      name: "Ayesha Khan",
      role: "Senior editor",
      bio: "Ayesha writes practical guides about careers, technology and learning at work.",
      avatar: "/images/authors/ayesha.png",
      ...input,
    })
    .returning();
  return row;
}

export async function createArticle(
  db: Database,
  input: Partial<typeof articles.$inferInsert> & { category: string; author: string },
) {
  const [row] = await db
    .insert(articles)
    .values({
      slug: input.slug ?? `post-${randomUUID().slice(0, 8)}`,
      title: "How to plan a focused working week",
      excerpt: "A practical, tested approach to planning your week so the important work actually gets done.",
      body: "Intro paragraph.\n\n## Why it matters\n\nBody text here.\n\n### Details\n\nMore.",
      tags: ["productivity", "planning"],
      status: "published",
      publishedAt: daysFromNow(-1),
      coverImage: "/images/covers/week.png",
      coverAlt: "A desk with a weekly planner",
      ...input,
    })
    .returning();
  return row;
}

export async function createJob(db: Database, input: Partial<typeof jobs.$inferInsert> & { category: string }) {
  const [row] = await db
    .insert(jobs)
    .values({
      slug: input.slug ?? `job-${randomUUID().slice(0, 8)}`,
      title: "Frontend Developer",
      company: "Acme",
      country: "Pakistan",
      city: "Lahore",
      workModel: "hybrid",
      employmentType: "full-time",
      experience: "mid",
      summary: "Build fast, accessible interfaces for our hiring products with a small team.",
      applyUrl: "https://acme.test/apply",
      status: "published",
      postedAt: daysFromNow(-2),
      ...input,
    })
    .returning();
  return row;
}
