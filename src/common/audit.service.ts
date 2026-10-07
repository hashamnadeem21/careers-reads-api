import { Injectable, Logger } from "@nestjs/common";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { auditLog } from "../db/schema.js";

export type AuditEntity =
  "job" | "post" | "category" | "author" | "media" | "settings" | "user" | "message" | "subscriber" | "company";

@Injectable()
export class AuditService {
  private readonly logger = new Logger("Audit");

  constructor(@InjectDb() private readonly db: Database) {}

  /** Records who changed what ("Hasham published Frontend Developer"). Never throws into the caller. */
  async log(
    user: { id: string },
    action: string,
    entity: AuditEntity,
    entitySlug?: string | null,
    label?: string | null,
  ): Promise<void> {
    try {
      await this.db
        .insert(auditLog)
        .values({ userId: user.id, action, entity, entitySlug: entitySlug ?? null, label: label ?? null });
    } catch (error) {
      this.logger.error(`Could not write audit log: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
