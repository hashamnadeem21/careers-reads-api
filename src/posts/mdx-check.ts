import { compile } from "@mdx-js/mdx";
import remarkGfm from "remark-gfm";
import { remarkSafeMdx, UnsafeMdxError } from "../shared/content/safe-mdx.js";

/**
 * Compiles the body the way the site does, so problems surface on save instead of
 * on the live page: syntax errors, and anything remarkSafeMdx would strip.
 */
export async function checkMdxBody(body: string): Promise<string | null> {
  try {
    await compile(body, { remarkPlugins: [remarkGfm, [remarkSafeMdx, { mode: "error" }]] });
    return null;
  } catch (error) {
    if (error instanceof UnsafeMdxError) return error.problems.slice(0, 3).join(" ");
    const message = error instanceof Error ? error.message : String(error);
    return `This post has a formatting problem: ${message.split("\n")[0]}`;
  }
}
