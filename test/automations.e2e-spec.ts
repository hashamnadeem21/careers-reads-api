import type { NestExpressApplication } from "@nestjs/platform-express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { resetEnvCache } from "../src/config/env.js";
import type { DbConnection } from "../src/db/client.js";
import { AutomationSender } from "../src/automations/automation-sender.service.js";
import { automationDeliveries, subscribers } from "../src/db/schema.js";
import { MailerService } from "../src/mail/mailer.service.js";
import { SchedulerService } from "../src/scheduler/scheduler.service.js";
import { createTestApp } from "./helpers/app.js";
import { FakeMailer } from "./helpers/fake-mailer.js";
import { asAdminServer, asSiteServer, bearer, createUser, login } from "./helpers/seed.js";
import { connectTestDb, resetTestDb } from "./helpers/test-db.js";

let connection: DbConnection;
let app: NestExpressApplication;
const mailer = new FakeMailer();
const http = () => request(app.getHttpServer());
let owner: Record<string, string>;
let editor: Record<string, string>;

const as = (headers: Record<string, string>) => ({ ...asAdminServer(), ...headers });
const minutes = (n: number) => new Date(Date.now() + n * 60_000);
const run = (at = minutes(1)) => app.get(SchedulerService).run(at);

const welcome = {
  name: "Welcome email",
  subject: "Welcome to Career Reads",
  previewText: "Thanks for subscribing",
  body: "## Welcome!\n\nGlad you're here.",
};

async function subscribe(email: string) {
  await http().post("/public/subscribe").set(asSiteServer()).send({ email }).expect(204);
}

async function automation(input: object = {}, active = true) {
  const res = await http().post("/automations").set(as(editor)).send({ ...welcome, ...input }).expect(201);
  const id = res.body.automation.id as number;
  if (active) await http().post(`/automations/${id}/status`).set(as(owner)).send({ active: true }).expect(200);
  return id;
}

const deliveries = () => connection.db.select().from(automationDeliveries);

beforeAll(async () => {
  connection = await connectTestDb();
  process.env.API_PUBLIC_URL = "http://api.test";
  resetEnvCache();
  await resetTestDb(connection);
  app = await createTestApp((m) => m.overrideProvider(MailerService).useValue(mailer));
});

afterAll(async () => {
  await app.close();
  await connection.end();
  delete process.env.API_PUBLIC_URL;
  resetEnvCache();
});

beforeEach(async () => {
  await resetTestDb(connection);
  const superAdmin = await createUser(connection.db, { role: "super_admin", email: "owner@example.com" });
  const staff = await createUser(connection.db, { role: "editor" });
  owner = bearer((await login(app, superAdmin.email)).accessToken);
  editor = bearer((await login(app, staff.email)).accessToken);
  mailer.reset();
});

describe("managing automations", () => {
  it("lets staff write automations, which start switched off", async () => {
    const id = await automation({ delayMinutes: 60 * 24 }, false);
    const list = await http().get("/automations").set(as(editor)).expect(200);
    expect(list.body.sendingReady).toBe(true);
    expect(list.body.items).toEqual([
      expect.objectContaining({ id, name: "Welcome email", trigger: "subscribed", delayMinutes: 1440, active: false }),
    ]);
    expect(list.body.items[0].body).toBeUndefined();
    expect(list.body.items[0].stats).toEqual({ pending: 0, sent: 0, failed: 0, skipped: 0 });

    await http().patch(`/automations/${id}`).set(as(editor)).send({ ...welcome, subject: "Hello!" }).expect(200);
    const one = await http().get(`/automations/${id}`).set(as(editor)).expect(200);
    expect(one.body.automation).toMatchObject({ subject: "Hello!", body: welcome.body });
  });

  it("validates the form", async () => {
    const res = await http()
      .post("/automations")
      .set(as(editor))
      .send({ ...welcome, name: "", delayMinutes: -1, startsAt: "2026-05-01T00:00:00Z", endsAt: "2026-04-01T00:00:00Z" })
      .expect(400);
    expect(res.body.error.fields).toMatchObject({
      name: "Give it a name",
      delayMinutes: "The delay can't be negative",
    });
  });

  it("only lets super admins switch them on, and only when ready", async () => {
    const id = await automation({}, false);
    await http().post(`/automations/${id}/status`).set(as(editor)).send({ active: true }).expect(403);
    const empty = await automation({ body: " " }, false);
    const res = await http().post(`/automations/${empty}/status`).set(as(owner)).send({ active: true }).expect(400);
    expect(res.body.error.fields.body).toBe("Write the email first");
    mailer.configured = false;
    const off = await http().post(`/automations/${id}/status`).set(as(owner)).send({ active: true }).expect(503);
    expect(off.body.error.code).toBe("email_not_configured");
  });

  it("sends a test copy", async () => {
    const id = await automation({}, false);
    await http().post(`/automations/${id}/test`).set(as(editor)).send({ email: "me@example.com" }).expect(200);
    expect(mailer.sent).toEqual([expect.objectContaining({ to: "me@example.com", subject: "[Test] Welcome to Career Reads" })]);
  });

  it("deletes automations and their queue", async () => {
    const id = await automation();
    await subscribe("a@example.com");
    await http().delete(`/automations/${id}`).set(as(editor)).expect(204);
    await http().get(`/automations/${id}`).set(as(editor)).expect(404);
    expect(await deliveries()).toHaveLength(0);
  });
});

describe("the welcome email", () => {
  it("is sent automatically to a new subscriber, once", async () => {
    await automation();
    await subscribe("new@example.com");
    expect(await deliveries()).toEqual([expect.objectContaining({ status: "pending" })]);

    const summary = await run();
    expect(summary).toMatchObject({ sent: 1, failed: 0, skipped: 0 });
    const [row] = await connection.db.select().from(subscribers).where(eq(subscribers.email, "new@example.com"));
    expect(mailer.sent).toEqual([
      expect.objectContaining({
        to: "new@example.com",
        subject: "Welcome to Career Reads",
        headers: expect.objectContaining({ "List-Unsubscribe": `<http://api.test/public/unsubscribe/${row.unsubscribeToken}>` }),
      }),
    ]);

    // Signing up again, or another run, never sends it twice.
    await subscribe("new@example.com");
    await run(minutes(2));
    expect(mailer.sent).toHaveLength(1);

    const report = await http().get("/automations").set(as(owner)).expect(200);
    expect(report.body.items[0].stats).toMatchObject({ sent: 1, pending: 0 });
  });

  it("doesn't go to people who subscribed before it was switched on", async () => {
    await subscribe("early@example.com");
    await automation();
    await run();
    expect(mailer.sent).toHaveLength(0);
  });

  it("waits for its delay", async () => {
    await automation({ delayMinutes: 60 * 24 * 3 });
    await subscribe("a@example.com");
    await run(minutes(60 * 24));
    expect(mailer.sent).toHaveLength(0);
    await run(minutes(60 * 24 * 3 + 1));
    expect(mailer.sent).toHaveLength(1);
  });

  it("respects the launch and end dates", async () => {
    await automation({ startsAt: minutes(60).toISOString() });
    await subscribe("before-launch@example.com");
    expect(await deliveries()).toHaveLength(0);

    await resetTestDb(connection);
    const superAdmin = await createUser(connection.db, { role: "super_admin", email: "owner@example.com" });
    owner = bearer((await login(app, superAdmin.email)).accessToken);
    const staff = await createUser(connection.db, { role: "editor" });
    editor = bearer((await login(app, staff.email)).accessToken);
    await automation({ startsAt: minutes(-60).toISOString(), endsAt: minutes(-1).toISOString() });
    await subscribe("after-end@example.com");
    expect(await deliveries()).toHaveLength(0);
  });

  it("skips people who unsubscribed and everything once it's switched off", async () => {
    const id = await automation({ delayMinutes: 60 });
    await subscribe("gone@example.com");
    await subscribe("waiting@example.com");
    await connection.db.update(subscribers).set({ unsubscribedAt: new Date() }).where(eq(subscribers.email, "gone@example.com"));
    expect(await run(minutes(61))).toMatchObject({ sent: 1, skipped: 1 });

    await subscribe("later@example.com");
    await http().post(`/automations/${id}/status`).set(as(owner)).send({ active: false }).expect(200);
    await run(minutes(200));
    expect(mailer.sent.map((m) => m.to)).toEqual(["waiting@example.com"]);
    const statuses = (await deliveries()).map((d) => d.status).sort();
    expect(statuses).toEqual(["sent", "skipped", "skipped"]);
  });

  it("skips emails that are days late instead of sending them", async () => {
    await automation();
    await subscribe("a@example.com");
    expect(await run(minutes(60 * 24 * 4))).toMatchObject({ sent: 0, skipped: 1 });
  });

  it("retries failures 15 minutes apart, 3 tries in total, then lets you retry by hand", async () => {
    const id = await automation();
    await subscribe("a@example.com");
    mailer.failWith = "Domain not verified";
    expect(await run(minutes(1))).toMatchObject({ retrying: 1 });
    expect(await run(minutes(5))).toMatchObject({ retrying: 0, failed: 0 }); // not due again yet
    expect(await run(minutes(17))).toMatchObject({ retrying: 1 });
    expect(await run(minutes(33))).toMatchObject({ failed: 1 });
    expect(await run(minutes(50))).toMatchObject({ failed: 0, retrying: 0 });

    const report = await http().get(`/automations/${id}`).set(as(owner)).expect(200);
    expect(report.body.stats.failed).toBe(1);
    expect(report.body.failures).toEqual([{ error: "Domain not verified", count: 1 }]);
    expect(report.body.recent).toEqual([expect.objectContaining({ email: "a@example.com", status: "failed" })]);

    mailer.failWith = null;
    await http().post(`/automations/${id}/retry`).set(as(editor)).expect(403);
    await http().post(`/automations/${id}/retry`).set(as(owner)).expect(202);
    expect(await run(new Date(Date.now() + 60_000))).toMatchObject({ sent: 1 });
  });

  it("still delivers the rest of a batch when one address is bad", async () => {
    await automation();
    await subscribe("good@example.com");
    await subscribe("bad@example.com");
    await subscribe("fine@example.com");
    mailer.badAddress = "bad@example.com";
    expect(await run()).toMatchObject({ sent: 2, retrying: 1 });
    expect(mailer.sent.map((m) => m.to).sort()).toEqual(["fine@example.com", "good@example.com"]);
  });

  it("never sends twice when runs overlap, in one process or across API instances", async () => {
    await automation();
    for (const n of [1, 2, 3, 4, 5]) await subscribe(`p${n}@example.com`);
    const at = minutes(1);
    const scheduler = app.get(SchedulerService);
    // Same process: the second call shares the run in flight.
    await Promise.all([scheduler.run(at), scheduler.run(at)]);
    expect(mailer.sent).toHaveLength(5);

    // Separate senders racing on the same rows (what two API instances do): rows are claimed once.
    for (const n of [6, 7, 8, 9]) await subscribe(`p${n}@example.com`);
    const sender = app.get(AutomationSender);
    const results = await Promise.all([sender.sendDue(at), sender.sendDue(at), sender.sendDue(at)]);
    expect(results.reduce((total, r) => total + r.sent, 0)).toBe(4);
    expect(mailer.sent).toHaveLength(9);
    expect(new Set(mailer.sent.map((m) => m.to)).size).toBe(9);
  });

  it("does nothing while email sending isn't set up", async () => {
    await automation();
    await subscribe("a@example.com");
    mailer.configured = false;
    expect(await run()).toMatchObject({ sent: 0 });
    expect((await deliveries())[0].status).toBe("pending");
  });
});
