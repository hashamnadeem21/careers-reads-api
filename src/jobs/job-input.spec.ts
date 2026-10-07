import { dateInputToIso, jobBodySchema, jobSlugFrom, parseJobBody } from "./job-input.js";

const valid = {
  title: "Frontend Developer",
  company: "Example Co",
  country: "Pakistan",
  workModel: "remote",
  employmentType: "full-time",
  category: "software-it",
  experience: "mid",
  summary: "Build accessible interfaces with React and Next.js for a product team.",
  responsibilities: ["Build user interfaces", "", "Review code"],
  requirements: ["2+ years of React"],
  applyEmail: "jobs@example.com",
  applyUrl: "",
  postedAt: "2026-10-01",
  deadline: "2026-12-31",
  status: "published",
  featured: true,
};
const parse = (over: Record<string, unknown> = {}) => parseJobBody(jobBodySchema.parse({ ...valid, ...over }));

describe("parseJobBody", () => {
  it("builds a jobSchema object, dropping empty list items", () => {
    const parsed = parse();
    expect(parsed.errors).toEqual({});
    expect(parsed.slug).toBe("frontend-developer-example-co");
    expect(parsed.data).toMatchObject({
      responsibilities: ["Build user interfaces", "Review code"],
      postedAt: "2026-10-01T00:00:00.000Z",
      featured: true,
      status: "published",
      sample: false,
    });
    expect(parsed.data?.applyUrl).toBeUndefined();
  });

  it("requires a way to apply", () => {
    expect(parse({ applyEmail: "" }).errors.applyUrl).toMatch(/applyUrl or an applyEmail/);
  });

  it("rejects a deadline before the posted date and bad slugs", () => {
    const parsed = parse({ deadline: "2026-09-01", slug: "Bad Slug!" });
    expect(parsed.errors.deadline).toBeDefined();
    expect(parsed.errors.slug).toBeDefined();
    expect(parsed.data).toBeUndefined();
  });

  it("uses a custom slug when given", () => {
    expect(parse({ slug: "custom-slug" }).slug).toBe("custom-slug");
  });
});

describe("helpers", () => {
  it("converts date inputs to UTC midnight", () => {
    expect(dateInputToIso("2026-10-02")).toBe("2026-10-02T00:00:00.000Z");
    expect(dateInputToIso("")).toBeUndefined();
  });

  it("makes slugs from title and company", () => {
    expect(jobSlugFrom("UI/UX Designer", "Acme & Sons")).toBe("ui-ux-designer-acme-and-sons");
  });
});
