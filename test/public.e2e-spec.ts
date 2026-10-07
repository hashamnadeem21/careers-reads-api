import type { NestExpressApplication } from "@nestjs/platform-express";
import { sql } from "drizzle-orm";
import request from "supertest";
import type { DbConnection } from "../src/db/client.js";
import { messages, settings, subscribers } from "../src/db/schema.js";
import { createTestApp } from "./helpers/app.js";
import { asSiteServer, createArticle, createAuthor, createCategory, createJob, daysFromNow } from "./helpers/seed.js";
import { connectTestDb, resetTestDb } from "./helpers/test-db.js";

let connection: DbConnection;
let app: NestExpressApplication;
const http = () => request(app.getHttpServer());
const UA = { "x-client-user-agent": "Mozilla/5.0 (Macintosh)" };

beforeAll(async () => {
  connection = await connectTestDb();
  await resetTestDb(connection);
  app = await createTestApp();
  const { db } = connection;
  await createCategory(db, { slug: "productivity", name: "Productivity" });
  await createCategory(db, { slug: "engineering", kind: "job", name: "Engineering" });
  await createAuthor(db, { slug: "ayesha" });
  const base = { category: "productivity", author: "ayesha" };
  await createArticle(db, { ...base, slug: "live-post" });
  await createArticle(db, { ...base, slug: "draft-post", status: "draft" });
  await createArticle(db, { ...base, slug: "scheduled-post", publishedAt: daysFromNow(3) });
  await createJob(db, { category: "engineering", slug: "live-job" });
  await createJob(db, { category: "engineering", slug: "draft-job", status: "draft" });
  await createJob(db, { category: "engineering", slug: "expired-job", deadline: daysFromNow(-3) });
  await createJob(db, { category: "engineering", slug: "future-job", postedAt: daysFromNow(2) });
});

afterAll(async () => {
  await app.close();
  await connection.end();
});

describe("public reads", () => {
  it("lists only live articles, with reading time and table of contents", async () => {
    const res = await http().get("/public/articles").expect(200);
    expect(res.body.map((a: { slug: string }) => a.slug)).toEqual(["live-post"]);
    expect(res.body[0]).toMatchObject({ readingTimeMinutes: 1, toc: [{ id: "why-it-matters", depth: 2 }, { id: "details", depth: 3 }] });
    const summary = await http().get("/public/articles?view=summary").expect(200);
    expect(summary.body[0].content).toBeUndefined();
  });

  it("never returns drafts or scheduled posts without the site key", async () => {
    await http().get("/public/articles/draft-post").expect(404);
    await http().get("/public/articles/scheduled-post").expect(404);
    await http().get("/public/articles?preview=1").expect(403);
    await http().get("/public/articles/draft-post?preview=1").set({ "x-api-key": "nope" }).expect(403);
  });

  it("previews drafts for the website's server", async () => {
    const res = await http().get("/public/articles?preview=1").set(asSiteServer()).expect(200);
    expect(res.body.map((a: { slug: string }) => a.slug).sort()).toEqual(["draft-post", "live-post", "scheduled-post"]);
    await http().get("/public/articles/draft-post?preview=1").set(asSiteServer()).expect(200);
  });

  it("lists only visible jobs, even with the site key", async () => {
    const res = await http().get("/public/jobs").set(asSiteServer()).expect(200);
    expect(res.body.map((j: { slug: string }) => j.slug)).toEqual(["live-job"]);
    for (const slug of ["draft-job", "expired-job", "future-job"]) await http().get(`/public/jobs/${slug}`).expect(404);
    await http().get("/public/jobs/live-job").expect(200);
  });

  it("serves categories, authors and settings", async () => {
    const cats = await http().get("/public/categories").expect(200);
    expect(cats.body.map((c: { slug: string }) => c.slug).sort()).toEqual(["engineering", "productivity"]);
    const authors = await http().get("/public/authors").expect(200);
    expect(authors.body[0]).toMatchObject({ slug: "ayesha", links: {} });
    await http().get("/public/authors/ayesha").expect(200);
    await http().get("/public/authors/nobody").expect(404);

    expect((await http().get("/public/settings").expect(200)).body).toEqual({ ads: null, site: null });
    const site = { contactEmail: "hi@example.com", social: { x: "", linkedin: "", github: "" } };
    await connection.db.insert(settings).values({ key: "site", value: site });
    expect((await http().get("/public/settings").expect(200)).body).toEqual({ ads: null, site });
  });
});

describe("public writes", () => {
  const contact = {
    name: "Sara",
    email: " Sara@Example.com ",
    topic: "general",
    message: "Hello there, this is long enough.",
  };

  it("require the site key", async () => {
    await http().post("/public/contact").send(contact).expect(403);
    await http().post("/public/subscribe").send({ email: "a@example.com" }).expect(403);
    await http().post("/public/stats").send({ path: "/blog/live-post", kind: "view" }).expect(403);
  });

  it("stores contact messages and rate-limits per visitor", async () => {
    const site = asSiteServer();
    for (let i = 0; i < 3; i++) await http().post("/public/contact").set(site).send(contact).expect(204);
    await http().post("/public/contact").set(site).send(contact).expect(429);
    const rows = await connection.db.select().from(messages);
    expect(rows[0]).toMatchObject({ email: "sara@example.com", topic: "general" });
    const bad = await http()
      .post("/public/contact")
      .set(asSiteServer())
      .send({ ...contact, message: "short" })
      .expect(400);
    expect(bad.body.error.fields).toEqual({ message: expect.any(String) });
  });

  it("stores subscribers once", async () => {
    await http().post("/public/subscribe").set(asSiteServer()).send({ email: "Fan@Example.com" }).expect(204);
    await http().post("/public/subscribe").set(asSiteServer()).send({ email: "fan@example.com" }).expect(204);
    expect(await connection.db.select().from(subscribers)).toHaveLength(1);
  });

  it("counts stats for live pages only and ignores bots", async () => {
    const site = { ...asSiteServer(), ...UA };
    await http().post("/public/stats").set(site).send({ path: "/blog/live-post", kind: "view" }).expect(204);
    await http().post("/public/stats").set(site).send({ path: "/blog/live-post", kind: "view" }).expect(204);
    await http().post("/public/stats").set(site).send({ path: "/jobs/live-job", kind: "apply_click" }).expect(204);
    await http().post("/public/stats").set(site).send({ path: "/blog/draft-post", kind: "view" }).expect(404);
    await http().post("/public/stats").set(site).send({ path: "/blog/live-post", kind: "apply_click" }).expect(400);
    await http()
      .post("/public/stats")
      .set({ ...asSiteServer(), "x-client-user-agent": "Googlebot/2.1" })
      .send({ path: "/blog/live-post", kind: "view" })
      .expect(204);
    const rows = await connection.db.execute<{ path: string; kind: string; count: number }>(
      sql`select path, kind, count from daily_stats order by path`,
    );
    expect(rows.rows).toEqual([
      { path: "/blog/live-post", kind: "view", count: 2 },
      { path: "/jobs/live-job", kind: "apply_click", count: 1 },
    ]);
  });
});
