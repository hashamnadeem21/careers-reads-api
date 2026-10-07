import { randomBytes } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Injectable } from "@nestjs/common";
import { del, put } from "@vercel/blob";
import { env, isProduction } from "../config/env.js";
import { type ImageType, safeBaseName } from "./validate.js";

const BLOB_URL = /^https:\/\/[^/]+\.public\.blob\.vercel-storage\.com\//;
const LOCAL_FILE = /^([a-z0-9-]+\.(?:jpg|png|webp|avif))$/;

/**
 * Where uploads live:
 *  - BLOB_READ_WRITE_TOKEN set → Vercel Blob (CDN, https URL). Required in production.
 *  - UPLOADS_PUBLIC_URL set → UPLOADS_DIR on this server, served by Nginx at that URL (self-hosted production).
 *  - otherwise → UPLOADS_DIR (the website's `public/uploads/`), served by the site as /uploads/…
 */
@Injectable()
export class MediaStorageService {
  async store(bytes: Uint8Array, fileName: string, type: ImageType, contentType: string): Promise<string> {
    const name = `${safeBaseName(fileName)}-${randomBytes(8).toString("hex")}.${type}`;
    const { BLOB_READ_WRITE_TOKEN, UPLOADS_DIR, UPLOADS_PUBLIC_URL, ALLOW_LOCAL_UPLOADS } = env();
    if (BLOB_READ_WRITE_TOKEN) {
      const blob = await put(`uploads/${name}`, Buffer.from(bytes), {
        access: "public",
        contentType,
        addRandomSuffix: false,
        token: BLOB_READ_WRITE_TOKEN,
        cacheControlMaxAge: 31_536_000,
      });
      return blob.url;
    }
    // Production needs Blob or a public URL for UPLOADS_DIR; plain local files are for development
    // (and e2e runs that opt in).
    if (isProduction && !UPLOADS_PUBLIC_URL && ALLOW_LOCAL_UPLOADS !== "true")
      throw new Error("Uploads need BLOB_READ_WRITE_TOKEN or UPLOADS_PUBLIC_URL in production.");
    const dir = path.resolve(UPLOADS_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), bytes);
    return `${UPLOADS_PUBLIC_URL ?? "/uploads"}/${name}`;
  }

  /** Deletes the stored file. Unknown URLs (e.g. images that shipped with the site) are left alone. */
  async remove(url: string): Promise<void> {
    const { BLOB_READ_WRITE_TOKEN, UPLOADS_DIR, UPLOADS_PUBLIC_URL } = env();
    if (BLOB_URL.test(url)) {
      if (BLOB_READ_WRITE_TOKEN) await del(url, { token: BLOB_READ_WRITE_TOKEN });
      return;
    }
    const prefix = [UPLOADS_PUBLIC_URL, "/uploads"].find((base) => base && url.startsWith(`${base}/`));
    const match = prefix ? LOCAL_FILE.exec(url.slice(prefix.length + 1)) : null;
    if (match) await unlink(path.resolve(UPLOADS_DIR, match[1])).catch(() => {});
  }
}
