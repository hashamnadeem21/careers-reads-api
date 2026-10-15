import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { hashToken } from "../auth/sessions.service.js";
import type { Database } from "../db/client.js";
import { candidateTokens } from "../db/schema.js";

/**
 * One-time links emailed to candidates (confirm email, reset password). Plain functions on the
 * database so both the candidates module and the automation sender can use them.
 */
export type CandidateTokenKind = "confirm_email" | "reset_password";

export const CONFIRM_EMAIL_TTL_MS = 7 * 86_400_000;
export const RESET_PASSWORD_TTL_MS = 60 * 60_000;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;

/** A new link token. Older unused tokens of the same kind for this candidate stop working. */
export async function createCandidateToken(
  db: Database,
  candidateId: string,
  kind: CandidateTokenKind,
  ttlMs: number,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    await tx
      .delete(candidateTokens)
      .where(and(eq(candidateTokens.candidateId, candidateId), eq(candidateTokens.kind, kind), isNull(candidateTokens.usedAt)));
    await tx.insert(candidateTokens).values({ tokenHash: hashToken(token), candidateId, kind, expiresAt: new Date(Date.now() + ttlMs) });
  });
  return token;
}

/** Uses up a token: returns its candidate once, then null forever (also null when expired or unknown). */
export async function consumeCandidateToken(db: Database, token: string, kind: CandidateTokenKind): Promise<string | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const [row] = await db
    .update(candidateTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(candidateTokens.tokenHash, hashToken(token)),
        eq(candidateTokens.kind, kind),
        isNull(candidateTokens.usedAt),
        gt(candidateTokens.expiresAt, new Date()),
      ),
    )
    .returning({ candidateId: candidateTokens.candidateId });
  return row?.candidateId ?? null;
}
