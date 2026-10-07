import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { resetEnvCache } from "../src/config/env.js";
import type { DbConnection } from "../src/db/client.js";
import { createTestApp } from "./helpers/app.js";
import { bearer, createAuthor, createCategory, createCompany, createUser, login } from "./helpers/seed.js";
import { connectTestDb, resetTestDb } from "./helpers/test-db.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

let connection: DbConnection;
let app: NestExpressApplication;
let editor: { authorization: string };
let uploadsDir: string;
const http = () => request(app.getHttpServer());
const fileOf = (url: string) => path.join(uploadsDir, url.replace("/uploads/", ""));

beforeAll(async () => {
  connection = await connectTestDb();
  uploadsDir = mkdtempSync(path.join(tmpdir(), "api-uploads-"));
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.BLOB_READ_WRITE_TOKEN = "";
  resetEnvCache();
  await resetTestDb(connection);
  app = await createTestApp();
  await createCategory(connection.db, { slug: "technology", kind: "blog" });
  await createAuthor(connection.db, { slug: "editorial-team" });
  const user = await createUser(connection.db, { role: "editor" });
  editor = bearer((await login(app, user.email)).accessToken);
});

afterAll(async () => {
  await app.close();
  await connection.end();
  rmSync(uploadsDir, { recursive: true, force: true });
  delete process.env.UPLOADS_DIR;
});

describe("media", () => {
  let heroId: string;
  let heroUrl: string;

  it("is staff only", async () => {
    const company = await createCompany(connection.db);
    const member = await createUser(connection.db, { role: "company", companyId: company.id });
    const token = bearer((await login(app, member.email)).accessToken);
    await http().get("/media").set(token).expect(403);
    await http().post("/media").set(token).attach("files", PNG, "a.png").expect(403);
  });

  it("checks each file by its bytes and saves the real images", async () => {
    const res = await http()
      .post("/media")
      .set(editor)
      .field("alt", "A tiny QA test image")
      .attach("files", PNG, "My Hero (1).PNG")
      .attach("files", Buffer.from("<svg onload=alert(1)>"), { filename: "evil.png", contentType: "image/png" })
      .expect(201);
    expect(res.body.errors).toEqual([{ name: "evil.png", error: "Only JPG, PNG, WebP and AVIF images are allowed." }]);
    expect(res.body.uploaded).toHaveLength(1);
    const [item] = res.body.uploaded;
    expect(item).toMatchObject({ alt: "A tiny QA test image", width: 1, height: 1, sizeBytes: PNG.length });
    expect(item.url).toMatch(/^\/uploads\/my-hero-1-[0-9a-f]{16}\.png$/);
    expect(item.previewUrl).toBe(`http://localhost:3000${item.url}`);
    expect(existsSync(fileOf(item.url))).toBe(true);
    heroId = item.id;
    heroUrl = item.url;
  });

  it("refuses files over 5 MB and empty uploads", async () => {
    const big = await http()
      .post("/media")
      .set(editor)
      .attach("files", Buffer.alloc(5 * 1024 * 1024 + 1), "big.png")
      .expect(413);
    expect(big.body.error).toEqual({ code: "file_too_large", message: "Images must be 5 MB or smaller." });
    await http().post("/media").set(editor).field("alt", "x").expect(400);
  });

  it("searches, edits alt text and reports usage", async () => {
    const list = await http().get("/media?q=tiny").set(editor).expect(200);
    expect(list.body).toMatchObject({ total: 1, page: 1, pageSize: 48 });
    expect((await http().get("/media?q=nothing-here").set(editor).expect(200)).body.total).toBe(0);

    const tooLong = await http()
      .patch(`/media/${heroId}`)
      .set(editor)
      .send({ alt: "x".repeat(201) })
      .expect(400);
    expect(tooLong.body.error.fields.alt).toMatch(/200 characters/);
    const saved = await http().patch(`/media/${heroId}`).set(editor).send({ alt: "A hero image" }).expect(200);
    expect(saved.body).toMatchObject({ message: "Alt text saved.", item: { alt: "A hero image" } });

    expect((await http().get(`/media/${heroId}/usage`).set(editor).expect(200)).body).toEqual([]);
  });

  it("an uploaded image used by a published post shows on the website and can't be deleted", async () => {
    await http()
      .post("/posts")
      .set(editor)
      .send({
        slug: "post-with-uploaded-hero",
        title: "A post with an uploaded hero",
        excerpt: "This post uses an image uploaded through the API, then gets published to the website.",
        body: "Intro paragraph.\n\n## Section\n\nSome words here.",
        category: "technology",
        tags: ["testing"],
        author: "editorial-team",
        coverImage: heroUrl,
        coverAlt: "An uploaded hero image",
        coverWidth: 1,
        coverHeight: 1,
        images: [],
        seoTitle: "",
        seoDescription: "",
        canonicalUrl: "",
        noindex: false,
        ads: true,
        featured: false,
        trending: false,
        editorsPick: false,
        intent: "publish",
      })
      .expect(201);
    const live = await http().get("/public/articles/post-with-uploaded-hero").expect(200);
    expect(live.body.coverImage).toBe(heroUrl);

    const usage = await http().get(`/media/${heroId}/usage`).set(editor).expect(200);
    expect(usage.body).toEqual([
      {
        kind: "post",
        slug: "post-with-uploaded-hero",
        title: "A post with an uploaded hero",
        where: "Hero image",
        href: "/posts/post-with-uploaded-hero",
      },
    ]);
    const refused = await http().delete(`/media/${heroId}`).set(editor).expect(409);
    expect(refused.body.error).toMatchObject({ code: "in_use", details: { usage: usage.body } });
    expect(existsSync(fileOf(heroUrl))).toBe(true);
  });

  it("deletes an unused image and its file", async () => {
    await http().delete("/posts/post-with-uploaded-hero").set(editor).expect(204);
    await http().delete(`/media/${heroId}`).set(editor).expect(204);
    expect(existsSync(fileOf(heroUrl))).toBe(false);
    await http().delete(`/media/${heroId}`).set(editor).expect(404);
    await http().get("/media/not-a-uuid/usage").set(editor).expect(400);
  });
});
