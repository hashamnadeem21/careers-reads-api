import { like } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Database } from "../db/client.js";

/** "UI/UX Designer at Acme & Sons" → "ui-ux-designer-at-acme-and-sons" (max 80 characters). */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

/** Escapes `%`, `_` and `\` for use inside an ILIKE pattern. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The first free "<slug>-copy", "<slug>-copy-2", … in `table`. */
export async function copySlug(db: Database, table: PgTable, column: PgColumn, slug: string): Promise<string> {
  const base = `${slug.slice(0, 90)}-copy`;
  const rows = await db
    .select({ slug: column })
    .from(table)
    .where(like(column, `${escapeLike(base)}%`));
  const taken = new Set(rows.map((r) => String(r.slug)));
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}
