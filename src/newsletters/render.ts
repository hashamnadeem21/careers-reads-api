import type { Element, Root, RootContent } from "hast";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

/**
 * Turns a newsletter's Markdown into the email that goes out: sanitised HTML (no raw HTML or
 * scripts survive), inline styles (many inboxes drop <style>), absolute links and images, and a
 * footer with the unsubscribe link. Pure, so previews and real sends render exactly the same.
 */

export interface NewsletterContent {
  subject: string;
  previewText: string;
  body: string;
  /** Banner image above the body (site path or https URL). */
  heroImage?: string;
  /** Button after the body; shown when `ctaUrl` is set ("Read more" without a label). */
  ctaLabel?: string;
  ctaUrl?: string;
}

export interface RenderOptions {
  /** The website's origin; relative links and images (e.g. /uploads/…) are resolved against it. */
  siteUrl: string;
  /** Where images load from, when not `siteUrl` (inboxes can't reach a localhost site). */
  assetsUrl?: string;
  /** This subscriber's unsubscribe page. Left out for one-off emails (an application receipt). */
  unsubscribeUrl?: string;
  postalAddress?: string;
  /** The footer's "why you got this" line (default: the newsletter subscription). */
  reason?: string;
  /** The "New jobs every day" band above the footer (default: shown). */
  promo?: boolean;
}

export const SITE_NAME = "Career Reads";

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = "#0f172a";
const MUTED = "#64748b";
const LINK = "#2563eb";
const BRAND = "#2563eb";
const PAGE = "#eef2f7";

/** Inline styles per tag. Anything not listed keeps the inbox's defaults. */
const TAG_STYLES: Record<string, string> = {
  h1: `margin:28px 0 12px;font-size:26px;line-height:1.25;color:${INK}`,
  h2: `margin:28px 0 10px;font-size:21px;line-height:1.3;color:${INK}`,
  h3: `margin:22px 0 8px;font-size:17px;line-height:1.35;color:${INK}`,
  p: "margin:0 0 16px",
  a: `color:${LINK};text-decoration:underline`,
  ul: "margin:0 0 16px;padding-left:22px",
  ol: "margin:0 0 16px;padding-left:22px",
  li: "margin:0 0 6px",
  blockquote: `margin:0 0 16px;padding:4px 0 4px 16px;border-left:3px solid #cbd5e1;color:${MUTED}`,
  img: "display:block;max-width:100%;height:auto;margin:8px 0 16px;border-radius:8px",
  hr: "border:0;border-top:1px solid #e2e8f0;margin:28px 0",
  code: "font-family:Menlo,Consolas,monospace;font-size:14px;background:#f1f5f9;padding:1px 4px;border-radius:4px",
  pre: "background:#f1f5f9;padding:12px;border-radius:8px;overflow:auto;margin:0 0 16px",
  table: "border-collapse:collapse;width:100%;margin:0 0 16px",
  th: "border:1px solid #e2e8f0;padding:8px;text-align:left;background:#f8fafc",
  td: "border:1px solid #e2e8f0;padding:8px",
};

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function absolute(url: string, base: string): string {
  if (/^(https?:|mailto:|#)/i.test(url)) return url;
  try {
    return new URL(url, `${base}/`).toString();
  } catch {
    return url;
  }
}

/** rehype plugin: inline styles, absolute URLs, and links that open in a new tab. */
function emailify(siteUrl: string, assetsUrl: string) {
  const visit = (node: Root | RootContent) => {
    if (node.type === "element") styleElement(node, siteUrl, assetsUrl);
    if ("children" in node) node.children.forEach(visit);
  };
  return () => (tree: Root) => visit(tree);
}

function styleElement(node: Element, siteUrl: string, assetsUrl: string) {
  const style = TAG_STYLES[node.tagName];
  if (style) node.properties.style = style;
  if (node.tagName === "a" && typeof node.properties.href === "string") {
    node.properties.href = absolute(node.properties.href, siteUrl);
    node.properties.target = "_blank";
    node.properties.rel = ["noopener"];
  }
  if (node.tagName === "img" && typeof node.properties.src === "string") {
    node.properties.src = absolute(node.properties.src, assetsUrl);
  }
}

/** Markdown → sanitised, inline-styled HTML (the email's content area only). */
export function markdownToEmailHtml(markdown: string, siteUrl: string, assetsUrl = siteUrl): string {
  return String(
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(rehypeSanitize)
      .use(emailify(siteUrl, assetsUrl))
      .use(rehypeStringify)
      .processSync(markdown),
  );
}

/** Hidden after the preview line so inboxes don't pad it with the start of the email. */
const PREHEADER_FILLER = "&#8199;&#847;&zwnj;&nbsp;".repeat(60);

/** A button built from a table cell, so Outlook draws it too. */
function button(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px">
<tr><td align="center" bgcolor="${BRAND}" style="border-radius:10px;background:${BRAND}">
<a href="${escapeHtml(href)}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;font-weight:700;line-height:1;color:#ffffff;text-decoration:none;border-radius:10px">${escapeHtml(label)}</a>
</td></tr>
</table>`;
}

/**
 * The full email: HTML and a plain-text version. Layout, top to bottom: hidden preview line, brand
 * bar, logo with the site's sections, optional banner image, the body, optional button, a short
 * "why Career Reads" band, and the footer with the unsubscribe link.
 */
export function renderNewsletter(content: NewsletterContent, options: RenderOptions): { html: string; text: string } {
  const { siteUrl, unsubscribeUrl, postalAddress, assetsUrl = siteUrl, promo = true } = options;
  const reason = options.reason ?? `You're receiving this because you subscribed to the ${SITE_NAME} newsletter.`;
  const site = escapeHtml(siteUrl);
  const link = (path: string) => escapeHtml(absolute(path, siteUrl));
  const ctaUrl = content.ctaUrl?.trim() ? absolute(content.ctaUrl.trim(), siteUrl) : "";
  const ctaLabel = content.ctaLabel?.trim() || "Read more";
  const hero = content.heroImage?.trim() ? absolute(content.heroImage.trim(), assetsUrl) : "";
  const heroImg = hero
    ? `<img src="${escapeHtml(hero)}" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto;border:0">`
    : "";
  const nav = [
    ["Latest jobs", "/jobs"],
    ["Career guides", "/blog"],
    ["Trending", "/trending"],
  ]
    .map(
      ([label, path]) =>
        `<a href="${link(path)}" target="_blank" style="color:${MUTED};text-decoration:none">${label}</a>`,
    )
    .join(`<span style="color:#cbd5e1">&nbsp;&nbsp;·&nbsp;&nbsp;</span>`);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(content.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(content.previewText)}${PREHEADER_FILLER}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE}">
<tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0">
<tr><td height="5" style="height:5px;line-height:5px;font-size:0;background:${BRAND};background-image:linear-gradient(90deg,${BRAND},#0ea5e9)">&nbsp;</td></tr>
<tr><td align="center" style="padding:26px 28px 18px;border-bottom:1px solid #eef2f7">
<a href="${site}" target="_blank" style="text-decoration:none"><img src="${escapeHtml(absolute("/brand/careerreads-logo.png", assetsUrl))}" width="198" height="44" alt="${SITE_NAME}" style="display:block;width:198px;height:auto;border:0;font-family:${FONT};font-size:22px;font-weight:700;color:${INK}"></a>
<div style="padding-top:14px;font-family:${FONT};font-size:13px;font-weight:600;letter-spacing:.2px">${nav}</div>
</td></tr>
${heroImg ? `<tr><td style="padding:0">${ctaUrl ? `<a href="${escapeHtml(ctaUrl)}" target="_blank">${heroImg}</a>` : heroImg}</td></tr>` : ""}
<tr><td style="padding:32px 32px 12px;font-family:${FONT};font-size:16px;line-height:1.65;color:${INK}">
${markdownToEmailHtml(content.body, siteUrl, assetsUrl)}
${ctaUrl ? button(ctaLabel, ctaUrl) : ""}
</td></tr>
${
  promo
    ? `<tr><td style="padding:16px 32px 32px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border-radius:12px">
<tr><td style="padding:18px 20px;font-family:${FONT};font-size:14px;line-height:1.55;color:${INK}">
<strong>New jobs every day, plus practical career guides.</strong><br>
<span style="color:${MUTED}">Every listing links straight to the employer. Never pay anyone to apply.</span><br>
<a href="${link("/jobs")}" target="_blank" style="display:inline-block;margin-top:8px;color:${LINK};font-weight:700;text-decoration:none">Browse the latest jobs &rarr;</a>
</td></tr>
</table>
</td></tr>`
    : `<tr><td style="height:20px;line-height:20px;font-size:0">&nbsp;</td></tr>`
}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
<tr><td style="padding:22px 16px 8px;font-family:${FONT};font-size:12px;line-height:1.7;color:${MUTED};text-align:center">
${escapeHtml(reason)}<br>
${postalAddress ? `${escapeHtml(postalAddress)}<br>` : ""}${unsubscribeUrl ? `<a href="${escapeHtml(unsubscribeUrl)}" style="color:${MUTED};text-decoration:underline">Unsubscribe</a>&nbsp;&nbsp;·&nbsp;&nbsp;` : ""}<a href="${site}" target="_blank" style="color:${MUTED};text-decoration:underline">Visit ${SITE_NAME}</a><br>
&copy; ${new Date().getFullYear()} ${SITE_NAME}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    content.body.trim(),
    ...(ctaUrl ? ["", `${ctaLabel}: ${ctaUrl}`] : []),
    "",
    "—",
    reason,
    ...(postalAddress ? [postalAddress] : []),
    ...(unsubscribeUrl ? [`Unsubscribe: ${unsubscribeUrl}`] : []),
  ].join("\n");

  return { html, text };
}
