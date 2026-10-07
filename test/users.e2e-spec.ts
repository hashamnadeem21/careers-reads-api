import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import type { DbConnection } from "../src/db/client.js";
import { createTestApp } from "./helpers/app.js";
import { bearer, createCompany, createUser, login } from "./helpers/seed.js";
import { connectTestDb, resetTestDb } from "./helpers/test-db.js";

let connection: DbConnection;
let app: NestExpressApplication;
let adminToken: string;
let adminId: string;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  connection = await connectTestDb();
  await resetTestDb(connection);
  app = await createTestApp();
  const admin = await createUser(connection.db, { role: "super_admin", name: "Owner" });
  adminId = admin.id;
  adminToken = (await login(app, admin.email)).accessToken;
});

afterAll(async () => {
  await app.close();
  await connection.end();
});

const tokenFromLink = (link: string) => link.split("/invite/")[1];

describe("invites", () => {
  it("invites a staff member who then joins and is signed in", async () => {
    const created = await http()
      .post("/invites")
      .set(bearer(adminToken))
      .send({ email: "New.Editor@Example.com", name: "New Editor", role: "editor" })
      .expect(201);
    expect(created.body.link).toMatch(/^http:\/\/localhost:3001\/invite\/[\w-]+$/);
    const token = tokenFromLink(created.body.link);

    const lookup = await http().get(`/invites/${token}`).expect(200);
    expect(lookup.body.invite).toEqual({
      email: "new.editor@example.com",
      name: "New Editor",
      role: "editor",
      companyName: null,
    });

    const list = await http().get("/users").set(bearer(adminToken)).expect(200);
    expect(list.body.invites.map((i: { email: string }) => i.email)).toContain("new.editor@example.com");

    const mismatch = await http()
      .post(`/invites/${token}/accept`)
      .send({ name: "New Editor", password: "long-enough-pass-1", confirm: "different-pass-1" })
      .expect(400);
    expect(mismatch.body.error.fields).toEqual({ confirm: expect.any(String) });

    const joined = await http()
      .post(`/invites/${token}/accept`)
      .send({ name: "New Editor", password: "long-enough-pass-1", confirm: "long-enough-pass-1" })
      .expect(200);
    expect(joined.body.user).toMatchObject({ email: "new.editor@example.com", role: "editor" });
    await http().get("/auth/me").set(bearer(joined.body.accessToken)).expect(200);

    // One-time.
    await http().get(`/invites/${token}`).expect(404);
    await http()
      .post(`/invites/${token}/accept`)
      .send({ name: "New Editor", password: "long-enough-pass-1", confirm: "long-enough-pass-1" })
      .expect(404);
  });

  it("won't invite someone who already has an account", async () => {
    const existing = await createUser(connection.db);
    const res = await http()
      .post("/invites")
      .set(bearer(adminToken))
      .send({ email: existing.email, name: "Again", role: "editor" })
      .expect(409);
    expect(res.body.error.fields).toEqual({ email: expect.any(String) });
  });

  it("revokes an invite", async () => {
    const created = await http()
      .post("/invites")
      .set(bearer(adminToken))
      .send({ email: "revoke@example.com", name: "Revoke Me", role: "editor" })
      .expect(201);
    await http().delete("/invites").query({ email: "revoke@example.com" }).set(bearer(adminToken)).expect(204);
    await http()
      .get(`/invites/${tokenFromLink(created.body.link)}`)
      .expect(404);
  });

  it("only super admins can invite", async () => {
    const editor = await createUser(connection.db, { role: "editor" });
    const { accessToken } = await login(app, editor.email);
    await http()
      .post("/invites")
      .set(bearer(accessToken))
      .send({ email: "x@example.com", name: "X Y", role: "editor" })
      .expect(403);
  });

  it("invites company people from the company, and refuses while the company is paused", async () => {
    const company = await createCompany(connection.db, { name: "Acme" });
    const created = await http()
      .post(`/companies/${company.id}/invites`)
      .set(bearer(adminToken))
      .send({ email: "hire@acme.test", name: "Acme Hiring" })
      .expect(201);
    const lookup = await http()
      .get(`/invites/${tokenFromLink(created.body.link)}`)
      .expect(200);
    expect(lookup.body.invite).toMatchObject({ role: "company", companyName: "Acme" });

    const people = await http().get(`/companies/${company.id}/people`).set(bearer(adminToken)).expect(200);
    expect(people.body.invites).toHaveLength(1);

    await http().post(`/companies/${company.id}/active`).set(bearer(adminToken)).send({ active: false }).expect(200);
    await http()
      .post(`/invites/${tokenFromLink(created.body.link)}/accept`)
      .send({ name: "Acme Hiring", password: "long-enough-pass-1", confirm: "long-enough-pass-1" })
      .expect(403);
    await http()
      .post(`/companies/${company.id}/invites`)
      .set(bearer(adminToken))
      .send({ email: "two@acme.test", name: "Second Person" })
      .expect(409);
  });
});

describe("users", () => {
  it("never demotes or removes the last super admin, and never removes yourself", async () => {
    const res = await http().patch(`/users/${adminId}/role`).set(bearer(adminToken)).send({ role: "editor" });
    // Other tests may have promoted people; make sure the rule holds when this is the last one.
    if (res.status === 200) throw new Error("expected the only super admin to stay");
    expect(res.body.error.code).toBe("last_super_admin");
    const self = await http().delete(`/users/${adminId}`).set(bearer(adminToken)).expect(400);
    expect(self.body.error.code).toBe("remove_self");
  });

  it("removing a user signs them out", async () => {
    const editor = await createUser(connection.db);
    const session = await login(app, editor.email);
    await http().delete(`/users/${editor.id}`).set(bearer(adminToken)).expect(200);
    await http().get("/auth/me").set(bearer(session.accessToken)).expect(401);
    await http().delete(`/users/${editor.id}`).set(bearer(adminToken)).expect(404);
  });

  it("lists staff only, marking you", async () => {
    const company = await createCompany(connection.db);
    await createUser(connection.db, { role: "company", companyId: company.id });
    const res = await http().get("/users").set(bearer(adminToken)).expect(200);
    expect(res.body.members.every((m: { role: string }) => m.role !== "company")).toBe(true);
    expect(res.body.members.find((m: { id: string }) => m.id === adminId).isYou).toBe(true);
  });

  it("rejects malformed ids with a 400", async () => {
    await http().delete("/users/not-a-uuid").set(bearer(adminToken)).expect(400);
  });
});

describe("companies", () => {
  it("creates, renames (updating its jobs), and rejects duplicate names", async () => {
    const created = await http()
      .post("/companies")
      .set(bearer(adminToken))
      .send({ name: "Globex", website: "", autoPublish: true })
      .expect(201);
    expect(created.body).toMatchObject({ name: "Globex", website: null, autoPublish: true, active: true });

    const dup = await http().post("/companies").set(bearer(adminToken)).send({ name: "Globex" }).expect(409);
    expect(dup.body.error.fields).toEqual({ name: expect.any(String) });

    const renamed = await http()
      .patch(`/companies/${created.body.id}`)
      .set(bearer(adminToken))
      .send({ name: "Globex Corp", website: "https://globex.test", autoPublish: false })
      .expect(200);
    expect(renamed.body).toMatchObject({ name: "Globex Corp", website: "https://globex.test" });

    const list = await http().get("/companies").set(bearer(adminToken)).expect(200);
    expect(list.body.find((c: { id: string }) => c.id === created.body.id)).toMatchObject({ members: 0, jobsTotal: 0 });

    const dashboard = await http().get(`/companies/${created.body.id}/dashboard`).set(bearer(adminToken)).expect(200);
    expect(dashboard.body.traffic.points).toHaveLength(365);

    await http().delete(`/companies/${created.body.id}`).set(bearer(adminToken)).expect(204);
    await http().get(`/companies/${created.body.id}`).set(bearer(adminToken)).expect(404);
  });

  it("lets editors read company options but not manage companies", async () => {
    const editor = await createUser(connection.db);
    const { accessToken } = await login(app, editor.email);
    await http().get("/companies/options").set(bearer(accessToken)).expect(200);
    await http().get("/companies").set(bearer(accessToken)).expect(403);
    await http().post("/companies").set(bearer(accessToken)).send({ name: "Nope Inc" }).expect(403);
  });
});
