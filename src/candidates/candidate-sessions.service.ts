import { randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { hashToken } from "../auth/sessions.service.js";
import { env } from "../config/env.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { type CandidateRow, candidateSessions, candidates, candidateTokens } from "../db/schema.js";

export interface CandidateSession {
  /** Opaque; the website keeps it in an httpOnly cookie. Only its SHA-256 is stored. */
  token: string;
  expiresAt: string;
}

/** last_used_at is only rewritten once an hour, not on every request. */
const TOUCH_AFTER_MS = 60 * 60_000;

/**
 * Candidate sessions are opaque random tokens (not JWTs), stored hashed in their own table.
 * Staff routes only accept staff JWTs, so a candidate token can never open the admin.
 */
@Injectable()
export class CandidateSessionsService {
  constructor(@InjectDb() private readonly db: Database) {}

  async issue(candidateId: string): Promise<CandidateSession> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + env().CANDIDATE_SESSION_DAYS * 86_400_000);
    await this.db.insert(candidateSessions).values({ id: hashToken(token), candidateId, expiresAt });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  /** The signed-in candidate, or null for a missing, unknown or expired token. */
  async authenticate(token: string): Promise<CandidateRow | null> {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return null;
    const now = new Date();
    const [row] = await this.db
      .select({ candidate: candidates, lastUsedAt: candidateSessions.lastUsedAt, id: candidateSessions.id })
      .from(candidateSessions)
      .innerJoin(candidates, eq(candidates.id, candidateSessions.candidateId))
      .where(and(eq(candidateSessions.id, hashToken(token)), gt(candidateSessions.expiresAt, now)))
      .limit(1);
    if (!row) return null;
    if (now.getTime() - row.lastUsedAt.getTime() > TOUCH_AFTER_MS) {
      await this.db.update(candidateSessions).set({ lastUsedAt: now }).where(eq(candidateSessions.id, row.id));
    }
    return row.candidate;
  }

  async revoke(token: string): Promise<void> {
    await this.db.delete(candidateSessions).where(eq(candidateSessions.id, hashToken(token)));
  }

  async revokeAll(candidateId: string): Promise<void> {
    await this.db.delete(candidateSessions).where(eq(candidateSessions.candidateId, candidateId));
  }

  /** Housekeeping for the scheduler: expired sessions and old tokens. */
  async sweep(now = new Date()): Promise<void> {
    await this.db.delete(candidateSessions).where(lt(candidateSessions.expiresAt, now));
    await this.db
      .delete(candidateTokens)
      .where(lt(candidateTokens.expiresAt, sql`${now.toISOString()}::timestamptz - interval '7 days'`));
  }
}
