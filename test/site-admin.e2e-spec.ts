import type { NestExpressApplication } from "@nestjs/platform-express";
import { eq } from "drizzle-orm";
import request from "supertest";
import type { DbConnection } from "../src/db/client.js";
import { articles, messages, subscribers, userPrefs } from "../src/db/schema.js";
import { createTestApp } from "./helpers/app.js";
import {
  bearer,
  createArticle,
  createAuthor,
  createCategory,
  createCompany,
  createJob,
  createUser,
  daysFromNow,
  login,
} from "./helpers/seed.js";
import { connectTestDb, resetTestDb } from "./helpers/test-db.js";

let connection: DbConnection;
let app: NestExpressApplication;
let owner: { authorization: string };
let editor: { authorization: string };
let company: { authorization: string };
let editorId: string;
const http = () => request(app.getHttpServer());

const blogCategory = (over: Record<string, unknown> = {}) => ({
  kind: "blog",
  slug: "careers",
  name: "Careers",
  headline: "Career advice that actually helps",
  description: "Practical guides for growing your career.",
  accent: "from-sky-500 to-indigo-500",
  ...over,
});

const author = (over: Record<string, unknown> = {}) => ({
  slug: "sara-ali",
  name: "Sara Ali",
  type: "Person",
  role: "Staff writer",
  bio: "Sara writes about hiring, interviews and the first years of a career.",
  avatar: "/images/authors/sara.png",
  links: { website: "", x: "https://x.com/sara", linkedin: "" },
  ...over,
});

beforeAll(async () => {
  connection = await connectTestDb();
  await resetTestDb(connection);
  app = await createTestApp();
  const admin = await createUser(connection.db, { role: "super_admin", name: "Owner" });
  owner = bearer((await login(app, admin.email)).accessToken);
  const staff = await createUser(connection.db, { role: "editor", name: "Hasham" });
  editorId = staff.id;
  editor = bearer((await login(app, staff.email)).accessToken);
  const acme = await createCompany(connection.db, { name: "Acme" });
  const member = await createUser(connection.db, { role: "company", companyId: acme.id });
  company = bearer((await login(app, member.email)).accessToken);
});

afterAll(async () => {
  await app.close();
  await connection.end();
});

describe("access", () => {
  it("company accounts only reach search and their theme", async () => {
    for (const path of [
      "/categories",
      "/authors",
      "/messages",
      "/subscribers",
      "/dashboard",
      "/activity",
      "/settings",
    ]) {
      await http().get(path).set(company).expect(403);
    }
    await http().get("/settings").set(editor).expect(403);
    await http().put("/me/dashboard-layout").set(company).send({ order: [], hidden: [] }).expect(403);
    await http().get("/search?q=ac").set(company).expect(200);
  });
});

describe("categories", () => {
  it("adds, validates, renames (posts follow), reorders and refuses deleting a used one", async () => {
    const bad = await http()
      .post("/categories")
      .set(editor)
      .send(blogCategory({ headline: "", accent: "x" }))
      .expect(400);
    expect(bad.body.error).toMatchObject({ message: "Please fix the highlighted fields." });
    expect(Object.keys(bad.body.error.fields).sort()).toEqual(["accent", "headline"]);

    const created = await http().post("/categories").set(editor).send(blogCategory()).expect(201);
    expect(created.body).toMatchObject({ message: "Category added.", category: { slug: "careers", sortOrder: 0 } });
    await http().post("/categories").set(editor).send(blogCategory()).expect(409);
    await createCategory(connection.db, { slug: "learning", kind: "blog", sortOrder: 1 });
    await createAuthor(connection.db, { slug: "editorial-team" });
    await createArticle(connection.db, { slug: "a-careers-post", category: "careers", author: "editorial-team" });

    await http()
      .patch("/categories/careers")
      .set(editor)
      .send(blogCategory({ slug: "career-advice" }))
      .expect(200);
    const [post] = await connection.db.select().from(articles).where(eq(articles.slug, "a-careers-post"));
    expect(post.category).toBe("career-advice");
    await http()
      .patch("/categories/career-advice")
      .set(editor)
      .send(blogCategory({ kind: "job", slug: "career-advice" }))
      .expect(409);

    const list = await http().get("/categories?kind=blog").set(editor).expect(200);
    expect(list.body.map((c: { slug: string; used: number }) => [c.slug, c.used])).toEqual([
      ["career-advice", 1],
      ["learning", 0],
    ]);

    await http()
      .post("/categories/reorder")
      .set(editor)
      .send({ kind: "blog", slugs: ["learning"] })
      .expect(409);
    await http()
      .post("/categories/reorder")
      .set(editor)
      .send({ kind: "blog", slugs: ["learning", "career-advice"] })
      .expect(200);
    const reordered = await http().get("/categories?kind=blog").set(editor).expect(200);
    expect(reordered.body.map((c: { slug: string }) => c.slug)).toEqual(["learning", "career-advice"]);

    const used = await http().delete("/categories/career-advice").set(editor).expect(409);
    expect(used.body.error).toMatchObject({ code: "in_use", message: expect.stringMatching(/used by 1 post\./) });
    await http().delete("/categories/learning").set(editor).expect(204);
    await http().delete("/categories/learning").set(editor).expect(404);
  });
});

describe("authors", () => {
  it("adds with the site's rules, renames (posts follow) and refuses deleting someone with posts", async () => {
    const bad = await http()
      .post("/authors")
      .set(editor)
      .send(author({ avatar: "", bio: "Too short" }))
      .expect(400);
    expect(bad.body.error.fields).toMatchObject({ avatar: "Choose a photo or logo", bio: expect.any(String) });

    const created = await http().post("/authors").set(editor).send(author()).expect(201);
    expect(created.body.author.links).toEqual({ x: "https://x.com/sara" });
    await createArticle(connection.db, { slug: "by-sara", category: "career-advice", author: "sara-ali" });

    await http()
      .patch("/authors/sara-ali")
      .set(editor)
      .send(author({ slug: "sara" }))
      .expect(200);
    const [post] = await connection.db.select().from(articles).where(eq(articles.slug, "by-sara"));
    expect(post.author).toBe("sara");

    const list = await http().get("/authors").set(editor).expect(200);
    expect(list.body.find((a: { slug: string }) => a.slug === "sara")).toMatchObject({ posts: 1 });

    const used = await http().delete("/authors/sara").set(editor).expect(409);
    expect(used.body.error.message).toBe("Sara Ali is the author of 1 post. Reassign them first.");
    await connection.db.delete(articles).where(eq(articles.slug, "by-sara"));
    await http().delete("/authors/sara").set(editor).expect(204);
  });
});

describe("messages and subscribers", () => {
  it("lists, marks read, deletes, and exports a safe CSV", async () => {
    const [msg] = await connection.db
      .insert(messages)
      .values({ name: "Visitor", email: "v@example.com", message: "Hello there, a question about jobs." })
      .returning();
    await connection.db.insert(subscribers).values([{ email: "a@example.com" }, { email: "=cmd@example.com" }]);

    const inbox = await http().get("/messages").set(editor).expect(200);
    expect(inbox.body).toMatchObject({ unread: 1, subscribers: 2, items: [{ id: msg.id, read: false }] });
    expect((await http().get("/dashboard/badges").set(editor).expect(200)).body).toEqual({
      unreadMessages: 1,
      pendingJobs: 0,
    });

    await http().patch(`/messages/${msg.id}`).set(editor).send({ read: true }).expect(200);
    expect((await http().get("/messages").set(editor).expect(200)).body.unread).toBe(0);
    await http().patch("/messages/abc").set(editor).send({ read: true }).expect(400);

    const csv = await http().get("/subscribers/export.csv").set(editor).expect(200);
    expect(csv.headers["content-type"]).toMatch(/^text\/csv/);
    expect(csv.headers["content-disposition"]).toMatch(/attachment; filename="blognest-subscribers-/);
    const lines = csv.text.trim().split("\n");
    expect(lines[0]).toBe("email,confirmed,subscribed_at");
    expect(lines[2]).toMatch(/^"'=cmd@example.com",no,/);

    const subs = await http().get("/subscribers").set(editor).expect(200);
    const removed = await http()
      .delete("/subscribers")
      .set(editor)
      .send({ ids: subs.body.items.map((s: { id: number }) => s.id) })
      .expect(200);
    expect(removed.body).toEqual({ message: "2 subscribers removed.", removed: 2 });

    await http().delete(`/messages/${msg.id}`).set(editor).expect(204);
    await http().delete(`/messages/${msg.id}`).set(editor).expect(404);
  });
});

describe("settings", () => {
  const settings = {
    ads: {
      enabled: false,
      showPlaceholders: true,
      clientId: "",
      slots: { "in-article": "", sidebar: "", "below-article": "", listing: "" },
    },
    site: { contactEmail: "hello@example.com", social: { x: "", linkedin: "", github: "" } },
  };

  it("returns defaults, validates and saves; the website reads them", async () => {
    const defaults = await http().get("/settings").set(owner).expect(200);
    expect(defaults.body.ads.enabled).toBe(false);

    const bad = await http()
      .put("/settings")
      .set(owner)
      .send({ ...settings, site: { ...settings.site, contactEmail: "nope" } })
      .expect(400);
    expect(bad.body.error.fields).toHaveProperty(["site.contactEmail"]);
    const noClient = await http()
      .put("/settings")
      .set(owner)
      .send({ ...settings, ads: { ...settings.ads, enabled: true } })
      .expect(400);
    expect(noClient.body.error.fields).toEqual({ "ads.clientId": "Required when ads are on" });

    await http().put("/settings").set(owner).send(settings).expect(200);
    expect((await http().get("/settings").set(owner).expect(200)).body).toEqual(settings);
    expect((await http().get("/public/settings").expect(200)).body.site.contactEmail).toBe("hello@example.com");
  });
});

describe("dashboard, activity, search, preferences", () => {
  it("returns real numbers and the resolved layout", async () => {
    await createCategory(connection.db, { slug: "software-it", kind: "job" });
    await createJob(connection.db, {
      slug: "closing-soon",
      category: "software-it",
      featured: true,
      deadline: daysFromNow(2),
    });
    await createArticle(connection.db, {
      slug: "future-post",
      category: "career-advice",
      author: "editorial-team",
      publishedAt: daysFromNow(3),
    });

    const res = await http().get("/dashboard").set(editor).expect(200);
    expect(res.body.stats.posts.spark).toHaveLength(12);
    expect(res.body.stats.jobs.value).toBe(1);
    expect(res.body.traffic.points).toHaveLength(365);
    expect(res.body.lists.scheduled.map((i: { slug: string }) => i.slug)).toEqual(["future-post"]);
    expect(res.body.lists.expiring[0]).toMatchObject({
      slug: "closing-soon",
      meta: expect.stringMatching(/^Closes in/),
    });
    expect(res.body.featured).toMatchObject({ slug: "closing-soon" });
    expect(res.body.layout).toMatchObject({ hidden: [], mixStyle: "donut" });
    expect(res.body.activity[0]).toMatchObject({
      userName: "Owner",
      action: "updated",
      entity: "settings",
      href: null,
    });
  });

  it("pages the activity log", async () => {
    const res = await http().get("/activity?page=1").set(editor).expect(200);
    expect(res.body).toMatchObject({ page: 1, pageSize: 30 });
    expect(res.body.total).toBeGreaterThan(5);
    expect(res.body.items[0]).toHaveProperty("action");
  });

  it("saves the dashboard layout and theme", async () => {
    const saved = await http()
      .put("/me/dashboard-layout")
      .set(editor)
      .send({ order: ["recent", "stats"], hidden: ["rail"], mixStyle: "bubble" })
      .expect(200);
    expect(saved.body.order.slice(0, 2)).toEqual(["recent", "stats"]);
    await http()
      .put("/me/dashboard-layout")
      .set(editor)
      .send({ order: ["nope"], hidden: [] })
      .expect(400);
    expect((await http().get("/dashboard").set(editor).expect(200)).body.layout).toMatchObject({
      hidden: ["rail"],
      mixStyle: "bubble",
    });

    await http().put("/me/theme").set(editor).send({ theme: "dark" }).expect(200);
    await http().put("/me/theme").set(editor).send({ theme: "pink" }).expect(400);
    const [prefs] = await connection.db.select().from(userPrefs).where(eq(userPrefs.userId, editorId));
    expect(prefs.theme).toBe("dark");
    expect((await http().get("/auth/me").set(editor).expect(200)).body.user.theme).toBe("dark");
  });

  it("searches posts and jobs for staff, only their own jobs for companies", async () => {
    const staff = await http().get("/search?q=closing").set(editor).expect(200);
    expect(staff.body).toEqual([
      { kind: "job", slug: "closing-soon", title: "Frontend Developer · Acme", href: "/jobs/closing-soon" },
    ]);
    expect((await http().get("/search?q=a").set(editor).expect(200)).body).toEqual([]);
    expect((await http().get("/search?q=future").set(editor).expect(200)).body[0]).toMatchObject({ kind: "post" });
    // The staff job above has no company account, so Acme's account can't find it.
    expect((await http().get("/search?q=closing").set(company).expect(200)).body).toEqual([]);
    expect((await http().get("/search?q=future").set(company).expect(200)).body).toEqual([]);
  });
});
