import { createHash, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { and, eq, gt, inArray } from "drizzle-orm";
import { env } from "../config/env.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { companies, sessions, userPrefs, users } from "../db/schema.js";
import type { AuthUser } from "./auth-user.js";

/** How long a rotated refresh token keeps working, so parallel requests from the admin don't sign it out. */
export const REFRESH_GRACE_SECONDS = 30;

const ACCESS_AUDIENCE = "career-reads:access";
const REFRESH_AUDIENCE = "career-reads:refresh";
const ALGORITHM = "HS256";

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

interface AccessClaims {
  sub: string;
  sid: string;
}

interface RefreshClaims {
  sub: string;
  jti: string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type RefreshOutcome =
  | { kind: "ok"; userId: string; tokens: TokenPair }
  | { kind: "invalid" }
  /** A signed refresh token whose session is gone: it was stolen or replayed, so every session was revoked. */
  | { kind: "reused" };

/**
 * Sessions are rows in `sessions`, one per signed-in device. The row id is the SHA-256 of the
 * refresh token's `jti`, never the token itself. Access tokens name their session (`sid`), and
 * AuthGuard checks that row on every request, so revoking a session takes effect immediately.
 */
@Injectable()
export class SessionsService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly jwt: JwtService,
  ) {}

  /** Starts a new session for this user. */
  async issue(userId: string): Promise<TokenPair> {
    const { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_DAYS } = env();
    const jti = randomBytes(32).toString("base64url");
    const sessionId = hashToken(jti);
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 86_400_000);
    await this.db.insert(sessions).values({ id: sessionId, userId, expiresAt: refreshExpiresAt });

    const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync({ sid: sessionId } satisfies Omit<AccessClaims, "sub">, {
        subject: userId,
        audience: ACCESS_AUDIENCE,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        algorithm: ALGORITHM,
      }),
      this.jwt.signAsync({} satisfies Partial<RefreshClaims>, {
        subject: userId,
        jwtid: jti,
        audience: REFRESH_AUDIENCE,
        expiresIn: Math.floor((refreshExpiresAt.getTime() - Date.now()) / 1000),
        algorithm: ALGORITHM,
      }),
    ]);
    return {
      accessToken,
      accessTokenExpiresAt: accessExpiresAt.toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
    };
  }

  private async verifyRefresh(token: string): Promise<RefreshClaims | null> {
    try {
      const claims = await this.jwt.verifyAsync<RefreshClaims>(token, {
        audience: REFRESH_AUDIENCE,
        algorithms: [ALGORITHM],
      });
      return typeof claims.sub === "string" && typeof claims.jti === "string" ? claims : null;
    } catch {
      return null;
    }
  }

  /** Trades a refresh token for a new pair. The old one keeps working for REFRESH_GRACE_SECONDS. */
  async rotate(refreshToken: string): Promise<RefreshOutcome> {
    const claims = await this.verifyRefresh(refreshToken);
    if (!claims) return { kind: "invalid" };
    const sessionId = hashToken(claims.jti);
    const now = new Date();
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, claims.sub), gt(sessions.expiresAt, now)))
      .limit(1);
    if (!row) {
      await this.revokeAll(claims.sub);
      return { kind: "reused" };
    }
    const graceEnd = new Date(now.getTime() + REFRESH_GRACE_SECONDS * 1000);
    if (row.expiresAt > graceEnd) {
      await this.db.update(sessions).set({ expiresAt: graceEnd }).where(eq(sessions.id, sessionId));
    }
    return { kind: "ok", userId: claims.sub, tokens: await this.issue(claims.sub) };
  }

  /** Ends the session a refresh token belongs to. Unknown or invalid tokens are ignored. */
  async revoke(refreshToken: string): Promise<void> {
    const claims = await this.verifyRefresh(refreshToken);
    if (claims) await this.db.delete(sessions).where(eq(sessions.id, hashToken(claims.jti)));
  }

  async revokeById(sessionId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, sessionId));
  }

  /** Signs users out everywhere (password change, removal, paused company). */
  async revokeAll(userIds: string | string[]): Promise<void> {
    const ids = Array.isArray(userIds) ? userIds : [userIds];
    if (ids.length) await this.db.delete(sessions).where(inArray(sessions.userId, ids));
  }

  /**
   * The user behind an access token, or null. Looked up in the database on every request, so
   * role changes, removals, revoked sessions and paused companies take effect immediately.
   */
  async authenticate(accessToken: string): Promise<AuthUser | null> {
    let claims: AccessClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessClaims>(accessToken, {
        audience: ACCESS_AUDIENCE,
        algorithms: [ALGORITHM],
      });
    } catch {
      return null;
    }
    if (typeof claims.sub !== "string" || typeof claims.sid !== "string") return null;
    return this.loadUser(claims.sub, claims.sid);
  }

  async loadUser(userId: string, sessionId: string): Promise<AuthUser | null> {
    const [row] = await this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        mustChangePassword: users.mustChangePassword,
        companyId: users.companyId,
        companyName: companies.name,
        companyAutoPublish: companies.autoPublish,
        companyActive: companies.active,
        theme: userPrefs.theme,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .leftJoin(companies, eq(companies.id, users.companyId))
      .leftJoin(userPrefs, eq(userPrefs.userId, users.id))
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (!row) return null;
    const { companyActive, ...user } = row;
    // A company account whose company is missing or paused is treated as signed out.
    if (user.role === "company" && (!user.companyId || !companyActive)) return null;
    return {
      ...user,
      companyAutoPublish: user.companyAutoPublish ?? false,
      theme: user.theme ?? "system",
      sessionId,
    };
  }
}
