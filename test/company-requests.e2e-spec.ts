import type { NestExpressApplication } from "@nestjs/platform-express";
import { eq } from "drizzle-orm";
import request from "supertest";
import type { DbConnection } from "../src/db/client.js";
import { companies, companyRequests, invites, users } from "../src/db/schema.js";
import { MailerService } from "../src/mail/mailer.service.js";
import { createTestApp } from "./helpers/app.js";
import { FakeMailer } from "./helpers/fake-mailer.js";
import { asSiteServer, bearer, createCategory, createCompany, createUser, login } from "./helpers/seed.js";
import { connectTestDb, resetTestDb } from "./helpers/test-db.js";

let connection: DbConnection;
let app: NestExpressApplication;
let owner: { authorization: string };
let ownerEmail: string;
let editor: { authorization: string };
const mailer = new FakeMailer();
const http = () => request(app.getHttpServer());

const form = (over: Record<string, unknown> = {}) => ({
  companyName: "Northwind Traders",
  website: "https://northwind.example",
  industry: "Retail & E-commerce",
  companySize: "51-200",
  location: "Lahore, Pakistan",
  contactName: "Amna Riaz",
  contactEmail: "Amna@Northwind.example",
  contactPhone: "+92 300 1234567",
  contactRole: "HR Manager",
  hiringPlans: "Store managers and two frontend developers this quarter.",
  consent: true,
  ...over,
});

const submit = (body: Record<string, unknown>, site = asSiteServer()) => http().post("/public/company-requests").set(site).send(body);
const requestRow = async (email: string) =>
  (await connection.db.select().from(companyRequests).where(eq(companyRequests.contactEmail, email)));

beforeAll(async () => {
  connection = await connectTestDb();
  await resetTestDb(connection);
  app = await createTestApp((m) => m.overrideProvider(MailerService).useValue(mailer));
  await createCategory(connection.db, { slug: "software-it", kind: "job", name: "Software & IT" });
  const ownerUser = await createUser(connection.db, { role: "super_admin", name: "Hasham" });
  ownerEmail = ownerUser.email;
  owner = bearer((await login(app, ownerUser.email)).accessToken);
  editor = bearer((await login(app, (await createUser(connection.db, { role: "editor" })).email)).accessToken);
});

afterAll(async () => {
  await app.close();
  await connection.end();
});

beforeEach(() => {
  mailer.sent = [];
});

describe("company account requests", () => {
  let requestId: string;

  it("only takes requests from the website's server", async () => {
    await http().post("/public/company-requests").send(form()).expect(403);
  });

  it("checks every field", async () => {
    const res = await submit({ ...form(), companyName: "", industry: "Space mining", contactEmail: "nope", consent: false }).expect(400);
    expect(Object.keys(res.body.error.fields).sort()).toEqual(["companyName", "consent", "contactEmail", "industry"]);
  });

  it("saves a request, emails the company a receipt and the super admins a heads-up", async () => {
    const res = await submit(form()).expect(201);
    expect(res.body.message).toMatch(/email you at amna@northwind.example/);
    const [row] = await requestRow("amna@northwind.example");
    expect(row).toMatchObject({ companyName: "Northwind Traders", status: "pending", companySize: "51-200" });
    requestId = row.id;

    expect(mailer.sent.map((e) => e.to).sort()).toEqual(["amna@northwind.example", ownerEmail].sort());
    const toAdmin = mailer.sent.find((e) => e.to === ownerEmail)!;
    expect(toAdmin.subject).toBe("New company request: Northwind Traders");
    expect(toAdmin.replyTo).toBe("amna@northwind.example");
    expect(toAdmin.html).toContain(`/company-requests/${requestId}`);
  });

  it("a second request while the first waits changes nothing", async () => {
    await submit(form({ companyName: "Northwind Again" })).expect(201);
    expect(await requestRow("amna@northwind.example")).toHaveLength(1);
    expect(mailer.sent).toEqual([]);
  });

  it("is reviewed by super admins only", async () => {
    await http().get("/company-requests").set(editor).expect(403);
    await http().get(`/company-requests/${requestId}`).set(editor).expect(403);
    await http().post(`/company-requests/${requestId}/reject`).set(editor).send({}).expect(403);

    const list = await http().get("/company-requests").set(owner).expect(200);
    expect(list.body.counts).toEqual({ pending: 1, approved: 0, rejected: 0 });
    expect(list.body.items).toEqual([expect.objectContaining({ id: requestId, companyName: "Northwind Traders", status: "pending" })]);
    expect((await http().get("/company-requests/pending-count").set(owner).expect(200)).body).toEqual({ count: 1 });

    const detail = await http().get(`/company-requests/${requestId}`).set(owner).expect(200);
    expect(detail.body.request).toMatchObject({ contactEmail: "amna@northwind.example", hiringPlans: expect.stringContaining("Store managers") });
    expect(detail.body.checks).toEqual({ emailHasAccount: false, companyNameTaken: false, previousRequests: 0 });
  });

  it("approving sets up the company and invites the contact, who can then post jobs", async () => {
    const approve = {
      companyName: "Northwind Traders Ltd",
      website: "https://northwind.example",
      autoPublish: false,
      onsiteApplyEnabled: true,
      contactName: "Amna Riaz",
      contactEmail: "amna@northwind.example",
    };
    const res = await http().post(`/company-requests/${requestId}/approve`).set(owner).send(approve).expect(200);
    expect(res.body.message).toMatch(/Northwind Traders Ltd is set up, and Amna Riaz has been emailed an invite/);
    expect(res.body.invite.emailed).toBe(true);

    const [company] = await connection.db.select().from(companies).where(eq(companies.id, res.body.companyId));
    expect(company).toMatchObject({ name: "Northwind Traders Ltd", onsiteApplyEnabled: true, autoPublish: false, active: true });
    const [invite] = await connection.db.select().from(invites).where(eq(invites.email, "amna@northwind.example"));
    expect(invite).toMatchObject({ role: "company", companyId: company.id });
    expect(mailer.sent.map((e) => e.to)).toEqual(["amna@northwind.example"]);

    const [row] = await requestRow("amna@northwind.example");
    expect(row).toMatchObject({ status: "approved", companyId: company.id });
    const detail = await http().get(`/company-requests/${requestId}`).set(owner).expect(200);
    expect(detail.body.request).toMatchObject({ reviewedByName: "Hasham", approvedCompanyName: "Northwind Traders Ltd" });

    // The invite works: Amna picks a password and her company account can post a job.
    const token = res.body.invite.link.split("/invite/")[1];
    const joined = await http()
      .post(`/invites/${token}/accept`)
      .send({ name: "Amna Riaz", password: "a-strong-passphrase-42", confirm: "a-strong-passphrase-42" })
      .expect(200);
    const amna = bearer(joined.body.accessToken);
    const job = await http()
      .post("/jobs")
      .set(amna)
      .send({
        title: "Store Manager",
        company: "ignored",
        country: "Pakistan",
        workModel: "on-site",
        employmentType: "full-time",
        category: "software-it",
        experience: "mid",
        summary: "Run our flagship store and lead a friendly team of twelve people.",
        postedAt: new Date().toISOString().slice(0, 10),
        status: "published",
        onsiteApply: true,
      })
      .expect(201);
    expect(job.body.job).toMatchObject({ company: "Northwind Traders Ltd", review: "pending" });
  });

  it("can't be reviewed twice", async () => {
    await http().post(`/company-requests/${requestId}/reject`).set(owner).send({}).expect(409);
    const again = await http()
      .post(`/company-requests/${requestId}/approve`)
      .set(owner)
      .send({ companyName: "Other", contactName: "Amna", contactEmail: "other@northwind.example" })
      .expect(409);
    expect(again.body.error.code).toBe("already_reviewed");
  });

  it("won't approve when the email already has an account or the name is taken, and creates nothing", async () => {
    await submit(form({ contactEmail: "sam@globex.example", companyName: "Globex" })).expect(201);
    const [row] = await requestRow("sam@globex.example");
    await createUser(connection.db, { email: "sam@globex.example", role: "editor" });
    await createCompany(connection.db, { name: "Globex" });

    const detail = await http().get(`/company-requests/${row.id}`).set(owner).expect(200);
    expect(detail.body.checks).toMatchObject({ emailHasAccount: true, companyNameTaken: true });

    const before = (await connection.db.select().from(companies)).length;
    const taken = await http()
      .post(`/company-requests/${row.id}/approve`)
      .set(owner)
      .send({ companyName: "Globex", contactName: "Sam", contactEmail: "new-sam@globex.example" })
      .expect(409);
    expect(taken.body.error.fields).toEqual({ companyName: "A company with this name already exists" });
    const member = await http()
      .post(`/company-requests/${row.id}/approve`)
      .set(owner)
      .send({ companyName: "Globex Pakistan", contactName: "Sam", contactEmail: "sam@globex.example" })
      .expect(409);
    expect(member.body.error.fields).toEqual({ contactEmail: "Already has an admin account" });
    expect((await connection.db.select().from(companies)).length).toBe(before);
    expect((await requestRow("sam@globex.example"))[0].status).toBe("pending");
  });

  it("turning a request down tells them why, or stays quiet", async () => {
    const [globex] = await requestRow("sam@globex.example");
    const res = await http()
      .post(`/company-requests/${globex.id}/reject`)
      .set(owner)
      .send({ reason: "We couldn't verify the company's website.", notify: true })
      .expect(200);
    expect(res.body.emailed).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: "sam@globex.example", subject: "Your Career Reads company account request" });
    expect(mailer.sent[0].html).toMatch(/verify the company(&#39;|')s website/);
    expect((await requestRow("sam@globex.example"))[0]).toMatchObject({ status: "rejected", reviewNote: "We couldn't verify the company's website." });

    mailer.sent = [];
    await submit(form({ contactEmail: "quiet@initech.example", companyName: "Initech" })).expect(201);
    const [quiet] = await requestRow("quiet@initech.example");
    mailer.sent = [];
    const silent = await http().post(`/company-requests/${quiet.id}/reject`).set(owner).send({ notify: false }).expect(200);
    expect(silent.body).toMatchObject({ emailed: false });
    expect(mailer.sent).toEqual([]);

    const list = await http().get("/company-requests?status=all").set(owner).expect(200);
    expect(list.body.counts).toEqual({ pending: 0, approved: 1, rejected: 2 });
    expect(list.body.items).toHaveLength(3);
  });

  it("a request turned down can be sent again", async () => {
    await submit(form({ contactEmail: "sam@globex.example", companyName: "Globex" })).expect(201);
    const rows = await requestRow("sam@globex.example");
    expect(rows.map((r) => r.status).sort()).toEqual(["pending", "rejected"]);
    const pending = rows.find((r) => r.status === "pending")!;
    expect((await http().get(`/company-requests/${pending.id}`).set(owner).expect(200)).body.checks.previousRequests).toBe(1);
  });

  it("limits requests per visitor", async () => {
    const site = asSiteServer("192.0.2.77");
    for (let i = 0; i < 3; i++) await submit(form({ contactEmail: `flood${i}@spam.example` }), site).expect(201);
    await submit(form({ contactEmail: "flood9@spam.example" }), site).expect(429);
  });

  it("keeps the requests' emails lowercase in the database", async () => {
    const all = await connection.db.select({ email: companyRequests.contactEmail }).from(companyRequests);
    expect(all.every((r) => r.email === r.email.toLowerCase())).toBe(true);
    expect(await connection.db.select().from(users).where(eq(users.email, "amna@northwind.example"))).toHaveLength(1);
  });
});
