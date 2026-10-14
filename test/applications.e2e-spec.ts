import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { resetEnvCache } from "../src/config/env.js";
import type { DbConnection } from "../src/db/client.js";
import { applications, privateFiles } from "../src/db/schema.js";
import { MailerService } from "../src/mail/mailer.service.js";
import { SchedulerService } from "../src/scheduler/scheduler.service.js";
import { createTestApp } from "./helpers/app.js";
import { FakeMailer } from "./helpers/fake-mailer.js";
import { asSiteServer, bearer, createCandidateSession, createCategory, createCompany, createUser, login } from "./helpers/seed.js";
import { connectTestDb, resetTestDb } from "./helpers/test-db.js";

let connection: DbConnection;
let app: NestExpressApplication;
let filesDir: string;
let owner: { authorization: string };
let editor: { authorization: string };
let acme: { authorization: string };
let globex: { authorization: string };
let acmeId: string;
let acmeEmail: string;
const mailer = new FakeMailer();
const http = () => request(app.getHttpServer());
const HOUR = 3_600_000;

const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

const job = (over: Record<string, unknown> = {}) => ({
  title: "Support Engineer",
  company: "Acme",
  country: "Pakistan",
  workModel: "remote",
  employmentType: "full-time",
  category: "software-it",
  experience: "mid",
  summary: "Help customers succeed with our product and fix what slows them down.",
  postedAt: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
  deadline: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
  status: "published",
  onsiteApply: true,
  questions: [
    { kind: "yes_no", label: "Can you work night shifts?", required: true },
    { kind: "single_choice", label: "Notice period", options: ["Immediate", "1 month"] },
  ],
  ...over,
});

/** Signed-in candidates by email (accounts are created on first use). */
const sessions = new Map<string, Record<string, string>>();
async function signedIn(email: string): Promise<Record<string, string>> {
  const key = email.toLowerCase();
  if (!sessions.has(key)) sessions.set(key, (await createCandidateSession(app, connection.db, key)).headers);
  return { ...sessions.get(key)!, ...asSiteServer() };
}

/**
 * An application as the website's server sends it, signed in as the candidate whose email is in
 * `fields.email` (default sara@example.com). The account's email is what's stored.
 */
const apply = (slug: string, fields: Record<string, string> = {}, cv: Buffer | null = PDF) => {
  const { email = "Sara@Example.com", ...rest } = fields;
  const validEmail = /@/.test(email) ? email : "sara@example.com";
  const send = async () => {
    const req = http().post(`/public/jobs/${slug}/applications`).set(await signedIn(validEmail));
    const all = { name: "Sara Khan", phone: "+92 300 1234567", consent: "true", ...rest, ...(validEmail === email ? {} : { email }) };
    for (const [key, value] of Object.entries(all)) void req.field(key, value);
    if (cv) void req.attach("cv", cv, "Sara Khan CV.pdf");
    return { req }; // wrapped: awaiting a supertest request would send it
  };
  return { expect: async (status: number) => (await send()).req.expect(status) };
};

beforeAll(async () => {
  filesDir = await mkdtemp(path.join(os.tmpdir(), "blognest-private-"));
  process.env.PRIVATE_FILES_DIR = filesDir;
  connection = await connectTestDb();
  resetEnvCache();
  await resetTestDb(connection);
  app = await createTestApp((m) => m.overrideProvider(MailerService).useValue(mailer));
  await createCategory(connection.db, { slug: "software-it", kind: "job", name: "Software & IT" });
  owner = bearer((await login(app, (await createUser(connection.db, { role: "super_admin" })).email)).accessToken);
  editor = bearer((await login(app, (await createUser(connection.db, { role: "editor" })).email)).accessToken);

  const acmeCo = await createCompany(connection.db, { name: "Acme", autoPublish: true });
  acmeId = acmeCo.id;
  const acmeUser = await createUser(connection.db, { role: "company", companyId: acmeId });
  acmeEmail = acmeUser.email;
  acme = bearer((await login(app, acmeUser.email)).accessToken);
  const globexCo = await createCompany(connection.db, { name: "Globex", autoPublish: true, onsiteApplyEnabled: true });
  globex = bearer(
    (await login(app, (await createUser(connection.db, { role: "company", companyId: globexCo.id })).email))
      .accessToken,
  );
});

afterAll(async () => {
  await app.close();
  await connection.end();
  delete process.env.PRIVATE_FILES_DIR;
  await rm(filesDir, { recursive: true, force: true });
});

describe("on-site applications", () => {
  let slug: string;
  let questionIds: string[];
  let applicationId: string;

  it("needs a super admin to allow the company first", async () => {
    const refused = await http().post("/jobs").set(acme).send(job()).expect(400);
    expect(refused.body.error.fields.onsiteApply).toMatch(/aren't turned on for Acme/);

    await http().patch(`/companies/${acmeId}`).set(acme).send({ name: "Acme", onsiteApplyEnabled: true }).expect(403);
    await http()
      .patch(`/companies/${acmeId}`)
      .set(owner)
      .send({ name: "Acme", autoPublish: true, onsiteApplyEnabled: true })
      .expect(200);

    const created = await http().post("/jobs").set(acme).send(job()).expect(201);
    slug = created.body.job.slug;
    const detail = await http().get(`/jobs/${slug}`).set(acme).expect(200);
    expect(detail.body.questions).toMatchObject([
      { kind: "yes_no", label: "Can you work night shifts?", required: true, options: [] },
      { kind: "single_choice", label: "Notice period", options: ["Immediate", "1 month"] },
    ]);
    questionIds = detail.body.questions.map((q: { id: string }) => q.id);
  });

  it("keeps question ids when they're edited, so answers stay linked", async () => {
    const detail = await http().get(`/jobs/${slug}`).set(acme).expect(200);
    const [first, second] = detail.body.questions;
    await http()
      .patch(`/jobs/${slug}`)
      .set(acme)
      .send(job({ questions: [{ ...second, label: "Notice period?" }, first] }))
      .expect(200);
    const after = await http().get(`/jobs/${slug}`).set(acme).expect(200);
    expect(after.body.questions.map((q: { id: string; label: string }) => [q.id, q.label])).toEqual([
      [second.id, "Notice period?"],
      [first.id, "Can you work night shifts?"],
    ]);
    questionIds = [first.id, second.id];
  });

  it("shows the form on the website", async () => {
    expect((await http().get(`/public/jobs/${slug}`).expect(200)).body.onsiteApply).toBe(true);
    const form = await http().get(`/public/jobs/${slug}/application-form`).expect(200);
    expect(form.body.job).toEqual({ slug, title: "Support Engineer", company: "Acme" });
    expect(form.body.questions).toHaveLength(2);
  });

  it("only takes applications from the website's server", async () => {
    await http().post(`/public/jobs/${slug}/applications`).field("name", "Bot").expect(403);
  });

  it("reports every problem at once", async () => {
    const res = await apply(slug, { email: "nope", consent: "false", answers: "{}" }, null).expect(400);
    expect(res.body.error.fields).toMatchObject({
      email: "Enter a valid email address",
      consent: expect.any(String),
    });
    const second = await apply(slug, { answers: JSON.stringify({ [questionIds[1]]: "Next year" }) }, null).expect(400);
    expect(second.body.error.fields).toEqual({
      cv: "Attach your CV",
      [`answers.${questionIds[0]}`]: "Please answer this question",
      [`answers.${questionIds[1]}`]: "Choose one of the options",
    });
    const fake = await apply(
      slug,
      { answers: JSON.stringify({ [questionIds[0]]: "yes" }) },
      Buffer.from("MZ..."),
    ).expect(400);
    expect(fake.body.error.fields.cv).toBe("Upload your CV as a PDF or Word document.");
  });

  it("needs a signed-in candidate", async () => {
    await http().post(`/public/jobs/${slug}/applications`).set(asSiteServer()).field("name", "Sara").expect(401);
  });

  it("takes an application once per person, and says so when they apply again", async () => {
    const answers = JSON.stringify({ [questionIds[0]]: "yes", [questionIds[1]]: "1 month" });
    const res = await apply(slug, { answers, linkedinUrl: "https://linkedin.com/in/sara" }).expect(201);
    expect(res.body).toMatchObject({ status: "submitted", message: expect.stringMatching(/Application sent/) });
    const again = await apply(slug, { answers, email: "sara@example.com", name: "Someone Else" }).expect(201);
    expect(again.body.status).toBe("already_applied");
    expect(await connection.db.select().from(applications)).toHaveLength(1);

    const [row] = await connection.db.select().from(applications);
    applicationId = row.id;
    expect(row).toMatchObject({ email: "sara@example.com", companyId: acmeId, status: "new", notifiedAt: null });
    expect(await readdir(filesDir, { recursive: true })).toContainEqual(expect.stringMatching(/\.pdf$/));
  });

  it("quietly drops applications that fill in the hidden bot field", async () => {
    await apply(slug, { email: "bot@spam.test", website: "http://spam.test", answers: "{}" }).expect(201);
    expect(await connection.db.select().from(applications)).toHaveLength(1);
  });

  it("emails the candidate and the company once", async () => {
    mailer.reset();
    await app.get(SchedulerService).run();
    expect(mailer.sent.map((m) => [m.to, m.subject])).toEqual([
      ["sara@example.com", "Application sent: Support Engineer at Acme"],
      [acmeEmail, "New application: Support Engineer"],
    ]);
    expect(mailer.sent[1].replyTo).toBe("sara@example.com");
    expect(mailer.sent[1].html).toContain(`/applications/${applicationId}`);
    await app.get(SchedulerService).run();
    expect(mailer.sent).toHaveLength(2);
  });

  it("keeps each company to its own applicants", async () => {
    expect((await http().get("/applications").set(globex).expect(200)).body.total).toBe(0);
    await http().get(`/applications/${applicationId}`).set(globex).expect(404);
    await http().get(`/applications/${applicationId}/cv`).set(globex).expect(404);
    await http().patch(`/applications/${applicationId}/status`).set(globex).send({ status: "rejected" }).expect(404);
    await http()
      .post("/applications/bulk-status")
      .set(globex)
      .send({ ids: [applicationId], status: "hired" })
      .expect(404);
    expect((await http().get("/applications/export").set(globex).expect(200)).text).not.toContain("Sara");
    // Editors see applications to Career Reads' own jobs only; the super admin sees all.
    await http().get(`/applications/${applicationId}`).set(editor).expect(404);
    await http().get(`/applications/${applicationId}`).set(owner).expect(200);
    // A job with applicants can't be handed to another company.
    const moved = await http()
      .patch(`/jobs/${slug}`)
      .set(owner)
      .send(job({ companyId: "" }))
      .expect(400);
    expect(moved.body.error.fields.companyId).toMatch(/has applications/);
  });

  it("lets the company review the application", async () => {
    const list = await http().get(`/applications?job=${slug}`).set(acme).expect(200);
    expect(list.body).toMatchObject({ total: 1, counts: { all: 1, new: 1 } });
    expect(list.body.items[0]).toMatchObject({ name: "Sara Khan", job: { slug, title: "Support Engineer" } });
    expect((await http().get("/applications/new-count").set(acme).expect(200)).body).toEqual({ count: 1 });

    const cv = await http().get(`/applications/${applicationId}/cv`).set(acme).expect(200);
    expect(cv.headers["content-type"]).toBe("application/pdf");
    expect(cv.headers["content-disposition"]).toMatch(/^inline; filename="Sara Khan CV.pdf"/);
    expect(Buffer.from(cv.body as Buffer).equals(PDF)).toBe(true);
    const download = await http().get(`/applications/${applicationId}/cv?download=true`).set(acme).expect(200);
    expect(download.headers["content-disposition"]).toMatch(/^attachment;/);

    await http().patch(`/applications/${applicationId}/status`).set(acme).send({ status: "shortlisted" }).expect(200);
    await http()
      .post(`/applications/${applicationId}/notes`)
      .set(acme)
      .send({ note: "Strong support background" })
      .expect(201);

    const detail = await http().get(`/applications/${applicationId}`).set(acme).expect(200);
    expect(detail.body.application).toMatchObject({
      status: "shortlisted",
      linkedinUrl: "https://linkedin.com/in/sara",
    });
    expect(detail.body.application).not.toHaveProperty("candidateId");
    expect(detail.body.cv).toEqual({ name: "Sara Khan CV.pdf", contentType: "application/pdf", sizeBytes: PDF.length });
    expect(detail.body.answers).toEqual([
      { label: "Notice period?", kind: "single_choice", value: "1 month" },
      { label: "Can you work night shifts?", kind: "yes_no", value: true },
    ]);
    // Opening the CV twice in a row is logged once.
    expect(detail.body.events.map((e: { kind: string }) => e.kind)).toEqual(["note", "status_changed", "cv_viewed"]);
  });

  it("exports a CSV with a column per question", async () => {
    const csv = (await http().get(`/applications/export?job=${slug}`).set(acme).expect(200)).text;
    const [header, row] = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(header).toBe(
      "Name,Email,Phone,Location,LinkedIn,Job,Status,Applied,Notice period?,Can you work night shifts?",
    );
    // A cell starting with "+" would run as a formula in Excel.
    expect(row).toMatch(
      /^Sara Khan,sara@example.com,'\+92 300 1234567,,https:\/\/linkedin.com\/in\/sara,Support Engineer,shortlisted,\d{4}-\d{2}-\d{2},1 month,Yes$/,
    );
  });

  it("stops taking applications when the super admin turns the company off", async () => {
    await http()
      .patch(`/companies/${acmeId}`)
      .set(owner)
      .send({ name: "Acme", autoPublish: true, onsiteApplyEnabled: false })
      .expect(200);
    await http().get(`/public/jobs/${slug}/application-form`).expect(404);
    // On-site was its only way to apply, so it leaves the site; the company still sees its applicants.
    await http().get(`/public/jobs/${slug}`).expect(404);
    expect((await http().get("/applications").set(acme).expect(200)).body.total).toBe(1);
    await http()
      .patch(`/companies/${acmeId}`)
      .set(owner)
      .send({ name: "Acme", autoPublish: true, onsiteApplyEnabled: true })
      .expect(200);
  });

  it("only deletes a job with applicants when that's confirmed, then removes the CV", async () => {
    const refused = await http().delete(`/jobs/${slug}`).set(acme).expect(409);
    expect(refused.body.error).toMatchObject({ code: "has_applications", details: { applications: 1 } });
    await http().delete(`/jobs/${slug}?withApplications=true`).set(acme).expect(204);
    expect(await connection.db.select().from(applications)).toHaveLength(0);

    const scheduler = app.get(SchedulerService);
    expect(await scheduler.housekeeping(new Date())).toEqual({ applications: 0, files: 0 }); // still within the grace hour
    // Sara's CV (her repeat application was turned away before its CV was stored).
    expect(await scheduler.housekeeping(new Date(Date.now() + 2 * HOUR))).toEqual({ applications: 0, files: 1 });
    expect(await connection.db.select().from(privateFiles)).toHaveLength(0);
    expect((await readdir(filesDir, { recursive: true })).filter((f) => f.endsWith(".pdf"))).toEqual([]);
  });

  it("deletes applications after the retention period, and a person's data on request", async () => {
    const created = await http()
      .post("/jobs")
      .set(acme)
      .send(job({ questions: [] }))
      .expect(201);
    const newSlug = created.body.job.slug;
    await apply(newSlug, { email: "ali@example.com" }).expect(201);
    await apply(newSlug, { email: "zoe@example.com" }).expect(201);

    const scheduler = app.get(SchedulerService);
    const in200Days = new Date(Date.now() + 200 * 24 * HOUR);
    await http().post("/applications/forget").set(acme).send({ email: "zoe@example.com" }).expect(403);
    const forgot = await http().post("/applications/forget").set(owner).send({ email: "ZOE@example.com" }).expect(200);
    expect(forgot.body.message).toMatch(/Deleted 1 application/);
    expect((await scheduler.housekeeping(in200Days)).applications).toBe(1);
    expect(await connection.db.select().from(applications).where(eq(applications.jobId, created.body.job.id))).toEqual(
      [],
    );
  });
});
