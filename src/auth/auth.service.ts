import { HttpStatus, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { ApiError } from "../common/api-error.js";
import { limitKey, RateLimitService } from "../common/rate-limit.service.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { companies, users } from "../db/schema.js";
import { type AuthUser, publicUser } from "./auth-user.js";
import type { changePasswordSchema, loginSchema } from "./auth.schemas.js";
import { getDummyHash, hashPassword, verifyPassword } from "./password.js";
import { SessionsService, type TokenPair } from "./sessions.service.js";

export type SignedIn = TokenPair & { user: ReturnType<typeof publicUser> };

const GENERIC_ERROR = "That email and password don't match.";
export const PAUSED_MESSAGE = "This company account is paused. Contact Career Reads for help.";

@Injectable()
export class AuthService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly sessions: SessionsService,
    private readonly rateLimits: RateLimitService,
  ) {}

  /** Starts a session and returns the tokens with the user they belong to. */
  async signIn(userId: string): Promise<SignedIn> {
    const tokens = await this.sessions.issue(userId);
    const user = await this.sessions.authenticate(tokens.accessToken);
    if (!user) throw new ApiError(HttpStatus.FORBIDDEN, "company_paused", PAUSED_MESSAGE);
    return { ...tokens, user: publicUser(user) };
  }

  async login({ email, password }: z.infer<typeof loginSchema>, ip: string): Promise<SignedIn> {
    // 10 attempts per 15 minutes per IP, and per account.
    const [byIp, byEmail] = await Promise.all([
      this.rateLimits.hit(limitKey("login-ip", ip), 10, 900),
      this.rateLimits.hit(limitKey("login-email", email), 10, 900),
    ]);
    if (!byIp.allowed || !byEmail.allowed) {
      throw new ApiError(
        HttpStatus.TOO_MANY_REQUESTS,
        "rate_limited",
        "Too many sign-in attempts. Please wait 15 minutes and try again.",
      );
    }

    const [user] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    const valid = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), password);
    if (!user || !valid) throw new ApiError(HttpStatus.UNAUTHORIZED, "invalid_credentials", GENERIC_ERROR);
    if (user.companyId) {
      const [company] = await this.db
        .select({ active: companies.active })
        .from(companies)
        .where(eq(companies.id, user.companyId))
        .limit(1);
      if (!company?.active) throw new ApiError(HttpStatus.FORBIDDEN, "company_paused", PAUSED_MESSAGE);
    }

    await this.rateLimits.clear(limitKey("login-email", email));
    return this.signIn(user.id);
  }

  async refresh(refreshToken: string): Promise<SignedIn> {
    const outcome = await this.sessions.rotate(refreshToken);
    if (outcome.kind !== "ok") {
      throw new ApiError(
        HttpStatus.UNAUTHORIZED,
        "invalid_refresh_token",
        "Your session has ended. Please sign in again.",
      );
    }
    const user = await this.sessions.authenticate(outcome.tokens.accessToken);
    if (!user) {
      await this.sessions.revoke(outcome.tokens.refreshToken);
      throw new ApiError(
        HttpStatus.UNAUTHORIZED,
        "invalid_refresh_token",
        "Your session has ended. Please sign in again.",
      );
    }
    return { ...outcome.tokens, user: publicUser(user) };
  }

  /** Signs out every other device and returns a fresh session for this one. */
  async changePassword(sessionUser: AuthUser, input: z.infer<typeof changePasswordSchema>): Promise<SignedIn> {
    await this.rateLimits.enforce(
      limitKey("password", sessionUser.id),
      10,
      900,
      "Too many attempts. Please wait a few minutes.",
    );
    const [user] = await this.db.select().from(users).where(eq(users.id, sessionUser.id)).limit(1);
    if (!user || !(await verifyPassword(user.passwordHash, input.current))) {
      throw new ApiError(HttpStatus.BAD_REQUEST, "validation_failed", "Some fields are invalid.", {
        current: "That isn't your current password",
      });
    }
    await this.db
      .update(users)
      .set({ passwordHash: await hashPassword(input.next), mustChangePassword: false })
      .where(eq(users.id, user.id));
    await this.sessions.revokeAll(user.id);
    return this.signIn(user.id);
  }
}
