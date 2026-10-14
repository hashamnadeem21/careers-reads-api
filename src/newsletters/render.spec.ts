import { markdownToEmailHtml, renderNewsletter } from "./render.js";

const SITE = "https://careersreads.com";

describe("markdownToEmailHtml", () => {
  it("renders Markdown with inline styles", () => {
    const html = markdownToEmailHtml("## Hello\n\nSome **bold** text.", SITE);
    expect(html).toContain('<h2 style="');
    expect(html).toContain("<strong>bold</strong>");
  });

  it("drops raw HTML and script links", () => {
    const html = markdownToEmailHtml('<script>alert(1)</script>\n\n[x](javascript:alert(1)) <img src=x onerror="alert(1)">', SITE);
    expect(html).not.toMatch(/<script|onerror|javascript:/i);
  });

  it("makes relative links and images absolute, opening links in a new tab", () => {
    const html = markdownToEmailHtml("[Jobs](/jobs) ![Cover](/uploads/a.png)", SITE);
    expect(html).toContain('href="https://careersreads.com/jobs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('src="https://careersreads.com/uploads/a.png"');
  });
});

describe("renderNewsletter", () => {
  const content = { subject: "Weekly <picks>", previewText: "Five jobs & a guide", body: "Hi there." };
  const options = { siteUrl: SITE, unsubscribeUrl: "https://api.test/public/unsubscribe/abc", postalAddress: "1 Main St" };

  it("escapes the subject and preview text, and links to unsubscribe", () => {
    const { html } = renderNewsletter(content, options);
    expect(html).toContain("<title>Weekly &lt;picks&gt;</title>");
    expect(html).toContain("Five jobs &amp; a guide");
    expect(html).toContain('href="https://api.test/public/unsubscribe/abc"');
    expect(html).toContain("1 Main St");
  });

  it("has a plain-text version with the unsubscribe link", () => {
    const { text } = renderNewsletter(content, options);
    expect(text.startsWith("Hi there.")).toBe(true);
    expect(text).toContain("Unsubscribe: https://api.test/public/unsubscribe/abc");
  });
});

describe("branded layout", () => {
  const options = { siteUrl: SITE, unsubscribeUrl: "#unsubscribe" };

  it("has the logo, a banner image and a button when they are set", () => {
    const { html, text } = renderNewsletter(
      { subject: "S", previewText: "P", body: "Hi.", heroImage: "/uploads/banner.png", ctaLabel: "See jobs", ctaUrl: "/jobs" },
      options,
    );
    expect(html).toContain('src="https://careersreads.com/brand/careerreads-logo.png"');
    expect(html).toContain('src="https://careersreads.com/uploads/banner.png"');
    expect(html).toMatch(/<a href="https:\/\/careersreads.com\/jobs"[^>]*>See jobs<\/a>/);
    expect(text).toContain("See jobs: https://careersreads.com/jobs");
  });

  it("leaves out the banner and button when they are empty, and labels a bare link", () => {
    const plain = renderNewsletter({ subject: "S", previewText: "P", body: "Hi." }, options).html;
    expect(plain).not.toContain("uploads/");
    expect(plain).not.toContain("Read more");
    const bare = renderNewsletter({ subject: "S", previewText: "P", body: "Hi.", ctaUrl: "https://example.com" }, options).html;
    expect(bare).toContain(">Read more</a>");
  });
});

describe("email images", () => {
  it("load from assetsUrl while links stay on the site", () => {
    const { html } = renderNewsletter(
      { subject: "S", previewText: "P", body: "[Jobs](/jobs) ![x](/uploads/a.png)", heroImage: "/uploads/b.png" },
      { siteUrl: "http://localhost:3000", assetsUrl: SITE, unsubscribeUrl: "#" },
    );
    expect(html).toContain(`src="${SITE}/brand/careerreads-logo.png"`);
    expect(html).toContain(`src="${SITE}/uploads/a.png"`);
    expect(html).toContain(`src="${SITE}/uploads/b.png"`);
    expect(html).toContain('href="http://localhost:3000/jobs"');
  });
});
