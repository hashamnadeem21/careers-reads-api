import { buildImportPlan } from "./import-plan.js";

const article = `---
title: "A perfectly reasonable article title"
excerpt: "An excerpt that is long enough to satisfy the fifty character minimum rule."
category: technology
tags: [Testing, testing, import]
author: editorial-team
publishedAt: 2026-09-01
status: published
coverImage: /images/covers/x.svg
coverAlt: "A cover image with a descriptive alt text"
images:
  - src: /images/articles/x-1.svg
    alt: "First in-post image with alt text"
    placement: section:why-it-matters
---

Intro paragraph.

## Why it matters
`;

const author = JSON.stringify({
  slug: "editorial-team",
  name: "Editorial Team",
  type: "Organization",
  role: "Editors",
  bio: "A bio that is comfortably longer than forty characters in total.",
  avatar: "/images/authors/x.svg",
});

const job = (sample: boolean) =>
  JSON.stringify({
    title: "Frontend Developer",
    company: "Example Co",
    country: "Pakistan",
    workModel: "remote",
    employmentType: "full-time",
    category: "software-it",
    experience: "mid",
    summary: "Build accessible interfaces with React and Next.js for a product team.",
    postedAt: "2026-10-01",
    status: "published",
    applyEmail: "jobs@example.com",
    sample,
  });

describe("buildImportPlan", () => {
  const input = {
    articleFiles: [{ name: "a-post.mdx", source: article }],
    authorFiles: [{ name: "editorial-team.json", source: author }],
    jobFiles: [
      { name: "real-job.json", source: job(false) },
      { name: "sample-job.json", source: job(true) },
    ],
  };

  it("maps articles with their images and normalised tags", () => {
    const plan = buildImportPlan(input);
    expect(plan.articles).toHaveLength(1);
    const [row] = plan.articles;
    expect(row.slug).toBe("a-post");
    expect(row.tags).toEqual(["testing", "import"]);
    expect(row.images).toEqual([
      expect.objectContaining({ src: "/images/articles/x-1.svg", placement: "section:why-it-matters", width: 1600 }),
    ]);
    expect(row.body.startsWith("Intro paragraph.")).toBe(true);
    expect(row.publishedAt).toEqual(new Date("2026-09-01"));
  });

  it("skips sample jobs unless asked", () => {
    expect(buildImportPlan(input).jobs.map((j) => j.slug)).toEqual(["real-job"]);
    expect(buildImportPlan(input).skippedSamples).toBe(1);
    expect(buildImportPlan({ ...input, includeSamples: true }).jobs).toHaveLength(2);
  });

  it("includes blog and job categories in order", () => {
    const { categories } = buildImportPlan(input);
    expect(categories.filter((c) => c.kind === "blog")[0]).toMatchObject({ slug: "technology", sortOrder: 0 });
    expect(categories.some((c) => c.kind === "job" && c.slug === "software-it")).toBe(true);
  });

  it("rejects invalid content with the file name", () => {
    const bad = { ...input, articleFiles: [{ name: "bad.mdx", source: "---\ntitle: short\n---\n" }] };
    expect(() => buildImportPlan(bad)).toThrow(/bad\.mdx/);
  });
});
