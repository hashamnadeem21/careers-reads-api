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
}

export interface RenderOptions {
  /** The website's origin; relative links and images (e.g. /uploads/…) are resolved against it. */
  siteUrl: string;
  /** This subscriber's unsubscribe page. */
  unsubscribeUrl: string;
  postalAddress?: string;
}

export const SITE_NAME = "Career Reads";

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = "#0f172a";
const MUTED = "#64748b";
const LINK = "#2563eb";

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
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
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
function emailify(siteUrl: string) {
  const visit = (node: Root | RootContent) => {
    if (node.type === "element") styleElement(node, siteUrl);
    if ("children" in node) node.children.forEach(visit);
  };
  return () => (tree: Root) => visit(tree);
}

function styleElement(node: Element, siteUrl: string) {
  const style = TAG_STYLES[node.tagName];
  if (style) node.properties.style = style;
  if (node.tagName === "a" && typeof node.properties.href === "string") {
    node.properties.href = absolute(node.properties.href, siteUrl);
    node.properties.target = "_blank";
    node.properties.rel = ["noopener"];
  }
  if (node.tagName === "img" && typeof node.properties.src === "string") {
    node.properties.src = absolute(node.properties.src, siteUrl);
  }
}

/** Markdown → sanitised, inline-styled HTML (the email's content area only). */
export function markdownToEmailHtml(markdown: string, siteUrl: string): string {
  return String(
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(rehypeSanitize)
      .use(emailify(siteUrl))
      .use(rehypeStringify)
      .processSync(markdown),
  );
}

/** The full email: HTML (with a hidden preview line) and a plain-text version. */
export function renderNewsletter(content: NewsletterContent, options: RenderOptions): { html: string; text: string } {
  const { siteUrl, unsubscribeUrl, postalAddress } = options;
  const site = escapeHtml(siteUrl);
  const footer = [
    `You're receiving this because you subscribed to the ${SITE_NAME} newsletter.`,
    postalAddress ? escapeHtml(postalAddress) : "",
  ]
    .filter(Boolean)
    .join("<br>");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(content.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(content.previewText)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9">
<tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
<tr><td style="padding:0 8px 16px;font-family:${FONT};font-size:18px;font-weight:700">
<a href="${site}" style="color:${INK};text-decoration:none">${SITE_NAME}</a>
</td></tr>
<tr><td style="background:#ffffff;border-radius:16px;padding:32px 28px;font-family:${FONT};font-size:16px;line-height:1.65;color:${INK}">
${markdownToEmailHtml(content.body, siteUrl)}
</td></tr>
<tr><td style="padding:20px 8px;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED};text-align:center">
${footer}<br>
<a href="${escapeHtml(unsubscribeUrl)}" style="color:${MUTED};text-decoration:underline">Unsubscribe</a> · <a href="${site}" style="color:${MUTED};text-decoration:underline">Visit ${SITE_NAME}</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    content.body.trim(),
    "",
    "—",
    `You're receiving this because you subscribed to the ${SITE_NAME} newsletter.`,
    ...(postalAddress ? [postalAddress] : []),
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");

  return { html, text };
}
