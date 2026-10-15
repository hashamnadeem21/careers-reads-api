import type { NestExpressApplication } from "@nestjs/platform-express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { GoogleVerifier, type GoogleProfile } from "../src/candidates/google-verifier.service.js";
import { resetEnvCache } from "../src/config/env.js";
import type { DbConnection } from "../src/db/client.js";
import {
  automationDeliveries,
  candidateEvents,
  candidates,
  emailAutomations,
  subscribers,
} from "../src/db/schema.js";
import { MailerService } from "../src/mail/mailer.service.js";
import { SchedulerService } from "../src/scheduler/scheduler.service.js";
import { createTestApp } from "./helpers/app.js";
import { FakeMailer } from "./helpers/fake-mailer.js";
import { asAdminServer, asSiteServer, bearer, createUser, login } from "./helpers/seed.js";
import { connectTestDb, resetTestDb } from "./helpers/test-db.js";

/** Stands in for Google: a credential "google:<email>:<sub>" verifies to that profile; anything else fails. */
class FakeGoogle {
  enabledFlag = true;
  enabled() {
    return this.enabledFlag;
  }
  async verify(credential: string): Promise<GoogleProfile | null> {
    const [kind, email, sub] = credential.split(":");
    if (kind !== "google" || !email || !sub) return null;
    return { sub, email, name: "Gina Google", picture: "https://lh3.googleusercontent.com/a/photo" };
  }
}

let connection: DbConnection;
let app: NestExpressApplication;
const mailer = new FakeMailer();
const google = new FakeGoogle();
const http = () => request(app.getHttpServer());
const site = () => asSiteServer();
const asCandidate = (token: string) => ({ ...asSiteServer(), "x-candidate-session": token });
const run = () => app.get(SchedulerService).run(new Date(Date.now() + 60_000));
const googleCredential = (email: string, sub = `sub-${email}`) => `google:${email}:${sub}`.padEnd(24, "x");

const PASSWORD = "a-good-password-1";

function signUp(email = "sam@example.com", extra: object = {}) {
  return http()
    .post("/public/candidate/auth/signup")
    .set(site())
    .send({ name: "Sam Seeker", email, password: PASSWORD, acceptTerms: true, ...extra });
}

const linkToken = (text: string, path: string) => {
  const match = new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`).exec(text);
  if (!match) throw new Error(`No ${path} link in email`);
  return match[1];
};

const events = async (email: string) => {
  const [candidate] = await connection.db.select().from(candidates).where(eq(candidates.email, email));
  const rows = await connection.db.select().from(candidateEvents).where(eq(candidateEvents.candidateId, candidate.id));
  return rows.map((row) => `${row.kind}${row.method ? `:${row.method}` : ""}`);
};

beforeAll(async () => {
  connection = await connectTestDb();
  process.env.API_PUBLIC_URL = "http://api.test";
  process.env.PUBLIC_SITE_URL = "http://site.test";
  process.env.GOOGLE_CLIENT_ID = "1234-test.apps.googleusercontent.com";
  resetEnvCache();
  app = await createTestApp((m) =>
    m.overrideProvider(MailerService).useValue(mailer).overrideProvider(GoogleVerifier).useValue(google),
  );
});

afterAll(async () => {
  await app.close();
  await connection.end();
  delete process.env.API_PUBLIC_URL;
  delete process.env.PUBLIC_SITE_URL;
  delete process.env.GOOGLE_CLIENT_ID;
  resetEnvCache();
});

beforeEach(async () => {
  await resetTestDb(connection);
  mailer.reset();
  google.enabledFlag = true;
});

describe("create account with email and password", () => {
  it("creates the account, signs in, and the welcome email asks them to confirm their email", async () => {
    const res = await signUp().expect(201);
    expect(res.body.created).toBe(true);
    expect(res.body.session.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(res.body.candidate).toEqual(
      expect.objectContaining({ name: "Sam Seeker", email: "sam@example.com", emailVerified: false, signupMethod: "password", subscribed: false }),
    );

    const me = await http().get("/public/candidate/me").set(asCandidate(res.body.session.token)).expect(200);
    expect(me.body.email).toBe("sam@example.com");

    // The default welcome automation was created (switched on) and queued once.
    const automations = await connection.db.select().from(emailAutomations);
    expect(automations).toEqual([expect.objectContaining({ trigger: "candidate_signed_up", active: true })]);
    await run();
    expect(mailer.sent).toHaveLength(1);
    const welcome = mailer.sent[0];
    expect(welcome.subject).toBe("Welcome to Career Reads, Sam 🎉");
    expect(welcome.html).toContain("Confirm your email");
    expect(welcome.html).not.toContain("Unsubscribe");

    // Confirming works once.
    const token = linkToken(welcome.text, "/account/confirm-email");
    await http().post("/public/candidate/auth/confirm-email").set(site()).send({ token }).expect(200);
    await http().post("/public/candidate/auth/confirm-email").set(site()).send({ token }).expect(400);
    const after = await http().get("/public/candidate/me").set(asCandidate(res.body.session.token)).expect(200);
    expect(after.body.emailVerified).toBe(true);
    expect(await events("sam@example.com")).toEqual(["signed_up:password", "email_confirmed"]);
  });

  it("validates the form and needs the Terms box", async () => {
    const res = await signUp("not-an-email", { password: "short", acceptTerms: false, name: "" }).expect(400);
    expect(res.body.error.fields).toEqual(
      expect.objectContaining({ email: expect.any(String), password: expect.any(String), acceptTerms: expect.any(String), name: expect.any(String) }),
    );
  });

  it("refuses a second account for the same email", async () => {
    await signUp("dup@example.com").expect(201);
    const res = await signUp("DUP@example.com").expect(409);
    expect(res.body.error.code).toBe("account_exists");
  });

  it("attaches to an earlier applicant's record instead of making a second one", async () => {
    await connection.db.insert(candidates).values({ email: "earlier@example.com", name: "Earlier Applicant" });
    await signUp("earlier@example.com").expect(201);
    const rows = await connection.db.select().from(candidates).where(eq(candidates.email, "earlier@example.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ signupMethod: "password", accountCreatedAt: expect.any(Date) }));
  });

  it("sends just the confirmation when the welcome email is switched off", async () => {
    await signUp("first@example.com").expect(201); // creates the default welcome
    await connection.db.update(emailAutomations).set({ active: false });
    mailer.reset();
    await signUp("second@example.com").expect(201);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].subject).toBe("Confirm your email for Career Reads");
    await run();
    expect(mailer.sent).toHaveLength(1);
  });

  it("doesn't bring back a deleted welcome email", async () => {
    await signUp("first@example.com").expect(201);
    await connection.db.delete(emailAutomations);
    await signUp("second@example.com").expect(201);
    expect(await connection.db.select().from(emailAutomations)).toEqual([]);
  });
});

describe("sign in with email and password", () => {
  it("signs in with the right password and gives one message for every failure", async () => {
    await signUp().expect(201);
    const wrong = await http().post("/public/candidate/auth/login").set(site()).send({ email: "sam@example.com", password: "nope-nope-nope" }).expect(401);
    const unknown = await http().post("/public/candidate/auth/login").set(site()).send({ email: "nobody@example.com", password: PASSWORD }).expect(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);

    const ok = await http().post("/public/candidate/auth/login").set(site()).send({ email: "Sam@Example.com", password: PASSWORD }).expect(200);
    expect(ok.body.created).toBe(false);
    expect(await events("sam@example.com")).toEqual(["signed_up:password", "signed_in:password"]);
  });

  it("signs out", async () => {
    const res = await signUp().expect(201);
    const token = res.body.session.token as string;
    await http().post("/public/candidate/auth/logout").set(asCandidate(token)).expect(204);
    await http().get("/public/candidate/me").set(asCandidate(token)).expect(401);
  });
});

describe("continue with Google", () => {
  it("creates a confirmed account and a welcome email without a confirm button", async () => {
    const res = await http().post("/public/candidate/auth/google").set(site()).send({ credential: googleCredential("gina@example.com") }).expect(201);
    expect(res.body.created).toBe(true);
    expect(res.body.candidate).toEqual(expect.objectContaining({ email: "gina@example.com", emailVerified: true, signupMethod: "google", hasPassword: false }));
    await run();
    expect(mailer.sent.map((m) => `${m.to}: ${m.subject}`)).toEqual(["gina@example.com: Welcome to Career Reads, Gina 🎉"]);
    expect(mailer.sent[0].html).not.toContain("Confirm your email");
    expect(mailer.sent[0].html).toContain("Find your next job");

    // Signing in again is not a new account and sends nothing.
    mailer.reset();
    const again = await http().post("/public/candidate/auth/google").set(site()).send({ credential: googleCredential("gina@example.com") }).expect(201);
    expect(again.body.created).toBe(false);
    await run();
    expect(mailer.sent).toHaveLength(0);
    expect(await events("gina@example.com")).toEqual(["signed_up:google", "signed_in:google"]);
  });

  it("takes over an unconfirmed password account with the same email: its password and sessions end", async () => {
    const squatter = await signUp("owner@example.com").expect(201);
    await http().post("/public/candidate/auth/google").set(site()).send({ credential: googleCredential("owner@example.com") }).expect(201);
    await http().get("/public/candidate/me").set(asCandidate(squatter.body.session.token)).expect(401);
    await http().post("/public/candidate/auth/login").set(site()).send({ email: "owner@example.com", password: PASSWORD }).expect(401);
  });

  it("keeps the password of a confirmed account it links to", async () => {
    const res = await signUp("both@example.com").expect(201);
    await connection.db.update(candidates).set({ emailVerifiedAt: new Date() }).where(eq(candidates.email, "both@example.com"));
    await http().post("/public/candidate/auth/google").set(site()).send({ credential: googleCredential("both@example.com") }).expect(201);
    await http().get("/public/candidate/me").set(asCandidate(res.body.session.token)).expect(200);
    await http().post("/public/candidate/auth/login").set(site()).send({ email: "both@example.com", password: PASSWORD }).expect(200);
  });

  it("rejects a bad token, and says when Google sign-in is off", async () => {
    const bad = await http().post("/public/candidate/auth/google").set(site()).send({ credential: "not-a-real-google-token" }).expect(401);
    expect(bad.body.error.code).toBe("invalid_google_token");
    google.enabledFlag = false;
    const off = await http().post("/public/candidate/auth/google").set(site()).send({ credential: googleCredential("x@example.com") }).expect(503);
    expect(off.body.error.code).toBe("google_disabled");
  });
});

describe("forgot and reset password", () => {
  it("emails a one-time link that sets a new password, ends other sessions and signs in", async () => {
    const old = await signUp().expect(201);
    mailer.reset();
    await http().post("/public/candidate/auth/forgot-password").set(site()).send({ email: "sam@example.com" }).expect(204);
    expect(mailer.sent).toHaveLength(1);
    const token = linkToken(mailer.sent[0].text, "/account/reset-password");

    const reset = await http().post("/public/candidate/auth/reset-password").set(site()).send({ token, password: "a-brand-new-pass-2" }).expect(200);
    expect(reset.body.candidate.emailVerified).toBe(true); // opening the link proves the inbox
    await http().get("/public/candidate/me").set(asCandidate(old.body.session.token)).expect(401);
    await http().get("/public/candidate/me").set(asCandidate(reset.body.session.token)).expect(200);
    await http().post("/public/candidate/auth/reset-password").set(site()).send({ token, password: "another-pass-3333" }).expect(400);
    await http().post("/public/candidate/auth/login").set(site()).send({ email: "sam@example.com", password: "a-brand-new-pass-2" }).expect(200);
  });

  it("answers the same for unknown emails and sends nothing", async () => {
    await http().post("/public/candidate/auth/forgot-password").set(site()).send({ email: "nobody@example.com" }).expect(204);
    expect(mailer.sent).toHaveLength(0);
  });
});

describe("subscribe after applying", () => {
  it("adds their email to the newsletter list without sending the subscriber welcome", async () => {
    const owner = await createUser(connection.db, { role: "super_admin", email: "owner@example.com" });
    const staff = bearer((await login(app, owner.email)).accessToken);
    const created = await http()
      .post("/automations")
      .set({ ...asAdminServer(), ...staff })
      .send({ name: "Subscriber welcome", subject: "Thanks for subscribing", previewText: "", body: "Hello" })
      .expect(201);
    await http().post(`/automations/${created.body.automation.id}/status`).set({ ...asAdminServer(), ...staff }).send({ active: true }).expect(200);

    const res = await http().post("/public/candidate/auth/google").set(site()).send({ credential: googleCredential("gina@example.com") }).expect(201);
    const token = res.body.session.token as string;
    await http().post("/public/candidate/subscribe").set(asCandidate(token)).expect(200);
    await http().post("/public/candidate/subscribe").set(asCandidate(token)).expect(200);

    expect(await connection.db.select().from(subscribers)).toEqual([expect.objectContaining({ email: "gina@example.com", unsubscribedAt: null })]);
    const deliveries = await connection.db.select().from(automationDeliveries);
    expect(deliveries.filter((d) => d.subscriberId !== null)).toEqual([]);
    expect((await http().get("/public/candidate/me").set(asCandidate(token)).expect(200)).body.subscribed).toBe(true);
    expect(await events("gina@example.com")).toEqual(["signed_up:google", "subscribed"]);
  });
});

describe("keeping candidates and staff apart", () => {
  it("only the website may call these, and candidate tokens don't open the admin", async () => {
    await http().post("/public/candidate/auth/signup").send({ name: "Sam", email: "s@example.com", password: PASSWORD, acceptTerms: true }).expect(403);

    const res = await signUp().expect(201);
    const token = res.body.session.token as string;
    await http().get("/automations").set({ ...asAdminServer(), ...bearer(token) }).expect(401);
    await http().get("/auth/me").set({ ...asAdminServer(), ...bearer(token) }).expect(401);

    const staff = await createUser(connection.db, { role: "super_admin", email: "boss@example.com" });
    const staffToken = (await login(app, staff.email)).accessToken;
    await http().get("/public/candidate/me").set(asCandidate(staffToken)).expect(401);
  });
});
