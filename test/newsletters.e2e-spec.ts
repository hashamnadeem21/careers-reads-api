import type { NestExpressApplication } from "@nestjs/platform-express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { resetEnvCache } from "../src/config/env.js";
import type { DbConnection } from "../src/db/client.js";
import { subscribers } from "../src/db/schema.js";
import { MailerService } from "../src/mail/mailer.service.js";
import { NewsletterSender } from "../src/newsletters/newsletter-sender.service.js";
import { SchedulerService } from "../src/scheduler/scheduler.service.js";
import { createTestApp } from "./helpers/app.js";
import { FakeMailer } from "./helpers/fake-mailer.js";
import { asAdminServer, asSiteServer, bearer, createCompany, createUser, login } from "./helpers/seed.js";
import { connectTestDb, resetTestDb } from "./helpers/test-db.js";

let connection: DbConnection;
let app: NestExpressApplication;
const mailer = new FakeMailer();
const http = () => request(app.getHttpServer());
let owner: Record<string, string>;
let editor: Record<string, string>;

const as = (headers: Record<string, string>) => ({ ...asAdminServer(), ...headers });

async function subscribe(email: string) {
  await http().post("/public/subscribe").set(asSiteServer()).send({ email }).expect(204);
}

async function draft(headers = owner, body = "## This week\n\nThree new remote jobs.") {
  const res = await http().post("/newsletters").set(as(headers)).send({ subject: "Weekly picks", previewText: "Jobs and guides", body }).expect(201);
  return res.body.newsletter.id as number;
}

async function sendAndWait(id: number) {
  const res = await http().post(`/newsletters/${id}/send`).set(as(owner)).expect(202);
  await app.get(NewsletterSender).settled(id);
  return res;
}

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

describe("drafts", () => {
  it("lets staff write, edit and list newsletters", async () => {
    const id = await draft(editor);
    await http().patch(`/newsletters/${id}`).set(as(editor)).send({ subject: "Weekly picks #2", body: "Updated" }).expect(200);
    const list = await http().get("/newsletters").set(as(editor)).expect(200);
    expect(list.body).toMatchObject({ activeSubscribers: 0, sendingReady: true });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id, subject: "Weekly picks #2", status: "draft" });
    expect(list.body.items[0].body).toBeUndefined();
    const one = await http().get(`/newsletters/${id}`).set(as(editor)).expect(200);
    expect(one.body.newsletter.body).toBe("Updated");
  });

  it("requires a subject", async () => {
    const res = await http().post("/newsletters").set(as(owner)).send({ subject: " ", body: "x" }).expect(400);
    expect(res.body.error.fields.subject).toBe("Add a subject");
  });

  it("previews unsaved edits as the email", async () => {
    const res = await http().post("/newsletters/preview").set(as(editor)).send({ subject: "Hi", body: "**Bold** news" }).expect(200);
    expect(res.body.html).toContain("<strong>Bold</strong>");
    expect(res.body.html).toContain("Unsubscribe");
  });

  it("is closed to company accounts", async () => {
    const { id: companyId } = await createCompany(connection.db);
    const company = await createUser(connection.db, { role: "company", companyId });
    const token = bearer((await login(app, company.email)).accessToken);
    await http().get("/newsletters").set(as(token)).expect(403);
  });
});

describe("sending", () => {
  it("sends each active subscriber their own copy with a one-click unsubscribe link", async () => {
    await subscribe("a@example.com");
    await subscribe("b@example.com");
    await subscribe("gone@example.com");
    await connection.db.update(subscribers).set({ unsubscribedAt: new Date() }).where(eq(subscribers.email, "gone@example.com"));
    const id = await draft();

    const res = await sendAndWait(id);
    expect(res.body.newsletter).toMatchObject({ status: "sending", recipients: 2 });

    expect(mailer.sent.map((m) => m.to).sort()).toEqual(["a@example.com", "b@example.com"]);
    const [row] = await connection.db.select().from(subscribers).where(eq(subscribers.email, "a@example.com"));
    const copy = mailer.sent.find((m) => m.to === "a@example.com")!;
    const link = `http://api.test/public/unsubscribe/${row.unsubscribeToken}`;
    expect(copy.subject).toBe("Weekly picks");
    expect(copy.html).toContain(link);
    expect(copy.text).toContain(link);
    expect(copy.headers).toEqual({ "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });

    const after = await http().get(`/newsletters/${id}`).set(as(editor)).expect(200);
    expect(after.body.newsletter).toMatchObject({ status: "sent", recipients: 2, sentCount: 2, failedCount: 0 });
    expect(after.body.newsletter.sentAt).toBeTruthy();
  });

  it("is for super admins only, and only once", async () => {
    await subscribe("a@example.com");
    const id = await draft();
    await http().post(`/newsletters/${id}/send`).set(as(editor)).expect(403);
    await sendAndWait(id);
    await http().post(`/newsletters/${id}/send`).set(as(owner)).expect(409);
    await http().patch(`/newsletters/${id}`).set(as(owner)).send({ subject: "Changed" }).expect(409);
    expect(mailer.sent).toHaveLength(1);
  });

  it("refuses an empty newsletter or an empty list", async () => {
    const empty = await draft(owner, "  ");
    const res = await http().post(`/newsletters/${empty}/send`).set(as(owner)).expect(400);
    expect(res.body.error.fields.body).toBeTruthy();
    const id = await draft();
    const none = await http().post(`/newsletters/${id}/send`).set(as(owner)).expect(409);
    expect(none.body.error.code).toBe("no_subscribers");
    const still = await http().get(`/newsletters/${id}`).set(as(owner)).expect(200);
    expect(still.body.newsletter.status).toBe("draft");
  });

  it("explains when email isn't set up", async () => {
    mailer.configured = false;
    await subscribe("a@example.com");
    const id = await draft();
    const res = await http().post(`/newsletters/${id}/send`).set(as(owner)).expect(503);
    expect(res.body.error.code).toBe("email_not_configured");
    expect((await http().get("/newsletters").set(as(owner))).body.sendingReady).toBe(false);
  });

  it("records failures and retries only those", async () => {
    await subscribe("a@example.com");
    await subscribe("b@example.com");
    const id = await draft();
    mailer.failWith = "Domain not verified";
    await sendAndWait(id);
    const failed = await http().get(`/newsletters/${id}`).set(as(owner)).expect(200);
    expect(failed.body.newsletter).toMatchObject({ status: "sent", sentCount: 0, failedCount: 2 });
    expect(failed.body.failures).toEqual([{ error: "Domain not verified", count: 2 }]);

    mailer.failWith = null;
    await http().post(`/newsletters/${id}/retry`).set(as(owner)).expect(202);
    await app.get(NewsletterSender).settled(id);
    const done = await http().get(`/newsletters/${id}`).set(as(owner)).expect(200);
    expect(done.body.newsletter).toMatchObject({ status: "sent", sentCount: 2, failedCount: 0 });
    expect(mailer.sent).toHaveLength(2);
    await http().post(`/newsletters/${id}/retry`).set(as(owner)).expect(409);
  });

  it("sends a test copy to the signed-in user", async () => {
    const id = await draft(editor);
    const res = await http().post(`/newsletters/${id}/test`).set(as(owner)).send({}).expect(200);
    expect(res.body.message).toBe("Test sent to owner@example.com.");
    expect(mailer.sent).toEqual([expect.objectContaining({ to: "owner@example.com", subject: "[Test] Weekly picks" })]);
  });

  it("deletes newsletters", async () => {
    const id = await draft();
    await http().delete(`/newsletters/${id}`).set(as(editor)).expect(204);
    await http().get(`/newsletters/${id}`).set(as(editor)).expect(404);
  });
});

describe("audience and scheduling", () => {
  const minutes = (n: number) => new Date(Date.now() + n * 60_000);
  const schedule = (id: number, sendAt: Date, audience?: object, headers = owner) =>
    http().post(`/newsletters/${id}/schedule`).set(as(headers)).send({ sendAt: sendAt.toISOString(), audience });

  async function signedUp(email: string, at: string) {
    await subscribe(email);
    await connection.db.update(subscribers).set({ createdAt: new Date(at) }).where(eq(subscribers.email, email));
  }

  it("counts and sends to an audience by sign-up date", async () => {
    await signedUp("old@example.com", "2026-01-10T00:00:00Z");
    await signedUp("new@example.com", "2026-03-10T00:00:00Z");
    await signedUp("newer@example.com", "2026-04-10T00:00:00Z");
    const audience = { from: "2026-03-01T00:00:00Z", to: "2026-04-01T00:00:00Z" };

    const size = await http().get("/newsletters/audience").query(audience).set(as(editor)).expect(200);
    expect(size.body).toEqual({ count: 1 });
    expect((await http().get("/newsletters/audience").set(as(editor)).expect(200)).body).toEqual({ count: 3 });

    const id = await draft();
    const res = await http().post(`/newsletters/${id}/send`).set(as(owner)).send({ audience }).expect(202);
    await app.get(NewsletterSender).settled(id);
    expect(res.body.newsletter).toMatchObject({ recipients: 1, audienceFrom: audience.from.replace("Z", ".000Z") });
    expect(mailer.sent.map((m) => m.to)).toEqual(["new@example.com"]);
  });

  it("rejects an audience that ends before it starts", async () => {
    const id = await draft();
    const res = await http()
      .post(`/newsletters/${id}/send`)
      .set(as(owner))
      .send({ audience: { from: "2026-03-01T00:00:00Z", to: "2026-02-01T00:00:00Z" } })
      .expect(400);
    expect(res.body.error.fields["audience.to"]).toBe("The end date must be after the start date");
  });

  it("schedules a newsletter and sends it when its time comes, not before", async () => {
    await subscribe("a@example.com");
    const id = await draft();
    await schedule(id, minutes(30), undefined, editor).expect(403);
    const res = await schedule(id, minutes(30)).expect(200);
    expect(res.body.newsletter).toMatchObject({ status: "scheduled", recipients: 0 });

    // Still editable while it waits.
    await http().patch(`/newsletters/${id}`).set(as(owner)).send({ subject: "Updated picks", body: "New body" }).expect(200);

    const scheduler = app.get(SchedulerService);
    expect((await scheduler.run(minutes(29))).newsletters).toEqual([]);
    expect(mailer.sent).toHaveLength(0);

    expect((await scheduler.run(minutes(31))).newsletters).toEqual([id]);
    await app.get(NewsletterSender).settled(id);
    expect(mailer.sent).toEqual([expect.objectContaining({ to: "a@example.com", subject: "Updated picks" })]);
    const after = await http().get(`/newsletters/${id}`).set(as(owner)).expect(200);
    expect(after.body.newsletter).toMatchObject({ status: "sent", recipients: 1, sentCount: 1 });

    // A later run doesn't start it again.
    expect((await scheduler.run(minutes(32))).newsletters).toEqual([]);
    expect(mailer.sent).toHaveLength(1);
  });

  it("refuses times in the past, and unschedules back to a draft", async () => {
    const id = await draft();
    const past = await schedule(id, minutes(-5)).expect(400);
    expect(past.body.error.fields.sendAt).toBe("Pick a time at least a minute from now");
    await schedule(id, minutes(60)).expect(200);
    const res = await http().delete(`/newsletters/${id}/schedule`).set(as(owner)).expect(200);
    expect(res.body.newsletter).toMatchObject({ status: "draft", scheduledAt: null });
    await http().delete(`/newsletters/${id}/schedule`).set(as(owner)).expect(409);
    expect((await app.get(SchedulerService).run(minutes(61))).newsletters).toEqual([]);
  });

  it("can send a scheduled newsletter right away instead", async () => {
    await subscribe("a@example.com");
    const id = await draft();
    await schedule(id, minutes(60)).expect(200);
    await sendAndWait(id);
    expect(mailer.sent).toHaveLength(1);
    expect((await app.get(SchedulerService).run(minutes(61))).newsletters).toEqual([]);
    expect(mailer.sent).toHaveLength(1);
  });

  it("marks a scheduled newsletter with nobody in its audience as sent to 0", async () => {
    const id = await draft();
    await schedule(id, minutes(10)).expect(200);
    await app.get(SchedulerService).run(minutes(11));
    await app.get(NewsletterSender).settled(id);
    const after = await http().get(`/newsletters/${id}`).set(as(owner)).expect(200);
    expect(after.body.newsletter).toMatchObject({ status: "sent", recipients: 0 });
  });
});

describe("subscribers and unsubscribing", () => {
  const token = async (email: string) =>
    (await connection.db.select().from(subscribers).where(eq(subscribers.email, email)))[0].unsubscribeToken;

  it("asks before unsubscribing, then unsubscribes", async () => {
    await subscribe("a@example.com");
    const t = await token("a@example.com");
    const page = await http().get(`/public/unsubscribe/${t}`).expect(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    expect(page.text).toContain("a@example.com");
    expect(page.text).toContain('<form method="post"');
    let [row] = await connection.db.select().from(subscribers).where(eq(subscribers.email, "a@example.com"));
    expect(row.unsubscribedAt).toBeNull();

    const done = await http().post(`/public/unsubscribe/${t}`).type("form").send("List-Unsubscribe=One-Click").expect(200);
    expect(done.text).toContain("You&#39;re unsubscribed</h1>");
    [row] = await connection.db.select().from(subscribers).where(eq(subscribers.email, "a@example.com"));
    expect(row.unsubscribedAt).toBeInstanceOf(Date);
    await http().post(`/public/unsubscribe/${t}`).expect(200);
  });

  it("shows a friendly page for a bad link", async () => {
    const res = await http().get("/public/unsubscribe/test").expect(200);
    expect(res.text).toContain("This link isn&#39;t valid</h1>");
    await http().post("/public/unsubscribe/00000000-0000-4000-8000-000000000000").expect(200);
  });

  it("lists status but never tokens, counts only active subscribers, and resubscribes", async () => {
    await subscribe("a@example.com");
    await subscribe("b@example.com");
    await http().post(`/public/unsubscribe/${await token("b@example.com")}`).expect(200);

    const list = await http().get("/subscribers").set(as(editor)).expect(200);
    expect(list.body.subscribers).toBe(1);
    expect(list.body.items).toHaveLength(2);
    for (const item of list.body.items) expect(item.unsubscribeToken).toBeUndefined();
    expect(list.body.items.find((s: { email: string }) => s.email === "b@example.com").unsubscribedAt).toBeTruthy();

    const csv = await http().get("/subscribers/export.csv").set(as(editor)).expect(200);
    expect(csv.text.split("\n")[0]).toBe("email,status,subscribed_at,unsubscribed_at");
    expect(csv.text).toMatch(/"b@example.com",unsubscribed,/);

    await subscribe("b@example.com");
    expect((await http().get("/subscribers").set(as(editor))).body.subscribers).toBe(2);
  });
});
