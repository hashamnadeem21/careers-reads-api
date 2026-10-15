import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { resetEnvCache } from "../src/config/env.js";
import type { DbConnection } from "../src/db/client.js";
import { applications, candidates, privateFiles } from "../src/db/schema.js";
import { PrivateFilesService } from "../src/files/private-files.service.js";
import { MailerService } from "../src/mail/mailer.service.js";
import { createTestApp } from "./helpers/app.js";
import { FakeMailer } from "./helpers/fake-mailer.js";
import { bearer, createCandidateSession, createCategory, createUser, login } from "./helpers/seed.js";
import { connectTestDb, resetTestDb } from "./helpers/test-db.js";

let connection: DbConnection;
let app: NestExpressApplication;
let filesDir: string;
let owner: { authorization: string };
let sara: Record<string, string>;
let saraId: string;
let ali: Record<string, string>;
const http = () => request(app.getHttpServer());

const pdf = (text: string) => Buffer.from(`%PDF-1.7\n% ${text}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`);
const OLD_CV = pdf("first");
const NEW_CV = pdf("updated");

const job = (title: string) => ({
  title,
  company: "Career Reads",
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
  questions: [],
});

async function createJob(title: string): Promise<string> {
  return (await http().post("/jobs").set(owner).send(job(title)).expect(201)).body.job.slug;
}

/** Applies as the website's server does: with a file, or with `useSavedCv`. */
function apply(as: Record<string, string>, slug: string, cv: Buffer | "saved") {
  const req = http().post(`/public/jobs/${slug}/applications`).set(as);
  for (const [key, value] of Object.entries({ name: "Sara Khan", phone: "+92 300 1234567", consent: "true" })) void req.field(key, value);
  if (cv === "saved") void req.field("useSavedCv", "true");
  else void req.attach("cv", cv, "Sara CV.pdf");
  return req;
}

const savedFileId = async () =>
  (await connection.db.select({ id: candidates.cvFileId }).from(candidates).where(eq(candidates.id, saraId)))[0].id;

beforeAll(async () => {
  filesDir = await mkdtemp(path.join(os.tmpdir(), "blognest-mine-"));
  process.env.PRIVATE_FILES_DIR = filesDir;
  connection = await connectTestDb();
  resetEnvCache();
  await resetTestDb(connection);
  app = await createTestApp((m) => m.overrideProvider(MailerService).useValue(new FakeMailer()));
  await createCategory(connection.db, { slug: "software-it", kind: "job", name: "Software & IT" });
  owner = bearer((await login(app, (await createUser(connection.db, { role: "super_admin" })).email)).accessToken);
  const s = await createCandidateSession(app, connection.db, "sara@example.com");
  sara = s.headers;
  saraId = s.id;
  ali = (await createCandidateSession(app, connection.db, "ali@example.com", { name: "Ali" })).headers;
});

afterAll(async () => {
  await app.close();
  await connection.end();
  delete process.env.PRIVATE_FILES_DIR;
  await rm(filesDir, { recursive: true, force: true });
});

describe("my applications and saved CV", () => {
  let first: string;
  let second: string;
  let firstApplicationId: string;

  it("needs a signed-in candidate", async () => {
    await http().get("/public/candidate/applications").expect(403);
    await http().get("/public/candidate/applications").set({ "x-api-key": sara["x-api-key"] }).expect(401);
  });

  it("starts empty, with no saved CV and nothing to apply with", async () => {
    expect((await http().get("/public/candidate/applications").set(sara).expect(200)).body).toEqual({ cv: null, applications: [] });
    await http().get("/public/candidate/cv").set(sara).expect(404);
    first = await createJob("Support Engineer");
    const refused = await apply(sara, first, "saved").expect(400);
    expect(refused.body.error.fields.cv).toMatch(/saved CV is no longer available/);
  });

  it("saves the CV uploaded while applying, and lists the application with its status", async () => {
    expect((await apply(sara, first, OLD_CV).expect(201)).body.status).toBe("submitted");
    const mine = (await http().get("/public/candidate/applications").set(sara).expect(200)).body;
    expect(mine.cv).toMatchObject({ name: "Sara CV.pdf", contentType: "application/pdf", sizeBytes: OLD_CV.byteLength });
    expect(mine.applications).toEqual([
      expect.objectContaining({
        job: { title: "Support Engineer", company: "Career Reads", slug: first, open: true },
        status: "new",
        awaitingConfirmation: false,
        cv: { name: "Sara CV.pdf" },
      }),
    ]);
    firstApplicationId = mine.applications[0].id;
    expect(Buffer.from((await http().get("/public/candidate/cv").set(sara).expect(200)).body)).toEqual(OLD_CV);
  });

  it("shows the status the employer sets", async () => {
    await http().patch(`/applications/${firstApplicationId}/status`).set(owner).send({ status: "shortlisted" }).expect(200);
    const [application] = (await http().get("/public/candidate/applications").set(sara).expect(200)).body.applications;
    expect(application.status).toBe("shortlisted");
    expect(Date.parse(application.statusChangedAt)).toBeGreaterThanOrEqual(Date.parse(application.appliedAt));
  });

  it("replaces the saved CV; applications already sent keep theirs", async () => {
    const res = await http().post("/public/candidate/cv").set(sara).attach("cv", NEW_CV, "Sara CV 2026.pdf").expect(200);
    expect(res.body.cv).toMatchObject({ name: "Sara CV 2026.pdf", sizeBytes: NEW_CV.byteLength });
    expect(Buffer.from((await http().get("/public/candidate/cv").set(sara).expect(200)).body)).toEqual(NEW_CV);
    const sent = await http().get(`/public/candidate/applications/${firstApplicationId}/cv`).set(sara).expect(200);
    expect(Buffer.from(sent.body)).toEqual(OLD_CV);
    expect(sent.headers["content-disposition"]).toMatch(/^inline; filename="Sara CV.pdf"/);
    expect(sent.headers["cache-control"]).toBe("private, no-store");
  });

  it("applies with the saved CV in one step", async () => {
    second = await createJob("Data Analyst");
    await apply(sara, second, "saved").expect(201);
    const mine = (await http().get("/public/candidate/applications").set(sara).expect(200)).body;
    expect(mine.applications.map((a: { job: { slug: string } }) => a.job.slug)).toEqual([second, first]);
    expect(mine.applications[0].cv).toEqual({ name: "Sara CV 2026.pdf" });
    const [row] = await connection.db.select().from(applications).where(eq(applications.id, mine.applications[0].id));
    expect(row.resumeFileId).toBe(await savedFileId());
  });

  it("refuses files that aren't CVs", async () => {
    const res = await http().post("/public/candidate/cv").set(sara).attach("cv", Buffer.from("MZ not a cv"), "cv.pdf").expect(400);
    expect(res.body.error.fields.cv).toBeTruthy();
    await http().post("/public/candidate/cv").set(sara).expect(400);
  });

  it("never shows one candidate another's applications or CVs", async () => {
    expect((await http().get("/public/candidate/applications").set(ali).expect(200)).body).toEqual({ cv: null, applications: [] });
    await http().get(`/public/candidate/applications/${firstApplicationId}/cv`).set(ali).expect(404);
    await http().get("/public/candidate/cv").set(ali).expect(404);
  });

  it("removing the saved CV keeps the ones sent with applications; the sweep only deletes unused files", async () => {
    const files = app.get(PrivateFilesService);
    // An unused upload: replaced at once, so nothing points at it.
    await http().post("/public/candidate/cv").set(sara).attach("cv", pdf("typo"), "typo.pdf").expect(200);
    const typoId = await savedFileId();
    await http().post("/public/candidate/cv").set(sara).attach("cv", NEW_CV, "Sara CV final.pdf").expect(200);
    const finalId = await savedFileId();

    await http().delete("/public/candidate/cv").set(sara).expect(204);
    expect(await savedFileId()).toBeNull();
    expect((await http().get("/public/candidate/applications").set(sara).expect(200)).body.cv).toBeNull();

    await http().post("/public/candidate/cv").set(sara).attach("cv", NEW_CV, "Sara CV final.pdf").expect(200);
    const keptId = await savedFileId();
    expect(await files.sweep(new Date(Date.now() + 2 * 3_600_000))).toBe(2); // the typo and the removed one
    const left = (await connection.db.select({ id: privateFiles.id }).from(privateFiles)).map((f) => f.id);
    expect(left).not.toContain(typoId);
    expect(left).not.toContain(finalId);
    expect(left).toContain(keptId);
    await http().get(`/public/candidate/applications/${firstApplicationId}/cv`).set(sara).expect(200);
  });
});
