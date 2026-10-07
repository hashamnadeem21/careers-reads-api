import type { NestExpressApplication } from "@nestjs/platform-express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { hashToken } from "../src/auth/sessions.service.js";
import type { DbConnection } from "../src/db/client.js";
import { sessions } from "../src/db/schema.js";
import { createTestApp } from "./helpers/app.js";
import { asAdminServer, bearer, createCompany, createUser, login, PASSWORD } from "./helpers/seed.js";
import { connectTestDb, resetTestDb } from "./helpers/test-db.js";

let connection: DbConnection;
let app: NestExpressApplication;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  connection = await connectTestDb();
  await resetTestDb(connection);
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await connection.end();
});

/** The refresh token's session row id (sha256 of its jti), for simulating time passing. */
function sessionIdOf(refreshToken: string): string {
  const payload = JSON.parse(Buffer.from(refreshToken.split(".")[1], "base64url").toString()) as { jti: string };
  return hashToken(payload.jti);
}

describe("login", () => {
  it("signs in with the right password and returns tokens and the user", async () => {
    const user = await createUser(connection.db, { role: "editor" });
    const res = await http()
      .post("/auth/login")
      .set(asAdminServer())
      .send({ email: user.email.toUpperCase(), password: PASSWORD })
      .expect(200);
    expect(res.body).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      user: { id: user.id, role: "editor", theme: "system", mustChangePassword: false },
    });
    expect(res.body.user.sessionId).toBeUndefined();
    const me = await http().get("/auth/me").set(bearer(res.body.accessToken)).expect(200);
    expect(me.body.user.email).toBe(user.email);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const user = await createUser(connection.db);
    const wrong = await http()
      .post("/auth/login")
      .set(asAdminServer())
      .send({ email: user.email, password: "nope" })
      .expect(401);
    const unknown = await http()
      .post("/auth/login")
      .set(asAdminServer())
      .send({ email: "nobody@example.com", password: "nope" })
      .expect(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe("invalid_credentials");
  });

  it("validates input with field errors", async () => {
    const res = await http().post("/auth/login").send({ email: "not-an-email", password: "" }).expect(400);
    expect(res.body.error.fields).toEqual({ email: expect.any(String), password: expect.any(String) });
  });

  it("rate-limits per account after 10 attempts in 15 minutes", async () => {
    const user = await createUser(connection.db);
    for (let i = 0; i < 10; i++) {
      await http().post("/auth/login").set(asAdminServer()).send({ email: user.email, password: "wrong" }).expect(401);
    }
    const res = await http()
      .post("/auth/login")
      .set(asAdminServer())
      .send({ email: user.email, password: PASSWORD })
      .expect(429);
    expect(res.body.error.code).toBe("rate_limited");
  });

  it("rate-limits per visitor IP, and only trusts X-Client-IP from our own servers", async () => {
    const ip = asAdminServer("203.0.113.99");
    for (let i = 0; i < 10; i++) {
      await http()
        .post("/auth/login")
        .set(ip)
        .send({ email: `x${i}@example.com`, password: "wrong" })
        .expect(401);
    }
    await http().post("/auth/login").set(ip).send({ email: "y@example.com", password: "wrong" }).expect(429);
    // A visitor can't dodge or spoof the limit by sending the header without the server key.
    const spoofed = await http()
      .post("/auth/login")
      .set({ "x-client-ip": "203.0.113.99" })
      .send({ email: "z@example.com", password: "wrong" });
    expect(spoofed.status).toBe(401);
  });

  it("refuses a paused company's accounts", async () => {
    const company = await createCompany(connection.db, { active: false });
    const user = await createUser(connection.db, { role: "company", companyId: company.id });
    const res = await http()
      .post("/auth/login")
      .set(asAdminServer())
      .send({ email: user.email, password: PASSWORD })
      .expect(403);
    expect(res.body.error.code).toBe("company_paused");
  });
});

describe("tokens", () => {
  it("rejects missing, malformed and refresh tokens used as access tokens", async () => {
    await http().get("/auth/me").expect(401);
    await http().get("/auth/me").set(bearer("garbage")).expect(401);
    const user = await createUser(connection.db);
    const { refreshToken } = await login(app, user.email);
    await http().get("/auth/me").set(bearer(refreshToken)).expect(401);
  });

  it("rotates refresh tokens, keeping the old one valid for a short grace period", async () => {
    const user = await createUser(connection.db);
    const first = await login(app, user.email);
    const second = await http().post("/auth/refresh").send({ refreshToken: first.refreshToken }).expect(200);
    expect(second.body.refreshToken).not.toBe(first.refreshToken);
    await http().get("/auth/me").set(bearer(second.body.accessToken)).expect(200);
    // A parallel request with the old token inside the grace window still works.
    await http().post("/auth/refresh").send({ refreshToken: first.refreshToken }).expect(200);
  });

  it("treats reuse of a rotated refresh token after the grace period as theft and signs out everywhere", async () => {
    const user = await createUser(connection.db);
    const first = await login(app, user.email);
    const second = await http().post("/auth/refresh").send({ refreshToken: first.refreshToken }).expect(200);
    // Grace period over.
    await connection.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, sessionIdOf(first.refreshToken)));

    const reused = await http().post("/auth/refresh").send({ refreshToken: first.refreshToken }).expect(401);
    expect(reused.body.error.code).toBe("invalid_refresh_token");
    await http().get("/auth/me").set(bearer(second.body.accessToken)).expect(401);
    await http().post("/auth/refresh").send({ refreshToken: second.body.refreshToken }).expect(401);
  });

  it("logout ends that session immediately", async () => {
    const user = await createUser(connection.db);
    const session = await login(app, user.email);
    await http().post("/auth/logout").send({ refreshToken: session.refreshToken }).expect(204);
    await http().get("/auth/me").set(bearer(session.accessToken)).expect(401);
    await http().post("/auth/logout").send({ refreshToken: "unknown" }).expect(204);
  });
});

describe("roles and account state", () => {
  it("applies a role change on the very next request", async () => {
    const admin = await createUser(connection.db, { role: "super_admin" });
    const editor = await createUser(connection.db, { role: "editor" });
    const adminSession = await login(app, admin.email);
    const editorSession = await login(app, editor.email);

    await http().get("/users").set(bearer(editorSession.accessToken)).expect(403);
    await http()
      .patch(`/users/${editor.id}/role`)
      .set(bearer(adminSession.accessToken))
      .send({ role: "super_admin" })
      .expect(200);
    await http().get("/users").set(bearer(editorSession.accessToken)).expect(200);
  });

  it("locks out a company's accounts the moment it is paused", async () => {
    const admin = await createUser(connection.db, { role: "super_admin" });
    const company = await createCompany(connection.db);
    const member = await createUser(connection.db, { role: "company", companyId: company.id });
    const adminSession = await login(app, admin.email);
    const memberSession = await login(app, member.email);

    await http().get(`/companies/${company.id}/dashboard`).set(bearer(memberSession.accessToken)).expect(200);
    await http()
      .post(`/companies/${company.id}/active`)
      .set(bearer(adminSession.accessToken))
      .send({ active: false })
      .expect(200);
    await http().get("/auth/me").set(bearer(memberSession.accessToken)).expect(401);
    await http().post("/auth/refresh").send({ refreshToken: memberSession.refreshToken }).expect(401);
  });

  it("only lets a company account see its own company's dashboard", async () => {
    const mine = await createCompany(connection.db);
    const theirs = await createCompany(connection.db);
    const member = await createUser(connection.db, { role: "company", companyId: mine.id });
    const session = await login(app, member.email);
    await http().get(`/companies/${theirs.id}/dashboard`).set(bearer(session.accessToken)).expect(403);
    await http().get(`/companies/${mine.id}`).set(bearer(session.accessToken)).expect(403);
  });

  it("blocks everything but me/change-password/logout until a temporary password is replaced", async () => {
    const admin = await createUser(connection.db, { role: "super_admin", mustChangePassword: true });
    const session = await login(app, admin.email);
    const blocked = await http().get("/users").set(bearer(session.accessToken)).expect(403);
    expect(blocked.body.error.code).toBe("password_change_required");
    await http().get("/auth/me").set(bearer(session.accessToken)).expect(200);

    const changed = await http()
      .post("/auth/change-password")
      .set(bearer(session.accessToken))
      .send({ current: PASSWORD, next: "a-brand-new-password-9", confirm: "a-brand-new-password-9" })
      .expect(200);
    expect(changed.body.user.mustChangePassword).toBe(false);
    await http().get("/users").set(bearer(changed.body.accessToken)).expect(200);
  });

  it("changing the password signs out every other device", async () => {
    const user = await createUser(connection.db);
    const laptop = await login(app, user.email);
    const phone = await login(app, user.email);

    const wrong = await http()
      .post("/auth/change-password")
      .set(bearer(laptop.accessToken))
      .send({ current: "not-it", next: "another-password-42", confirm: "another-password-42" })
      .expect(400);
    expect(wrong.body.error.fields).toEqual({ current: expect.any(String) });

    const changed = await http()
      .post("/auth/change-password")
      .set(bearer(laptop.accessToken))
      .send({ current: PASSWORD, next: "another-password-42", confirm: "another-password-42" })
      .expect(200);
    await http().get("/auth/me").set(bearer(phone.accessToken)).expect(401);
    await http().get("/auth/me").set(bearer(laptop.accessToken)).expect(401);
    await http().get("/auth/me").set(bearer(changed.body.accessToken)).expect(200);
    await login(app, user.email, "another-password-42");
  });
});
