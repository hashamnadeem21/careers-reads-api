import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Injectable } from "@nestjs/common";
import { del, get, put } from "@vercel/blob";
import { env, isProduction } from "../config/env.js";

const KEY = /^[a-z]+\/\d{4}\/\d{2}\/[a-f0-9]{32}\.[a-z]{2,4}$/;

/**
 * Storage for files that must never be public (CVs). Nothing here has a public URL: the API
 * reads a file back only after checking who is asking.
 *  - PRIVATE_BLOB_READ_WRITE_TOKEN set → a private Vercel Blob store.
 *  - otherwise → PRIVATE_FILES_DIR on this server (development default: .data/private-files).
 */
@Injectable()
export class PrivateStorageService {
  private dir(): string {
    const { PRIVATE_FILES_DIR } = env();
    if (!PRIVATE_FILES_DIR && isProduction) {
      throw new Error("Private files need PRIVATE_BLOB_READ_WRITE_TOKEN or PRIVATE_FILES_DIR in production.");
    }
    return path.resolve(PRIVATE_FILES_DIR ?? ".data/private-files");
  }

  /** Where a key lives on disk. Keys are made here, but are checked anyway so a bad one can't escape the folder. */
  private filePath(key: string): string {
    if (!KEY.test(key)) throw new Error("Invalid private file key.");
    return path.join(this.dir(), key);
  }

  /** Saves the bytes under a new random key like "cv/2026/10/<32 hex>.pdf" and returns the key. */
  async store(folder: string, extension: string, bytes: Uint8Array, contentType: string): Promise<string> {
    const now = new Date();
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    const key = `${folder}/${now.getUTCFullYear()}/${month}/${randomBytes(16).toString("hex")}.${extension}`;
    const token = env().PRIVATE_BLOB_READ_WRITE_TOKEN;
    if (token) {
      await put(key, Buffer.from(bytes), { access: "private", contentType, addRandomSuffix: false, token });
      return key;
    }
    const file = this.filePath(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes, { flag: "wx" });
    return key;
  }

  /** The file's bytes, or null when it's gone. */
  async read(key: string): Promise<Buffer | null> {
    const token = env().PRIVATE_BLOB_READ_WRITE_TOKEN;
    if (token) {
      const result = await get(key, { access: "private", token });
      if (!result?.stream) return null;
      return Buffer.from(await new Response(result.stream).arrayBuffer());
    }
    try {
      return await readFile(this.filePath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Deletes the file. A file that's already gone is fine. */
  async remove(key: string): Promise<void> {
    const token = env().PRIVATE_BLOB_READ_WRITE_TOKEN;
    if (token) {
      await del(key, { token });
      return;
    }
    await unlink(this.filePath(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
