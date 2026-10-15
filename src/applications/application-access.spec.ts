import { applicationScope, canAccessApplication } from "./application-access.js";

const owner = { role: "super_admin" as const, companyId: null };
const editor = { role: "editor" as const, companyId: null };
const acme = { role: "company" as const, companyId: "acme" };

describe("application access", () => {
  it("lets a company see only its own applications", () => {
    expect(canAccessApplication(acme, { companyId: "acme" })).toBe(true);
    expect(canAccessApplication(acme, { companyId: "globex" })).toBe(false);
    expect(canAccessApplication(acme, { companyId: null })).toBe(false);
    expect(() => applicationScope({ role: "company", companyId: null })).toThrow();
  });

  it("lets editors see Career Reads' own jobs only, and the super admin everything", () => {
    expect(canAccessApplication(editor, { companyId: null })).toBe(true);
    expect(canAccessApplication(editor, { companyId: "acme" })).toBe(false);
    expect(canAccessApplication(owner, { companyId: "acme" })).toBe(true);
    expect(applicationScope(owner)).toBeDefined(); // still hides held applications
    expect(applicationScope(editor)).toBeDefined();
  });

  it("hides applications waiting for the candidate to confirm their email, even from the super admin", () => {
    expect(canAccessApplication(owner, { companyId: "acme", awaitingConfirmation: true })).toBe(false);
    expect(canAccessApplication(acme, { companyId: "acme", awaitingConfirmation: true })).toBe(false);
    expect(canAccessApplication(acme, { companyId: "acme", awaitingConfirmation: false })).toBe(true);
  });
});
