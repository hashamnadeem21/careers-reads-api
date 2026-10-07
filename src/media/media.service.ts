import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { count, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { AuthUser } from "../auth/auth-user.js";
import { ApiError } from "../common/api-error.js";
import { AuditService } from "../common/audit.service.js";
import { RateLimitService } from "../common/rate-limit.service.js";
import { escapeLike } from "../common/slug.js";
import { env } from "../config/env.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { articles, authors, media, type MediaRow } from "../db/schema.js";
import type { MediaListQuery } from "./media.schemas.js";
import { MediaStorageService } from "./media-storage.service.js";
import { checkImage, MAX_FILES_PER_UPLOAD } from "./validate.js";

export const MEDIA_PAGE_SIZE = 48;

export interface MediaItem {
  id: string;
  url: string;
  /** Absolute URL for <img> in the admin (site-relative uploads resolve to the public site). */
  previewUrl: string;
  alt: string;
  width: number;
  height: number;
  sizeBytes: number;
  createdAt: string;
}

export interface MediaUsage {
  kind: "post" | "author";
  slug: string;
  title: string;
  where: string;
  href: string;
}

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

export interface UploadResult {
  uploaded: MediaItem[];
  /** Files that were refused, with the reason (the others are still uploaded). */
  errors: { name: string; error: string }[];
}

export function toMediaItem(row: MediaRow): MediaItem {
  return {
    id: row.id,
    url: row.url,
    previewUrl: row.url.startsWith("/") ? `${env().PUBLIC_SITE_URL}${row.url}` : row.url,
    alt: row.alt,
    width: row.width,
    height: row.height,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

const notFound = () => new ApiError(HttpStatus.NOT_FOUND, "not_found", "This image was already deleted.");

/** The media library. Staff only. */
@Injectable()
export class MediaService {
  private readonly logger = new Logger("Media");

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
    private readonly storage: MediaStorageService,
  ) {}

  async list({ q, page }: MediaListQuery) {
    const where = q ? or(ilike(media.alt, `%${escapeLike(q)}%`), ilike(media.url, `%${escapeLike(q)}%`)) : undefined;
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(media)
        .where(where)
        .orderBy(desc(media.createdAt))
        .limit(MEDIA_PAGE_SIZE)
        .offset((page - 1) * MEDIA_PAGE_SIZE),
      this.db.select({ total: count() }).from(media).where(where),
    ]);
    return { items: rows.map(toMediaItem), total, page, pageSize: MEDIA_PAGE_SIZE };
  }

  private async load(id: string): Promise<MediaRow> {
    const [row] = await this.db.select().from(media).where(eq(media.id, id)).limit(1);
    if (!row) throw notFound();
    return row;
  }

  /** Each file is checked by its bytes. Bad files are reported; the rest are still saved. */
  async upload(user: AuthUser, files: UploadedFile[], alt: string): Promise<UploadResult> {
    await this.rateLimit.enforce(`upload:${user.id}`, 60, 600, "Too many uploads. Please wait a few minutes.");
    const result: UploadResult = { uploaded: [], errors: [] };
    for (const file of files.filter((f) => f.size > 0).slice(0, MAX_FILES_PER_UPLOAD)) {
      const bytes = new Uint8Array(file.buffer);
      const check = checkImage(bytes);
      if (!check.ok) {
        result.errors.push({ name: file.originalname, error: check.error });
        continue;
      }
      try {
        const url = await this.storage.store(bytes, file.originalname, check.type, check.contentType);
        const [row] = await this.db
          .insert(media)
          .values({
            url,
            alt,
            width: check.width,
            height: check.height,
            sizeBytes: bytes.byteLength,
            uploadedBy: user.id,
          })
          .returning();
        result.uploaded.push(toMediaItem(row));
        await this.audit.log(user, "uploaded", "media", row.id, file.originalname.slice(0, 80));
      } catch (error) {
        this.logger.error(`Upload failed: ${error instanceof Error ? error.message : String(error)}`);
        result.errors.push({ name: file.originalname, error: "Couldn't save this image. Try again." });
      }
    }
    return result;
  }

  async updateAlt(id: string, alt: string): Promise<{ message: string; item: MediaItem }> {
    const [row] = await this.db.update(media).set({ alt }).where(eq(media.id, id)).returning();
    if (!row) throw notFound();
    return { message: "Alt text saved.", item: toMediaItem(row) };
  }

  async usageOf(id: string): Promise<MediaUsage[]> {
    return this.usage((await this.load(id)).url);
  }

  /** Every post (hero, extra images or body) and author photo that uses this image. */
  async usage(url: string): Promise<MediaUsage[]> {
    const pattern = `%${escapeLike(url)}%`;
    const [posts, people] = await Promise.all([
      this.db
        .select({ slug: articles.slug, title: articles.title, cover: articles.coverImage, images: articles.images })
        .from(articles)
        .where(
          or(
            eq(articles.coverImage, url),
            sql`${articles.images} @> ${JSON.stringify([{ src: url }])}::jsonb`,
            ilike(articles.body, pattern),
          ),
        ),
      this.db.select({ slug: authors.slug, name: authors.name }).from(authors).where(eq(authors.avatar, url)),
    ]);
    return [
      ...posts.map((p) => ({
        kind: "post" as const,
        slug: p.slug,
        title: p.title,
        where: p.cover === url ? "Hero image" : p.images.some((i) => i.src === url) ? "In-post image" : "Post body",
        href: `/posts/${p.slug}`,
      })),
      ...people.map((a) => ({
        kind: "author" as const,
        slug: a.slug,
        title: a.name,
        where: "Author photo",
        href: `/authors?edit=${a.slug}`,
      })),
    ];
  }

  /** Deletes an image only when no post or author uses it (409 `in_use` with the usage otherwise). */
  async remove(user: AuthUser, id: string): Promise<void> {
    const row = await this.load(id);
    const usage = await this.usage(row.url);
    if (usage.length) {
      throw new ApiError(
        HttpStatus.CONFLICT,
        "in_use",
        `Still used in ${usage.length} place${usage.length === 1 ? "" : "s"}. Replace it there first.`,
        undefined,
        { usage },
      );
    }
    await this.db.delete(media).where(eq(media.id, row.id));
    await this.storage.remove(row.url);
    await this.audit.log(user, "deleted", "media", null, row.url.split("/").pop());
  }
}
