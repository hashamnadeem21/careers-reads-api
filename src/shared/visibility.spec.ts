import { isJobVisible } from "./jobs/visibility.js";

const job = { status: "published" as const, postedAt: "2026-01-01", deadline: "2099-01-01", sample: false };

describe("shared rules import cleanly under ESM", () => {
  it("isJobVisible hides drafts and expired jobs", () => {
    const now = new Date("2026-06-01");
    expect(isJobVisible(job, now, true)).toBe(true);
    expect(isJobVisible({ ...job, status: "draft" }, now, true)).toBe(false);
    expect(isJobVisible({ ...job, deadline: "2026-05-01" }, now, true)).toBe(false);
  });
});
