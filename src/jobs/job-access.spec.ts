import { auditVerb, canAccessJob, jobScope, resolvePublishing } from "./job-access.js";

const staff = { role: "editor" as const, companyId: null, companyAutoPublish: false };
const acme = { role: "company" as const, companyId: "acme", companyAutoPublish: false };
const trusted = { role: "company" as const, companyId: "globex", companyAutoPublish: true };

describe("job access", () => {
  it("staff can access every job, companies only their own", () => {
    expect(canAccessJob(staff, { companyId: null })).toBe(true);
    expect(canAccessJob(staff, { companyId: "acme" })).toBe(true);
    expect(canAccessJob(acme, { companyId: "acme" })).toBe(true);
    expect(canAccessJob(acme, { companyId: "globex" })).toBe(false);
    expect(canAccessJob(acme, { companyId: null })).toBe(false);
  });

  it("scopes queries for companies only", () => {
    expect(jobScope(staff)).toBeUndefined();
    expect(jobScope(acme)).toBeDefined();
    expect(() => jobScope({ role: "company", companyId: null, companyAutoPublish: false })).toThrow();
  });
});

describe("resolvePublishing", () => {
  it("sends an untrusted company's publish to review, never live", () => {
    expect(resolvePublishing(acme, "published", null)).toEqual({ status: "draft", review: "pending" });
    // Editing a job that was already approved and live also goes back to review.
    expect(resolvePublishing(acme, "published", { companyId: "acme", review: "approved" })).toEqual({
      status: "draft",
      review: "pending",
    });
  });

  it("lets trusted companies publish directly", () => {
    expect(resolvePublishing(trusted, "published", null)).toEqual({ status: "published", review: "approved" });
  });

  it("clears the review when a company saves a draft", () => {
    expect(resolvePublishing(acme, "draft", { companyId: "acme", review: "rejected" })).toEqual({
      status: "draft",
      review: null,
    });
  });

  it("staff: publishing a company job approves it; Career Reads jobs have no review", () => {
    expect(resolvePublishing(staff, "published", { companyId: "acme", review: "pending" })).toEqual({
      status: "published",
      review: "approved",
    });
    expect(resolvePublishing(staff, "draft", { companyId: "acme", review: "pending" })).toEqual({
      status: "draft",
      review: "pending",
    });
    expect(resolvePublishing(staff, "published", { companyId: null, review: null })).toEqual({
      status: "published",
      review: null,
    });
  });
});

describe("auditVerb", () => {
  it("names the change", () => {
    expect(auditVerb(null, { status: "draft", review: "pending" })).toBe("submitted for review");
    expect(auditVerb({ status: "draft", review: null }, { status: "published", review: null })).toBe("published");
    expect(auditVerb({ status: "published", review: null }, { status: "draft", review: null })).toBe("unpublished");
    expect(auditVerb(null, { status: "draft", review: null })).toBe("created");
  });
});
