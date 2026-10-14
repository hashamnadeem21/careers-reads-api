import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import type { DbConnection } from "../src/db/client.js";
import { MailerService } from "../src/mail/mailer.service.js";
import { createTestApp } from "./helpers/app.js";
import { FakeMailer } from "./helpers/fake-mailer.js";
import { bearer, createCompany, createUser, login } from "./helpers/seed.js";
import { connectTestDb, resetTestDb } from "./helpers/test-db.js";

let connection: DbConnection;
let app: NestExpressApplication;
let owner: { authorization: string };
const mailer = new FakeMailer();
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  connection = await connectTestDb();
  await resetTestDb(connection);
  app = await createTestApp((m) => m.overrideProvider(MailerService).useValue(mailer));
  const admin = await createUser(connection.db, { role: "super_admin", name: "Hasham Nadeem" });
  owner = bearer((await login(app, admin.email)).accessToken);
});

beforeEach(() => mailer.reset());

afterAll(async () => {
  await app.close();
  await connection.end();
});

describe("invite emails", () => {
  it("emails a company invite with the one-time link, and still returns it to copy", async () => {
    const company = await createCompany(connection.db, { name: "Acme <Labs>" });
    const res = await http()
      .post(`/companies/${company.id}/invites`)
      .set(owner)
      .send({ email: "sara@acme.test", name: "Sara Khan" })
      .expect(201);
    expect(res.body).toMatchObject({
      emailed: true,
      message: "Invite emailed to sara@acme.test. You can also copy the link below.",
    });

    expect(mailer.sent).toHaveLength(1);
    const [email] = mailer.sent;
    expect(email.to).toBe("sara@acme.test");
    expect(email.subject).toBe("You're invited to Acme <Labs> on Career Reads");
    expect(email.html).toContain(`href="${res.body.link}"`); // the Accept invite button
    expect(email.html).toContain("Hasham Nadeem");
    expect(email.html).not.toContain("<Labs>"); // names are escaped in the HTML
    expect(email.text).toContain(res.body.link);
    // The copyable link is shown as-is (no Markdown escaping in it).
    expect(email.html).toContain(`>${res.body.link}</a>`);
    expect(email.html).not.toMatch(/unsubscribe/i);
  });

  it("emails staff invites with their role", async () => {
    await http()
      .post("/invites")
      .set(owner)
      .send({ email: "ed@careerreads.test", name: "Ed Itor", role: "editor" })
      .expect(201);
    expect(mailer.sent[0]).toMatchObject({
      to: "ed@careerreads.test",
      subject: "You're invited to the Career Reads admin",
    });
    expect(mailer.sent[0].text).toContain("Editor");
  });

  it("keeps the invite when the email can't be sent, so the link can be copied instead", async () => {
    mailer.failWith = "Resend is down";
    const res = await http()
      .post("/invites")
      .set(owner)
      .send({ email: "late@careerreads.test", name: "Late Comer", role: "editor" })
      .expect(201);
    expect(res.body).toMatchObject({ emailed: false, emailError: "Resend is down" });
    expect(res.body.message).toMatch(/couldn't be sent\. Copy the link below/);
    await http()
      .get(`/invites/${res.body.link.split("/invite/")[1]}`)
      .expect(200);

    mailer.reset();
    mailer.configured = false;
    const unset = await http()
      .post("/invites")
      .set(owner)
      .send({ email: "x@careerreads.test", name: "X Y", role: "editor" })
      .expect(201);
    expect(unset.body).toMatchObject({ emailed: false, emailError: expect.stringMatching(/isn't set up/) });
    expect(mailer.calls).toBe(0);
  });
});
