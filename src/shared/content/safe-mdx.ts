// Owned by blognest-api (originally blognest/src/lib/content/safe-mdx.ts). The website keeps its own copy for its file fallback; keep the rules in step.
/**
 * remark plugin that keeps MDX to "Markdown + a few known components".
 *
 * MDX can run JavaScript ({expressions}, import/export, spread props, event
 * handlers). Content now comes from an admin panel with several editors, so
 * anything that could execute code on the server or in visitors' browsers is
 * removed (site) or rejected with a clear message (admin editor).
 */

interface MdxAttr {
  type: string;
  name?: string;
  value?: string | { type: string; value: string } | null;
}

interface MdNode {
  type: string;
  name?: string | null;
  value?: unknown;
  url?: string;
  attributes?: MdxAttr[];
  children?: MdNode[];
  position?: { start: { line: number } };
}

/** Components MDX content may use (see MdxContent.tsx). */
export const ALLOWED_MDX_COMPONENTS = new Set(["Callout", "Correction", "Figure", "ArticleImage", "InArticleAd"]);
const BLOCKED_TAGS = new Set(["script", "style", "iframe", "frame", "object", "embed", "form", "input", "button", "textarea", "select", "link", "meta", "base", "svg", "math", "template", "slot"]);
/** Attribute expressions may only be plain literals: width={1600}, index={0}, open={true}. */
const LITERAL = /^\s*(?:-?\d+(?:\.\d+)?|true|false|null|"[^"\\]*"|'[^'\\]*')\s*$/;
const UNSAFE_URL = /^\s*(?:javascript|vbscript|data):/i;

export class UnsafeMdxError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join("\n"));
    this.name = "UnsafeMdxError";
  }
}

function clean(parent: MdNode, problems: string[]): void {
  if (!parent.children) return;
  parent.children = parent.children.filter((node) => {
    const at = node.position ? ` (line ${node.position.start.line})` : "";

    if (node.type === "mdxFlowExpression" || node.type === "mdxTextExpression") {
      const code = String(node.value ?? "").trim();
      // MDX comments {/* … */} are harmless: drop them quietly.
      if (code !== "" && !/^\/\*[\s\S]*\*\/$/.test(code)) problems.push(`Curly-brace expressions {…} aren't allowed${at}. Write plain text instead.`);
      return false;
    }
    if (node.type === "mdxjsEsm") {
      problems.push(`import/export lines aren't allowed${at}.`);
      return false;
    }
    if ((node.type === "link" || node.type === "image" || node.type === "definition") && node.url && UNSAFE_URL.test(node.url)) {
      problems.push(`Links must use http(s), mailto or a site path${at}.`);
      node.url = "#";
    }
    if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
      const name = node.name ?? "";
      const allowed = ALLOWED_MDX_COMPONENTS.has(name) || (/^[a-z][a-z0-9]*$/.test(name) && !BLOCKED_TAGS.has(name));
      if (!allowed) {
        problems.push(`<${name || "fragment"}> isn't allowed${at}. Allowed components: ${[...ALLOWED_MDX_COMPONENTS].join(", ")}.`);
        return false;
      }
      node.attributes = (node.attributes ?? []).filter((attr) => {
        if (attr.type !== "mdxJsxAttribute" || !attr.name) {
          problems.push(`Spread attributes {...} aren't allowed${at}.`);
          return false;
        }
        if (/^on/i.test(attr.name) || attr.name === "dangerouslySetInnerHTML" || attr.name === "style" || attr.name === "ref") {
          problems.push(`The "${attr.name}" attribute isn't allowed${at}.`);
          return false;
        }
        if (attr.value && typeof attr.value === "object" && !LITERAL.test(attr.value.value)) {
          problems.push(`${attr.name}={…} must be a plain number, true/false or text${at}.`);
          return false;
        }
        if (typeof attr.value === "string" && /^(href|src|action|formaction|xlink:href)$/i.test(attr.name) && UNSAFE_URL.test(attr.value)) {
          problems.push(`Unsafe URL in "${attr.name}"${at}.`);
          return false;
        }
        return true;
      });
    }
    clean(node, problems);
    return true;
  });
}

/** `mode: "strip"` (site) silently removes unsafe parts; `"error"` (admin) throws UnsafeMdxError. */
export function remarkSafeMdx(options: { mode?: "strip" | "error" } = {}) {
  return (tree: MdNode) => {
    const problems: string[] = [];
    clean(tree, problems);
    if (problems.length && options.mode === "error") throw new UnsafeMdxError([...new Set(problems)]);
  };
}
