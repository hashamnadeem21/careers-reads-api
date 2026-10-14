import rehypeParse from "rehype-parse";
import rehypeSanitize, { type Options as SanitizeOptions } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";

/**
 * What a job description may contain: the formatting the admin's editor produces (and whatever
 * survives a paste into it). Everything else — scripts, styles, classes, images, tables — is dropped.
 */
const schema: SanitizeOptions = {
  tagNames: ["p", "br", "strong", "b", "em", "i", "u", "s", "a", "ul", "ol", "li", "h2", "h3", "h4", "blockquote", "hr"],
  attributes: { a: ["href"], ol: ["start"] },
  protocols: { href: ["http", "https", "mailto", "tel"] },
  clobberPrefix: "",
  strip: ["script", "style"],
};

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Links open in a new tab and pass no ranking (job ads link to third-party sites). */
function externalLinks() {
  const walk = (node: HastNode) => {
    if (node.type === "element" && node.tagName === "a") {
      node.properties = { ...node.properties, target: "_blank", rel: ["noopener", "noreferrer", "nofollow"] };
    }
    node.children?.forEach(walk);
  };
  return walk;
}

const processor = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeSanitize, schema)
  .use(externalLinks)
  .use(rehypeStringify);

/** Sanitized HTML for a job description. Safe to render as-is on the site. */
export function sanitizeJobHtml(html: string): string {
  return String(processor.processSync(html)).trim();
}
