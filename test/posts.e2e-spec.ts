import type { NestExpressApplication } from "@nestjs/platform-express";
import { eq } from "drizzle-orm";
import request from "supertest";
import type { DbConnection } from "../src/db/client.js";
import { articles, auditLog, dailyStats } from "../src/db/schema.js";
import { createTestApp } from "./helpers/app.js";
import {
  bearer,
  createArticle,
  createAuthor,
  createCategory,
  createCompany,
  createUser,
  daysFromNow,
  login,
} from "./helpers/seed.js";
import { connectTestDb, resetTestDb } from "./helpers/test-db.js";

let connection: DbConnection;
let app: NestExpressApplication;
let editor: { authorization: string };
let companyUser: { authorization: string };
const http = () => request(app.getHttpServer());

const BODY = `This guide checks that saving a post from the API behaves like the admin.

## Getting started

Some words about getting started.

## Final thoughts

Wrapping up.`;

const post = (over: Record<string, unknown> = {}) => ({
  slug: "planning-a-focused-week",
  title: "Planning a focused working week",
  excerpt: "A practical, tested approach to planning your week so the important work actually gets done.",
  body: BODY,
  category: "technology",
  tags: ["Planning"],
  author: "editorial-team",
  coverImage: "/uploads/hero.webp",
  coverAlt: "A desk with a weekly planner",
  coverWidth: 1600,
  coverHeight: 900,
  images: [],
  seoTitle: "",
  seoDescription: "",
  canonicalUrl: "",
  noindex: false,
  ads: true,
  featured: false,
  trending: false,
  editorsPick: false,
  intent: "draft",
  ...over,
});

beforeAll(async () => {
  connection = await connectTestDb();
  await resetTestDb(connection);
  app = await createTestApp();
  await createCategory(connection.db, { slug: "technology", kind: "blog" });
  await createAuthor(connection.db, { slug: "editorial-team" });
  const user = await createUser(connection.db, { role: "editor" });
  editor = bearer((await login(app, user.email)).accessToken);
  const company = await createCompany(connection.db);
  const member = await createUser(connection.db, { role: "company", companyId: company.id });
  companyUser = bearer((await login(app, member.email)).accessToken);
});

afterAll(async () => {
  await app.close();
  await connection.end();
});

describe("posts", () => {
  it("is staff only", async () => {
    await http().get("/posts").expect(401);
    await http().get("/posts").set(companyUser).expect(403);
    await http().post("/posts").set(companyUser).send(post()).expect(403);
  });

  it("lists what to fix, keyed by field", async () => {
    const res = await http()
      .post("/posts")
      .set(editor)
      .send(post({ title: "Too short", coverImage: "", category: "nope" }))
      .expect(400);
    expect(res.body.error).toMatchObject({ code: "validation_failed", message: "Please fix the highlighted fields." });
    expect(res.body.error.fields).toMatchObject({
      title: expect.any(String),
      coverImage: "Choose a hero image",
      category: "Pick a category",
    });
  });

  it("refuses MDX the site would strip", async () => {
    const res = await http()
      .post("/posts")
      .set(editor)
      .send(post({ body: `${BODY}\n\nSecret: {process.env.DATABASE_URL}` }))
      .expect(400);
    expect(res.body.error.fields.body).toMatch(/Curly-brace/);
  });

  it("saves a draft, publishes it, and it appears on the website", async () => {
    const draft = await http().post("/posts").set(editor).send(post()).expect(201);
    expect(draft.body).toMatchObject({ slug: "planning-a-focused-week", status: "draft", message: "Draft saved" });
    await http().get("/public/articles/planning-a-focused-week").expect(404);

    const published = await http()
      .patch("/posts/planning-a-focused-week")
      .set(editor)
      .send(post({ intent: "publish" }))
      .expect(200);
    expect(published.body).toMatchObject({ status: "published" });
    // Tests run without REVALIDATE_SECRET, so the site refresh is reported as not done.
    expect(published.body.siteRefreshed).toBe(false);
    expect(published.body.message).toMatch(/^Published\. The site couldn't be refreshed/);

    const live = await http().get("/public/articles/planning-a-focused-week").expect(200);
    expect(live.body).toMatchObject({ title: "Planning a focused working week", tags: ["planning"] });

    const actions = await connection.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entitySlug, "planning-a-focused-week"));
    expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(["created", "published"]));
  });

  it("doesn't autosave a live post", async () => {
    const res = await http()
      .patch("/posts/planning-a-focused-week")
      .set(editor)
      .send(post({ intent: "autosave" }))
      .expect(409);
    expect(res.body.error.code).toBe("autosave_published");
  });

  it("only schedules into the future, and scheduled posts stay hidden", async () => {
    const past = await http()
      .post("/posts")
      .set(editor)
      .send(post({ slug: "scheduled-post", intent: "schedule", scheduleAt: daysFromNow(-1).toISOString() }))
      .expect(400);
    expect(past.body.error.fields).toEqual({ publishedAt: "Pick a date and time in the future." });

    const res = await http()
      .post("/posts")
      .set(editor)
      .send(post({ slug: "scheduled-post", intent: "schedule", scheduleAt: daysFromNow(3).toISOString() }))
      .expect(201);
    expect(res.body.message).toMatch(/^Scheduled for/);
    await http().get("/public/articles/scheduled-post").expect(404);

    const list = await http().get("/posts?status=scheduled").set(editor).expect(200);
    expect(list.body.rows.map((r: { slug: string }) => r.slug)).toEqual(["scheduled-post"]);
    expect(list.body.counts).toMatchObject({ scheduled: 1, live: 1 });
  });

  it("renaming a post keeps its stats and refuses a taken slug", async () => {
    await connection.db
      .insert(dailyStats)
      .values({ day: "2026-10-01", path: "/blog/planning-a-focused-week", kind: "view", count: 7 });

    const taken = await http()
      .patch("/posts/planning-a-focused-week")
      .set(editor)
      .send(post({ slug: "scheduled-post", intent: "update" }))
      .expect(400);
    expect(taken.body.error.fields.slug).toMatch(/already uses/);

    await http()
      .patch("/posts/planning-a-focused-week")
      .set(editor)
      .send(post({ slug: "a-focused-week", intent: "update" }))
      .expect(200);
    const [stat] = await connection.db.select().from(dailyStats).where(eq(dailyStats.path, "/blog/a-focused-week"));
    expect(stat).toMatchObject({ count: 7, entitySlug: "a-focused-week" });
    await http().get("/posts/planning-a-focused-week").set(editor).expect(404);
    const renamed = await http().get("/posts/a-focused-week").set(editor).expect(200);
    expect(renamed.body.updatedAt).not.toBeNull();
  });

  it("duplicates as a new draft", async () => {
    const first = await http().post("/posts/a-focused-week/duplicate").set(editor).expect(201);
    expect(first.body).toEqual({ slug: "a-focused-week-copy", message: "Copied as a new draft." });
    const second = await http().post("/posts/a-focused-week/duplicate").set(editor).expect(201);
    expect(second.body.slug).toBe("a-focused-week-copy-2");
    const [copy] = await connection.db.select().from(articles).where(eq(articles.slug, "a-focused-week-copy"));
    expect(copy).toMatchObject({ status: "draft", featured: false, title: "Planning a focused working week (copy)" });
  });

  it("bulk unpublishes and deletes", async () => {
    const extra = await createArticle(connection.db, { category: "technology", author: "editorial-team" });
    const unpublished = await http()
      .post("/posts/bulk")
      .set(editor)
      .send({ action: "unpublish", slugs: ["a-focused-week", extra.slug] })
      .expect(200);
    expect(unpublished.body.message).toBe("2 posts unpublished.");
    await http().get("/public/articles/a-focused-week").expect(404);

    await http()
      .post("/posts/bulk")
      .set(editor)
      .send({ action: "delete", slugs: ["a-focused-week-copy", "a-focused-week-copy-2"] })
      .expect(200);
    await http()
      .post("/posts/bulk")
      .set(editor)
      .send({ action: "delete", slugs: ["a-focused-week-copy"] })
      .expect(404);
  });

  it("deletes a post and its stats", async () => {
    await http().delete("/posts/a-focused-week").set(editor).expect(204);
    await http().delete("/posts/a-focused-week").set(editor).expect(404);
    const stats = await connection.db.select().from(dailyStats).where(eq(dailyStats.path, "/blog/a-focused-week"));
    expect(stats).toEqual([]);
  });

  it("searches, filters and returns editor options", async () => {
    const res = await http().get("/posts?q=planning&sort=title&dir=asc").set(editor).expect(200);
    expect(res.body).toMatchObject({ page: 1, pageSize: 20 });
    // Title, slug or tag.
    expect(res.body.rows.map((r: { slug: string }) => r.slug)).toContain("scheduled-post");
    const none = await http().get("/posts?q=zzz-nothing").set(editor).expect(200);
    expect(none.body).toMatchObject({ rows: [], total: 0 });
    await http().get("/posts?status=bogus").set(editor).expect(400);

    const options = await http().get("/posts/options").set(editor).expect(200);
    expect(options.body.categories).toEqual([{ slug: "technology", name: "Technology" }]);
    expect(options.body.authors.map((a: { slug: string }) => a.slug)).toEqual(["editorial-team"]);
  });
});
