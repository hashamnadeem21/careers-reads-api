// Owned by blognest-api (originally blognest/src/lib/content/toc.ts). The website keeps its own copy for its file fallback; keep the rules in step.
import GithubSlugger from "github-slugger";
import type { ArticleImage, TocItem } from "./schema.js";

/**
 * Extracts H2/H3 headings from markdown, skipping fenced code blocks.
 * Uses github-slugger so ids match the ones rehype-slug assigns at render time.
 */
export function extractToc(markdown: string): TocItem[] {
  const slugger = new GithubSlugger();
  const items: TocItem[] = [];
  let inFence = false;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;

    const depth = match[1].length;
    const text = stripInlineMarkdown(match[2]);
    // Every heading advances the slugger so duplicate ids stay in sync.
    const id = slugger.slug(text);
    if (depth === 2 || depth === 3) items.push({ id, text, depth });
  }

  return items;
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}

/**
 * Inserts an in-article ad marker before the Nth H2 (outside code fences)
 * when the author has not placed one manually.
 */
export function injectInArticleAd(markdown: string, beforeHeading = 3, marker = "<InArticleAd />"): string {
  if (markdown.includes("<InArticleAd")) return markdown;

  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let h2Count = 0;

  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^##\s+/.test(lines[i])) {
      h2Count++;
      if (h2Count === beforeHeading) {
        lines.splice(i, 0, "", marker, "");
        return lines.join("\n");
      }
    }
  }
  return markdown;
}

interface HeadingLine {
  line: number;
  depth: number;
  id: string;
}

/** Every markdown heading (outside code fences) with its line number and rendered anchor id. */
function headingLines(lines: string[]): HeadingLine[] {
  const slugger = new GithubSlugger();
  const headings: HeadingLine[] = [];
  let inFence = false;
  lines.forEach((rawLine, line) => {
    if (/^\s*(```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(rawLine.trimEnd());
    if (match) headings.push({ line, depth: match[1].length, id: slugger.slug(stripInlineMarkdown(match[2])) });
  });
  return headings;
}

/**
 * Returns the line index an image marker should be inserted at, or the end of
 * the document when the article has no section headings. Unknown
 * "section:<id>" placements fall back to "middle".
 */
export function resolveImageLine(lines: string[], placement: ArticleImage["placement"]): number {
  const headings = headingLines(lines);
  const h2 = headings.filter((h) => h.depth === 2);
  if (h2.length === 0) return lines.length;

  if (placement === "after-intro") return h2[0].line;
  if (placement === "before-conclusion") return h2[h2.length - 1].line;
  if (placement.startsWith("section:")) {
    const target = headings.find((h) => h.id === placement.slice("section:".length));
    if (target) return target.line + 1;
  }
  // "middle": directly under the heading of the middle section.
  return h2[Math.floor((h2.length - 1) / 2)].line + 1;
}

/** Heading ids an image can be placed under, for validation and the admin picker. */
export function placeableSectionIds(markdown: string): string[] {
  return headingLines(markdown.split(/\r?\n/))
    .filter((h) => h.depth === 2 || h.depth === 3)
    .map((h) => h.id);
}

/** Inserts `<ArticleImage index={n} />` markers where each image belongs. */
export function injectArticleImages(markdown: string, images: Pick<ArticleImage, "placement">[]): string {
  if (images.length === 0) return markdown;
  const lines = markdown.split(/\r?\n/);
  const inserts = images
    .map((image, index) => ({ index, at: resolveImageLine(lines, image.placement) }))
    // Insert bottom-up so earlier line numbers stay valid; keep authoring order for ties.
    .sort((a, b) => b.at - a.at || b.index - a.index);
  for (const { index, at } of inserts) lines.splice(at, 0, "", `<ArticleImage index={${index}} />`, "");
  return lines.join("\n");
}
