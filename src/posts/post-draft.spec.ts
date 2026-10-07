import { checkMdxBody } from "./mdx-check.js";
import { checkDraft, type PostDraft, resolvePublishing } from "./post-draft.js";

const body = `Intro paragraph that sets things up.

## First section

Text.

## Second section

### A detail

More.

## Conclusion

Bye.`;

const draft = (over: Partial<PostDraft> = {}): PostDraft => ({
  slug: "a-good-post",
  title: "A perfectly good post title",
  excerpt: "An excerpt that is comfortably longer than the fifty character minimum.",
  body,
  category: "technology",
  tags: ["Testing"],
  author: "editorial-team",
  coverImage: "/uploads/hero.webp",
  coverAlt: "A descriptive hero image",
  coverWidth: 1600,
  coverHeight: 900,
  images: [],
  seoTitle: "",
  seoDescription: "",
  canonicalUrl: "",
  noindex: false,
  ads: true,
  featured: false,
  trending: false,
  editorsPick: false,
  ...over,
});

const now = new Date("2026-10-02T12:00:00Z");
const fresh = { status: "draft" as const, publishedAt: null };

describe("resolvePublishing", () => {
  it("publishes now, keeping the original date for already-live posts", () => {
    expect(resolvePublishing(fresh, "publish", now)).toEqual({ status: "published", publishedAt: now });
    const old = new Date("2026-01-01T00:00:00.000Z");
    expect(resolvePublishing({ status: "published", publishedAt: old }, "publish", now)).toEqual({
      status: "published",
      publishedAt: old,
    });
  });

  it("only schedules into the future", () => {
    expect(resolvePublishing(fresh, "schedule", now, "2026-10-01T00:00:00Z")).toHaveProperty("error");
    expect(resolvePublishing(fresh, "schedule", now)).toHaveProperty("error");
    expect(resolvePublishing(fresh, "schedule", now, "2026-10-09T09:00:00Z")).toEqual({
      status: "published",
      publishedAt: new Date("2026-10-09T09:00:00Z"),
    });
  });

  it("unpublish and autosave produce drafts; update keeps the status", () => {
    expect(resolvePublishing({ status: "published", publishedAt: now }, "unpublish", now)).toMatchObject({
      status: "draft",
    });
    expect(resolvePublishing(fresh, "autosave", now)).toMatchObject({ status: "draft" });
    expect(resolvePublishing({ status: "published", publishedAt: now }, "update", now)).toMatchObject({
      status: "published",
    });
  });
});

describe("checkDraft", () => {
  it("accepts a complete post and lowercases tags like the site", () => {
    const result = checkDraft(draft(), { status: "draft", publishedAt: now });
    expect(result.errors).toEqual({});
    expect(result.data?.tags).toEqual(["testing"]);
  });

  it("reports nested image errors by path", () => {
    const result = checkDraft(
      draft({
        images: [{ src: "/uploads/x.webp", alt: "short", caption: "", width: 10, height: 10, placement: "middle" }],
        coverImage: "",
      }),
      { status: "draft", publishedAt: now },
    );
    expect(result.errors["images.0.alt"]).toBeDefined();
    expect(result.errors.coverImage).toBe("Choose a hero image");
    expect(result.data).toBeUndefined();
  });

  it("rejects bad slugs and empty bodies", () => {
    const result = checkDraft(draft({ slug: "Bad Slug", body: "short" }), { status: "draft", publishedAt: now });
    expect(Object.keys(result.errors).sort()).toEqual(["body", "slug"]);
  });

  it("flags images under a heading that no longer exists", () => {
    const result = checkDraft(
      draft({
        images: [
          {
            src: "/uploads/x.webp",
            alt: "A descriptive alt text",
            caption: "",
            width: 10,
            height: 10,
            placement: "section:gone",
          },
        ],
      }),
      { status: "draft", publishedAt: now },
    );
    expect(result.missingSections).toEqual([0]);
  });
});

describe("checkMdxBody", () => {
  it("accepts normal Markdown with site components", async () => {
    expect(
      await checkMdxBody(
        '## Heading\n\n<Callout type="tip">Hi</Callout>\n\n<Figure src="/a.png" alt="An image" width={10} height={10} />',
      ),
    ).toBeNull();
  });

  it("rejects code and broken syntax with a readable message", async () => {
    expect(await checkMdxBody("Secret: {process.env.DATABASE_URL}")).toMatch(/Curly-brace/);
    expect(await checkMdxBody("<Callout>unclosed")).toMatch(/formatting problem/);
  });
});
