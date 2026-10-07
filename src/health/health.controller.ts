import { Controller, Get, HttpStatus } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { ApiError } from "../common/api-error.js";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(@InjectDb() private readonly db: Database) {}

  /** For the host's health check: 200 when the API can reach the database, 503 otherwise. */
  @Get()
  @ApiOkResponse({ schema: { example: { status: "ok", database: "ok" } } })
  async check(): Promise<{ status: "ok"; database: "ok" }> {
    try {
      await this.db.execute(sql`select 1`);
    } catch {
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, "database_unavailable", "The database is not reachable.");
    }
    return { status: "ok", database: "ok" };
  }
}
