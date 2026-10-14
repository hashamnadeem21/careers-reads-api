import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { and, eq, lt, notExists, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { applications, type PrivateFileRow, privateFiles } from "../db/schema.js";
import { type CvType, downloadName } from "./cv-file.js";
import { PrivateStorageService } from "./private-storage.service.js";

/** How long an unreferenced file is kept (an application still being saved, say) before the sweep deletes it. */
const ORPHAN_GRACE_MINUTES = 60;

/**
 * The `private_files` table and its storage, kept in step. Deleting an application only removes
 * database rows; `sweep()` then deletes every file nothing points at, from storage and table.
 */
@Injectable()
export class PrivateFilesService {
  private readonly logger = new Logger("PrivateFiles");

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly storage: PrivateStorageService,
  ) {}

  /** Stores an already-checked CV and records it. */
  async saveCv(bytes: Uint8Array, originalName: string, type: CvType, contentType: string): Promise<PrivateFileRow> {
    const key = await this.storage.store("cv", type, bytes, contentType);
    try {
      const [row] = await this.db
        .insert(privateFiles)
        .values({
          storageKey: key,
          originalName: downloadName(originalName, type),
          contentType,
          sizeBytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        })
        .returning();
      return row;
    } catch (error) {
      await this.storage.remove(key).catch(() => undefined);
      throw error;
    }
  }

  async get(id: string): Promise<PrivateFileRow | null> {
    const [row] = await this.db.select().from(privateFiles).where(eq(privateFiles.id, id)).limit(1);
    return row ?? null;
  }

  read(row: PrivateFileRow): Promise<Buffer | null> {
    return this.storage.read(row.storageKey);
  }

  /** Deletes up to `limit` files that no application uses any more. Returns how many went. */
  async sweep(now = new Date(), limit = 200): Promise<number> {
    const cutoff = new Date(now.getTime() - ORPHAN_GRACE_MINUTES * 60_000);
    const orphans = await this.db
      .select({ id: privateFiles.id, storageKey: privateFiles.storageKey })
      .from(privateFiles)
      .where(
        and(
          lt(privateFiles.createdAt, cutoff),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(applications)
              .where(eq(applications.resumeFileId, privateFiles.id)),
          ),
        ),
      )
      .limit(limit);
    let removed = 0;
    for (const file of orphans) {
      try {
        await this.storage.remove(file.storageKey);
        await this.db.delete(privateFiles).where(eq(privateFiles.id, file.id));
        removed++;
      } catch (error) {
        this.logger.error(`Couldn't delete ${file.storageKey}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return removed;
  }
}
