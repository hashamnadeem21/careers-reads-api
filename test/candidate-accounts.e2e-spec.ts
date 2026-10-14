import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { GoogleVerifier, type GoogleProfile } from "../src/candidates/google-verifier.service.js";
import { resetEnvCache } from "../src/config/env.js";
import type { DbConnection } from "../src/db/client.js";
import { applications, auditLog, candidates, subscribers } from "../src/db/schema.js";
import { MailerService } from "../src/mail/mailer.service.js";
import { SchedulerService } from "../src/scheduler/scheduler.service.js";
import { createTestApp } from "./helpers/app.js";
import { FakeMailer } from "./helpers/fake-mailer.js";
import { asAdminServer, asSiteServer, bearer, createCategory, createCompany, createJob, createUser, login } from "./helpers/seed.js";
import { connectTestDb, resetTestDb } from "./helpers/test-db.js";

/** A credential "google:<email>:<sub>" verifies to that profile. */
class FakeGoogle {
  enabled() {
    return true;
  }
  async verify(credential: string): Promise<GoogleProfile | null> {
    const [kind, email, sub] = credential.split(":");
    if (kind !== "google" || !email || !sub) return null;
    return { sub, email, name: "Gina Google", picture: null };
  }
}

let connection: DbConnection;
let app: NestExpressApplication;
let filesDir: string;
let slug: string;
let staff: { owner: Record<string, string>; editor: Record<string, string>; company: Record<string, string> };
const mailer = new FakeMailer();
const http = () => request(app.getHttpServer());
const site = () => asSiteServer();
const asCandidate = (token: string) => ({ ...asSiteServer(), "x-candidate-session": token });
const run = () => app.get(SchedulerService).run(new Date(Date.now() + 60_000));
const googleCredential = (email: string) => `google:${email}:sub-${email}`.padEnd(24, "x");
const PASSWORD = "a-good-password-1";
const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

const signUp = (email: string, name = "Sam Seeker") =>
  http().post("/public/candidate/auth/signup").set(site()).send({ name, email, password: PASSWORD, acceptTerms: true });

const apply = (token: string, jobSlug = slug) =>
  http()
    .post(`/public/jobs/${jobSlug}/applications`)
    .set(asCandidate(token))
    .field("name", "Sam Seeker")
    .field("phone", "+92 300 1234567")
    .field("consent", "true")
    .field("answers", "{}")
    .attach("cv", PDF, "Sam CV.pdf");

const linkToken = (text: string, linkPath: string) => {
  const match = new RegExp(`${linkPath}\\?token=([A-Za-z0-9_-]+)`).exec(text);
  if (!match) throw new Error(`No ${linkPath} link in email`);
  return match[1];
};

const adminList = async (who: Record<string, string>, query = "") =>
  (await http().get(`/candidates${query}`).set(who).expect(200)).body;

beforeAll(async () => {
  filesDir = await mkdtemp(path.join(os.tmpdir(), "blognest-private-"));
  process.env.PRIVATE_FILES_DIR = filesDir;
  process.env.PUBLIC_SITE_URL = "http://site.test";
  process.env.GOOGLE_CLIENT_ID = "1234-test.apps.googleusercontent.com";
  connection = await connectTestDb();
  resetEnvCache();
  app = await createTestApp((m) =>
    m.overrideProvider(MailerService).useValue(mailer).overrideProvider(GoogleVerifier).useValue(new FakeGoogle()),
  );
});

afterAll(async () => {
  await app.close();
  await connection.end();
  delete process.env.PRIVATE_FILES_DIR;
  delete process.env.PUBLIC_SITE_URL;
  delete process.env.GOOGLE_CLIENT_ID;
  resetEnvCache();
  await rm(filesDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetTestDb(connection);
  mailer.reset();
  await createCategory(connection.db, { slug: "software-it", kind: "job", name: "Software & IT" });
  slug = (await createJob(connection.db, { category: "software-it", onsiteApply: true, applyUrl: null, title: "Support Engineer", company: "Career Reads" })).slug;
  const as = async (role: "super_admin" | "editor") =>
    ({ ...asAdminServer(), ...bearer((await login(app, (await createUser(connection.db, { role })).email)).accessToken) });
  staff = { owner: await as("super_admin"), editor: await as("editor"), company: {} };
  const company = await createCompany(connection.db, { name: "Acme" });
  const companyUser = await createUser(connection.db, { role: "company", companyId: company.id });
  staff.company = { ...asAdminServer(), ...bearer((await login(app, companyUser.email)).accessToken) };
});

describe("applying before confirming the email", () => {
  it("holds the application, hides it from the employer, and sends it once they confirm", async () => {
    const res = await signUp("sam@example.com").expect(201);
    const token = res.body.session.token as string;

    const held = await apply(token).expect(201);
    expect(held.body).toEqual({ status: "held", message: expect.stringMatching(/confirm your email/) });
    const again = await apply(token).expect(201);
    expect(again.body.status).toBe("already_applied");

    // Hidden everywhere staff look, and no "new application" emails yet: only the welcome goes out.
    expect((await http().get("/applications").set(staff.owner).expect(200)).body.total).toBe(0);
    await run();
    expect(mailer.sent.map((m) => m.subject)).toEqual(["Welcome to Career Reads, Sam 🎉"]);
    const confirmToken = linkToken(mailer.sent[0].text, "/account/confirm-email");

    // The super admin sees it on the candidate's page, marked as waiting.
    const [candidate] = await connection.db.select().from(candidates).where(eq(candidates.email, "sam@example.com"));
    const detail = (await http().get(`/candidates/${candidate.id}`).set(staff.owner).expect(200)).body;
    expect(detail.applications).toEqual([expect.objectContaining({ awaitingConfirmation: true, job: expect.objectContaining({ slug }) })]);

    mailer.reset();
    await http().post("/public/candidate/auth/confirm-email").set(site()).send({ token: confirmToken }).expect(200);
    expect((await http().get("/applications").set(staff.owner).expect(200)).body.total).toBe(1);
    await run();
    expect(mailer.sent.map((m) => [m.to, m.subject])).toEqual(
      expect.arrayContaining([["sam@example.com", "Application sent: Support Engineer at Career Reads"]]),
    );
  });

  it("sends straight away once the email is confirmed, and resend makes a fresh link", async () => {
    const res = await signUp("sam@example.com").expect(201);
    const token = res.body.session.token as string;
    mailer.reset();
    await http().post("/public/candidate/auth/resend-confirmation").set(asCandidate(token)).expect(200);
    expect(mailer.sent.map((m) => m.subject)).toEqual(["Confirm your email for Career Reads"]);
    const confirm = linkToken(mailer.sent[0].text, "/account/confirm-email");
    await http().post("/public/candidate/auth/confirm-email").set(site()).send({ token: confirm }).expect(200);

    const sent = await apply(token).expect(201);
    expect(sent.body.status).toBe("submitted");
    expect((await http().get("/applications").set(staff.owner).expect(200)).body.total).toBe(1);
  });

  it("drops a held application when the real owner of the email signs in with Google", async () => {
    const squatter = await signUp("owner@example.com").expect(201);
    await apply(squatter.body.session.token).expect(201);
    await http().post("/public/candidate/auth/google").set(site()).send({ credential: googleCredential("owner@example.com") }).expect(201);
    expect(await connection.db.select().from(applications)).toEqual([]);
  });

  it("only lets signed-in candidates apply", async () => {
    await http().post(`/public/jobs/${slug}/applications`).set(site()).field("name", "Sam").expect(401);
    await http().post(`/public/jobs/${slug}/applications`).set(asCandidate("x".repeat(43))).field("name", "Sam").expect(401);
  });
});

describe("deleting your own account", () => {
  it("removes the account, its sessions, applications and newsletter subscription", async () => {
    const res = await http().post("/public/candidate/auth/google").set(site()).send({ credential: googleCredential("gina@example.com") }).expect(201);
    const token = res.body.session.token as string;
    await apply(token).expect(201);
    await http().post("/public/candidate/subscribe").set(asCandidate(token)).expect(200);

    await http().delete("/public/candidate/me").set(asCandidate(token)).expect(204);
    await http().get("/public/candidate/me").set(asCandidate(token)).expect(401);
    expect(await connection.db.select().from(candidates)).toEqual([]);
    expect(await connection.db.select().from(applications)).toEqual([]);
    expect(await connection.db.select().from(subscribers)).toEqual([]);
  });
});

describe("the super admin's Candidates page", () => {
  it("lists accounts with stats and filters, and only the super admin may see it", async () => {
    await signUp("sam@example.com").expect(201);
    const gina = await http().post("/public/candidate/auth/google").set(site()).send({ credential: googleCredential("gina@example.com") }).expect(201);
    await http().post("/public/candidate/subscribe").set(asCandidate(gina.body.session.token)).expect(200);
    // Someone who applied before accounts existed has no account and isn't listed.
    await connection.db.insert(candidates).values({ email: "old@example.com", name: "Old Applicant" });

    const all = await adminList(staff.owner);
    expect(all.total).toBe(2);
    expect(all.items.map((c: { email: string }) => c.email)).toEqual(["gina@example.com", "sam@example.com"]);
    expect(all.stats).toEqual({ accounts: 2, newThisWeek: 2, google: 1, password: 1, subscribed: 1, activeThisWeek: 2 });
    expect(all.items[0]).toMatchObject({ signupMethod: "google", emailVerified: true, subscribed: true, signInCount: 1, applications: 0 });
    expect(all.items[1]).toMatchObject({ signupMethod: "password", emailVerified: false, subscribed: false });

    expect((await adminList(staff.owner, "?method=password")).items.map((c: { email: string }) => c.email)).toEqual(["sam@example.com"]);
    expect((await adminList(staff.owner, "?subscribed=yes")).total).toBe(1);
    expect((await adminList(staff.owner, "?subscribed=no")).total).toBe(1);
    expect((await adminList(staff.owner, "?q=GINA")).total).toBe(1);
    expect((await adminList(staff.owner, "?q=%25")).total).toBe(0);
    expect((await adminList(staff.owner, "?from=2999-01-01")).total).toBe(0);
    await http().get("/candidates?method=apply").set(staff.owner).expect(400);

    await http().get("/candidates").set(staff.editor).expect(403);
    await http().get("/candidates").set(staff.company).expect(403);
    await http().get("/candidates/export").set(staff.company).expect(403);
    await http().get(`/candidates/${all.items[0].id}`).set(staff.editor).expect(403);
    await http().delete(`/candidates/${all.items[0].id}`).set(staff.company).expect(403);
  });

  it("shows one candidate's history", async () => {
    const res = await signUp("sam@example.com").expect(201);
    await http().post("/public/candidate/auth/login").set(site()).send({ email: "sam@example.com", password: PASSWORD }).expect(200);
    await apply(res.body.session.token).expect(201);
    const [candidate] = await connection.db.select().from(candidates);
    const detail = (await http().get(`/candidates/${candidate.id}`).set(staff.owner).expect(200)).body;
    expect(detail.candidate).toMatchObject({ email: "sam@example.com", signInCount: 2, applications: 1 });
    expect(detail.history.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(["signed_up", "signed_in", "applied"]));
    expect(detail.history.find((e: { kind: string }) => e.kind === "applied").job).toMatchObject({ slug, title: "Support Engineer" });
    await http().get("/candidates/00000000-0000-4000-8000-000000000000").set(staff.owner).expect(404);
  });

  it("exports a CSV for email marketing, safe to open in Excel", async () => {
    await signUp("sam@example.com", "=HYPERLINK(\"evil\")").expect(201);
    const csv = await http().get("/candidates/export").set(staff.owner).expect(200);
    expect(csv.headers["content-type"]).toMatch(/^text\/csv/);
    expect(csv.headers["content-disposition"]).toMatch(/^attachment; filename="candidates-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = csv.text.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe("Name,Email,Signed up with,Email confirmed,Signed up,Last sign-in,Sign-ins,Applications,Subscribed to newsletter");
    expect(lines[1]).toMatch(/^"'=HYPERLINK\(""evil""\)",sam@example.com,Email and password,No,/);
    expect(await connection.db.select().from(auditLog)).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "exported", entity: "candidate" })]),
    );
  });

  it("deletes an account and signs them out", async () => {
    const res = await signUp("sam@example.com").expect(201);
    const token = res.body.session.token as string;
    await apply(token).expect(201);
    const [candidate] = await connection.db.select().from(candidates);
    const removed = await http().delete(`/candidates/${candidate.id}`).set(staff.owner).expect(200);
    expect(removed.body.message).toMatch(/deleted/);
    await http().get("/public/candidate/me").set(asCandidate(token)).expect(401);
    expect(await connection.db.select().from(applications)).toEqual([]);
    expect((await http().delete(`/candidates/${candidate.id}`).set(staff.owner).expect(200)).body.message).toBe("Already deleted.");
  });
});
