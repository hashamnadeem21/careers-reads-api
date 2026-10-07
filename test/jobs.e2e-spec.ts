import type { NestExpressApplication } from "@nestjs/platform-express";
import { eq } from "drizzle-orm";
import request from "supertest";
import type { DbConnection } from "../src/db/client.js";
import { dailyStats, jobs } from "../src/db/schema.js";
import { createTestApp } from "./helpers/app.js";
import { bearer, createCategory, createCompany, createJob, createUser, login } from "./helpers/seed.js";
import { connectTestDb, resetTestDb } from "./helpers/test-db.js";

let connection: DbConnection;
let app: NestExpressApplication;
let editor: { authorization: string };
let acme: { authorization: string };
let globex: { authorization: string };
let acmeId: string;
const http = () => request(app.getHttpServer());

const job = (over: Record<string, unknown> = {}) => ({
  title: "Backend Engineer",
  company: "Quality Assurance Labs",
  city: "Lahore",
  country: "Pakistan",
  workModel: "hybrid",
  employmentType: "full-time",
  category: "software-it",
  experience: "mid",
  summary: "Design and run reliable APIs for a fast-growing hiring product.",
  responsibilities: ["Build and maintain REST APIs", ""],
  requirements: ["3+ years with Node.js and Postgres"],
  applyEmail: "careers@qa-labs.test",
  postedAt: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
  deadline: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
  status: "published",
  ...over,
});

const publicSlugs = async () =>
  (await http().get("/public/jobs").expect(200)).body.map((j: { slug: string }) => j.slug) as string[];

beforeAll(async () => {
  connection = await connectTestDb();
  await resetTestDb(connection);
  app = await createTestApp();
  await createCategory(connection.db, { slug: "software-it", kind: "job", name: "Software & IT" });
  const staff = await createUser(connection.db, { role: "editor" });
  editor = bearer((await login(app, staff.email)).accessToken);

  const acmeCo = await createCompany(connection.db, { name: "Acme" });
  acmeId = acmeCo.id;
  const acmeUser = await createUser(connection.db, { role: "company", companyId: acmeCo.id });
  acme = bearer((await login(app, acmeUser.email)).accessToken);

  const globexCo = await createCompany(connection.db, { name: "Globex", autoPublish: true });
  const globexUser = await createUser(connection.db, { role: "company", companyId: globexCo.id });
  globex = bearer((await login(app, globexUser.email)).accessToken);
});

afterAll(async () => {
  await app.close();
  await connection.end();
});

describe("jobs (staff)", () => {
  it("creates a job that appears on the website, then unpublishes it", async () => {
    const res = await http().post("/jobs").set(editor).send(job()).expect(201);
    expect(res.body).toMatchObject({
      notice: "saved-offline",
      job: {
        slug: "backend-engineer-quality-assurance-labs",
        status: "published",
        review: null,
        responsibilities: ["Build and maintain REST APIs"],
      },
    });
    expect(await publicSlugs()).toContain("backend-engineer-quality-assurance-labs");

    const off = await http()
      .post("/jobs/backend-engineer-quality-assurance-labs/status")
      .set(editor)
      .send({ status: "draft" })
      .expect(200);
    expect(off.body.message).toMatch(/^Unpublished\./);
    expect(await publicSlugs()).not.toContain("backend-engineer-quality-assurance-labs");
    await http().get("/public/jobs/backend-engineer-quality-assurance-labs").expect(404);
  });

  it("returns field errors and refuses taken slugs and unknown categories", async () => {
    const bad = await http()
      .post("/jobs")
      .set(editor)
      .send(job({ title: "QA", applyEmail: "" }))
      .expect(400);
    expect(bad.body.error.fields).toMatchObject({ title: expect.any(String) });

    const taken = await http().post("/jobs").set(editor).send(job()).expect(400);
    expect(taken.body.error.fields.slug).toMatch(/already used/);

    const category = await http()
      .post("/jobs")
      .set(editor)
      .send(job({ slug: "x-job", category: "nope" }))
      .expect(400);
    expect(category.body.error.fields).toEqual({ category: "Pick a job category" });
  });

  it("renaming keeps stats; duplicate makes a draft copy; close and delete", async () => {
    await connection.db
      .insert(dailyStats)
      .values({ day: "2026-10-01", path: "/jobs/backend-engineer-quality-assurance-labs", kind: "view", count: 4 });
    await http()
      .patch("/jobs/backend-engineer-quality-assurance-labs")
      .set(editor)
      .send(job({ slug: "backend-engineer" }))
      .expect(200);
    const detail = await http().get("/jobs/backend-engineer").set(editor).expect(200);
    expect(detail.body.stats).toEqual({ views: 4, applies: 0 });

    const copy = await http().post("/jobs/backend-engineer/duplicate").set(editor).expect(201);
    expect(copy.body).toEqual({ slug: "backend-engineer-copy", message: "Copied as a new draft." });
    const [row] = await connection.db.select().from(jobs).where(eq(jobs.slug, "backend-engineer-copy"));
    expect(row).toMatchObject({ status: "draft", title: "Backend Engineer (copy)", deadline: null });

    await http().post("/jobs/backend-engineer/close").set(editor).expect(200);
    expect(await publicSlugs()).not.toContain("backend-engineer");

    await http().delete("/jobs/backend-engineer-copy").set(editor).expect(204);
    await http().get("/jobs/backend-engineer-copy").set(editor).expect(404);
  });
});

describe("jobs (company accounts)", () => {
  it("an untrusted company's job waits for review, then goes live when approved", async () => {
    const res = await http()
      .post("/jobs")
      .set(acme)
      .send(job({ title: "Data Analyst", company: "Someone Else", featured: true }))
      .expect(201);
    // The company name comes from the account; featuring is a staff decision.
    expect(res.body).toMatchObject({
      notice: "submitted",
      job: { slug: "data-analyst-someone-else", company: "Acme", companyId: acmeId, featured: false },
    });
    expect(res.body.job).toMatchObject({ status: "draft", review: "pending" });
    expect(await publicSlugs()).not.toContain("data-analyst-someone-else");
    expect((await http().get("/jobs/review-count").set(editor).expect(200)).body).toEqual({ count: 1 });
    await http().get("/jobs/review-count").set(acme).expect(403);
    await http().post("/jobs/data-analyst-someone-else/approve").set(acme).expect(403);

    await http().post("/jobs/data-analyst-someone-else/approve").set(editor).expect(200);
    expect(await publicSlugs()).toContain("data-analyst-someone-else");
    await http().post("/jobs/data-analyst-someone-else/approve").set(editor).expect(409);
  });

  it("editing a live job sends it back to review; staff can send it back with a note", async () => {
    await http()
      .patch("/jobs/data-analyst-someone-else")
      .set(acme)
      .send(job({ title: "Senior Data Analyst", slug: "data-analyst-someone-else" }))
      .expect(200);
    expect(await publicSlugs()).not.toContain("data-analyst-someone-else");

    const short = await http()
      .post("/jobs/data-analyst-someone-else/reject")
      .set(editor)
      .send({ note: "no" })
      .expect(400);
    expect(short.body.error.fields.note).toMatch(/at least 5/);
    await http()
      .post("/jobs/data-analyst-someone-else/reject")
      .set(editor)
      .send({ note: "Please add a salary range." })
      .expect(200);
    const detail = await http().get("/jobs/data-analyst-someone-else").set(acme).expect(200);
    expect(detail.body.job).toMatchObject({ review: "rejected", reviewNote: "Please add a salary range." });
  });

  it("a trusted company publishes directly", async () => {
    const res = await http()
      .post("/jobs")
      .set(globex)
      .send(job({ title: "Product Designer" }))
      .expect(201);
    expect(res.body.job).toMatchObject({ status: "published", review: "approved", company: "Globex" });
    expect(await publicSlugs()).toContain(res.body.job.slug);
  });

  it("each company sees and changes only its own jobs", async () => {
    const staffJob = await createJob(connection.db, { category: "software-it" });
    const list = await http().get("/jobs").set(acme).expect(200);
    expect(list.body.rows.map((r: { job: { slug: string } }) => r.job.slug)).toEqual(["data-analyst-someone-else"]);
    expect(list.body.counts.all).toBe(1);

    await http().get(`/jobs/${staffJob.slug}`).set(acme).expect(404);
    await http().patch(`/jobs/${staffJob.slug}`).set(acme).send(job()).expect(404);
    await http().delete(`/jobs/${staffJob.slug}`).set(acme).expect(404);
    await http()
      .post("/jobs/bulk")
      .set(acme)
      .send({ action: "delete", slugs: [staffJob.slug] })
      .expect(404);
    await http().get(`/jobs/${staffJob.slug}`).set(editor).expect(200);

    const staffList = await http().get(`/jobs?company=${acmeId}`).set(editor).expect(200);
    expect(staffList.body.total).toBe(1);
  });

  it("bulk publish from an untrusted company goes to review", async () => {
    const res = await http()
      .post("/jobs/bulk")
      .set(acme)
      .send({ action: "publish", slugs: ["data-analyst-someone-else"] })
      .expect(200);
    expect(res.body.message).toBe("1 job sent for review.");
    const review = await http().get("/jobs?status=review").set(editor).expect(200);
    expect(review.body.rows.map((r: { job: { slug: string } }) => r.job.slug)).toEqual(["data-analyst-someone-else"]);
  });
});
