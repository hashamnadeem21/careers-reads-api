import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import { getDummyHash, hashPassword, verifyPassword } from "../auth/password.js";
import { AutomationQueue } from "../automations/automation-queue.service.js";
import { ApiError } from "../common/api-error.js";
import { limitKey, RateLimitService } from "../common/rate-limit.service.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import {
  type CandidateAuthMethod,
  type CandidateEventKind,
  type CandidateRow,
  applications,
  candidateEvents,
  candidates,
  subscribers,
} from "../db/schema.js";
import { MailerService, type OutgoingEmail } from "../mail/mailer.service.js";
import { confirmEmailEmail, confirmEmailLink, resetPasswordEmail, resetPasswordLink } from "./candidate-emails.js";
import { type CandidateSession, CandidateSessionsService } from "./candidate-sessions.service.js";
import {
  CONFIRM_EMAIL_TTL_MS,
  consumeCandidateToken,
  createCandidateToken,
  RESET_PASSWORD_TTL_MS,
} from "./candidate-tokens.js";
import type { candidateLoginSchema, signupSchema } from "./candidates.schemas.js";
import { GoogleVerifier } from "./google-verifier.service.js";

/** What the website gets about the signed-in candidate. */
export interface PublicCandidate {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  emailVerified: boolean;
  signupMethod: CandidateAuthMethod;
  hasPassword: boolean;
  subscribed: boolean;
}

export type CandidateSignedIn = { session: CandidateSession; candidate: PublicCandidate; created: boolean };

const WRONG_PASSWORD =
  "That email and password don't match. If you signed up with Google, use “Continue with Google” instead.";
const BAD_LINK = "This link has expired or was already used. Please ask for a new one.";
const isProduction = () => process.env.NODE_ENV === "production";

/**
 * Candidate accounts on the website: Google sign-in, email + password sign-up and sign-in,
 * confirm email, reset password. Separate from staff `users` and their sessions.
 */
@Injectable()
export class CandidateAuthService {
  private readonly logger = new Logger("CandidateAuth");

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly sessions: CandidateSessionsService,
    private readonly rateLimits: RateLimitService,
    private readonly google: GoogleVerifier,
    private readonly automations: AutomationQueue,
    private readonly mailer: MailerService,
  ) {}

  // ---------------------------------------------------------------- sign-in methods

  /** "Continue with Google": signs in, links an existing applicant/account by email, or creates one. */
  async withGoogle(ip: string, credential: string): Promise<CandidateSignedIn> {
    await this.limitSignIn(ip);
    if (!this.google.enabled()) {
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, "google_disabled", "Google sign-in isn't available right now.");
    }
    const profile = await this.google.verify(credential);
    if (!profile) {
      throw new ApiError(HttpStatus.UNAUTHORIZED, "invalid_google_token", "Google sign-in didn't work. Please try again.");
    }

    const now = new Date();
    const result = await this.db.transaction(async (tx) => {
      const [bySub] = await tx.select().from(candidates).where(eq(candidates.googleSub, profile.sub)).limit(1);
      const existing =
        bySub ?? (await tx.select().from(candidates).where(eq(candidates.email, profile.email)).limit(1))[0];

      if (!existing) {
        const [created] = await tx
          .insert(candidates)
          .values({
            email: profile.email,
            name: profile.name,
            googleSub: profile.sub,
            avatarUrl: profile.picture,
            emailVerifiedAt: now,
            termsAcceptedAt: now,
            signupMethod: "google",
            accountCreatedAt: now,
            lastSignInAt: now,
            signInCount: 1,
          })
          .returning();
        return { candidate: created, created: true, revokeOthers: false };
      }

      const created = existing.accountCreatedAt === null;
      // Someone may have made a password account with this email without owning it (never confirmed).
      // Google proves ownership, so that password stops working and its sessions end.
      const squatted = Boolean(existing.passwordHash) && !existing.emailVerifiedAt && existing.googleSub === null;
      const [updated] = await tx
        .update(candidates)
        .set({
          googleSub: profile.sub,
          avatarUrl: profile.picture ?? existing.avatarUrl,
          emailVerifiedAt: existing.emailVerifiedAt ?? now,
          termsAcceptedAt: existing.termsAcceptedAt ?? now,
          ...(created ? { signupMethod: "google" as const, accountCreatedAt: now } : {}),
          ...(squatted ? { passwordHash: null } : {}),
          lastSignInAt: now,
          signInCount: sql`${candidates.signInCount} + 1`,
          updatedAt: now,
        })
        .where(eq(candidates.id, existing.id))
        .returning();
      return { candidate: updated, created, revokeOthers: squatted };
    });

    if (result.revokeOthers) {
      // Applications sent from the unconfirmed account were made in this person's name by someone
      // else: they never go to an employer.
      await this.sessions.revokeAll(result.candidate.id);
      await this.db
        .delete(applications)
        .where(and(eq(applications.candidateId, result.candidate.id), eq(applications.awaitingConfirmation, true)));
    } else {
      await this.releaseHeldApplications(result.candidate.id);
    }
    await this.event(result.candidate.id, result.created ? "signed_up" : "signed_in", "google");
    if (result.created) await this.automations.candidateSignedUp(result.candidate.id);
    return this.signedIn(result.candidate, result.created);
  }

  /** "Create account": name, email, password and the Terms checkbox. */
  async signUp(ip: string, input: z.infer<typeof signupSchema>): Promise<CandidateSignedIn> {
    await this.limitSignIn(ip, input.email);
    const now = new Date();
    const passwordHash = await hashPassword(input.password);
    const account = {
      name: input.name,
      passwordHash,
      termsAcceptedAt: now,
      signupMethod: "password" as const,
      accountCreatedAt: now,
      lastSignInAt: now,
      signInCount: 1,
      updatedAt: now,
    };

    const [existing] = await this.db.select().from(candidates).where(eq(candidates.email, input.email)).limit(1);
    if (existing?.accountCreatedAt) throw this.accountExists();

    let candidate: CandidateRow | undefined;
    if (existing) {
      // Someone who applied before accounts existed: their account starts from that record.
      [candidate] = await this.db
        .update(candidates)
        .set(account)
        .where(and(eq(candidates.id, existing.id), isNull(candidates.accountCreatedAt)))
        .returning();
    } else {
      [candidate] = await this.db
        .insert(candidates)
        .values({ email: input.email, ...account })
        .onConflictDoNothing({ target: candidates.email })
        .returning();
    }
    if (!candidate) throw this.accountExists(); // lost a race with another sign-up for this email

    await this.event(candidate.id, "signed_up", "password");
    const queued = await this.automations.candidateSignedUp(candidate.id);
    // The welcome email carries the "Confirm your email" button. Without one switched on, send just the confirmation.
    if (queued === 0) await this.sendConfirmation(candidate);
    return this.signedIn(candidate, true);
  }

  /** "Sign in" with email and password. */
  async signIn(ip: string, input: z.infer<typeof candidateLoginSchema>): Promise<CandidateSignedIn> {
    const [byIp, byEmail] = await Promise.all([
      this.rateLimits.hit(limitKey("candidate-login-ip", ip), 10, 900),
      this.rateLimits.hit(limitKey("candidate-login-email", input.email), 10, 900),
    ]);
    if (!byIp.allowed || !byEmail.allowed) {
      throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, "rate_limited", "Too many sign-in attempts. Please wait 15 minutes and try again.");
    }
    const [candidate] = await this.db.select().from(candidates).where(eq(candidates.email, input.email)).limit(1);
    // Always verify against a hash so timing doesn't reveal which emails have accounts.
    const valid = await verifyPassword(candidate?.passwordHash ?? (await getDummyHash()), input.password);
    if (!candidate?.passwordHash || !valid) throw new ApiError(HttpStatus.UNAUTHORIZED, "invalid_credentials", WRONG_PASSWORD);

    await this.rateLimits.clear(limitKey("candidate-login-email", input.email));
    const [updated] = await this.db
      .update(candidates)
      .set({ lastSignInAt: new Date(), signInCount: sql`${candidates.signInCount} + 1` })
      .where(eq(candidates.id, candidate.id))
      .returning();
    await this.event(candidate.id, "signed_in", "password");
    return this.signedIn(updated, false);
  }

  async signOut(candidate: CandidateRow, token: string): Promise<void> {
    await this.sessions.revoke(token);
    await this.event(candidate.id, "signed_out", null);
  }

  // ---------------------------------------------------------------- passwords and email

  /** Emails a reset link when the address has an account. Always the same answer, so nobody can probe for accounts. */
  async forgotPassword(ip: string, email: string): Promise<void> {
    await this.rateLimits.enforce(limitKey("candidate-forgot-ip", ip), 10, 3600, "Too many requests. Please try again later.");
    const byEmail = await this.rateLimits.hit(limitKey("candidate-forgot-email", email), 3, 3600);
    if (!byEmail.allowed) return; // quietly: the inbox already has recent links
    const [candidate] = await this.db.select().from(candidates).where(eq(candidates.email, email)).limit(1);
    if (!candidate?.accountCreatedAt) return;
    const token = await createCandidateToken(this.db, candidate.id, "reset_password", RESET_PASSWORD_TTL_MS);
    await this.send(resetPasswordEmail(candidate, resetPasswordLink(token)), "reset link", resetPasswordLink(token));
  }

  /** Sets a new password from a reset link, ends every other session and signs in. */
  async resetPassword(ip: string, token: string, password: string): Promise<CandidateSignedIn> {
    await this.rateLimits.enforce(limitKey("candidate-reset-ip", ip), 20, 3600, "Too many attempts. Please try again later.");
    const candidateId = await consumeCandidateToken(this.db, token, "reset_password");
    if (!candidateId) throw new ApiError(HttpStatus.BAD_REQUEST, "invalid_token", BAD_LINK);
    const now = new Date();
    const [candidate] = await this.db
      .update(candidates)
      .set({
        passwordHash: await hashPassword(password),
        // Opening the link proves they own the inbox.
        emailVerifiedAt: sql`coalesce(${candidates.emailVerifiedAt}, ${now.toISOString()}::timestamptz)`,
        lastSignInAt: now,
        signInCount: sql`${candidates.signInCount} + 1`,
        updatedAt: now,
      })
      .where(eq(candidates.id, candidateId))
      .returning();
    await this.sessions.revokeAll(candidateId);
    await this.event(candidateId, "password_reset", "password");
    await this.releaseHeldApplications(candidateId);
    return this.signedIn(candidate, false);
  }

  /** "Confirm your email" link. Works without being signed in (it may be opened on another device). */
  async confirmEmail(token: string): Promise<{ confirmed: true }> {
    const candidateId = await consumeCandidateToken(this.db, token, "confirm_email");
    if (!candidateId) throw new ApiError(HttpStatus.BAD_REQUEST, "invalid_token", BAD_LINK);
    const [updated] = await this.db
      .update(candidates)
      .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(candidates.id, candidateId), isNull(candidates.emailVerifiedAt)))
      .returning({ id: candidates.id });
    if (updated) await this.event(candidateId, "email_confirmed", null);
    await this.releaseHeldApplications(candidateId);
    return { confirmed: true };
  }

  /** "Resend confirmation email" for a signed-in candidate. */
  async resendConfirmation(candidate: CandidateRow): Promise<{ message: string }> {
    if (candidate.emailVerifiedAt) return { message: "Your email is already confirmed." };
    await this.rateLimits.enforce(
      limitKey("candidate-confirm-resend", candidate.id),
      3,
      3600,
      "We've sent a few emails already. Please check your inbox (and spam folder), or try again in an hour.",
    );
    await this.sendConfirmation(candidate);
    return { message: `We've sent a confirmation link to ${candidate.email}.` };
  }

  // ---------------------------------------------------------------- account

  async me(candidate: CandidateRow): Promise<PublicCandidate> {
    return this.publicCandidate(candidate);
  }

  /**
   * "Subscribe" after applying: their own email joins the newsletter list. No email is sent now
   * (they already got the account welcome), so the subscriber automations are not queued.
   */
  async subscribe(candidate: CandidateRow): Promise<{ subscribed: true }> {
    const [current] = await this.db
      .select({ unsubscribedAt: subscribers.unsubscribedAt })
      .from(subscribers)
      .where(eq(subscribers.email, candidate.email))
      .limit(1);
    if (current && !current.unsubscribedAt) return { subscribed: true };
    await this.db
      .insert(subscribers)
      .values({ email: candidate.email })
      .onConflictDoUpdate({ target: subscribers.email, set: { unsubscribedAt: null } });
    await this.event(candidate.id, "subscribed", null);
    return { subscribed: true };
  }

  /**
   * "Delete my account": the account, its sessions and history, and its applications (with their
   * CVs, removed by the files sweep), plus their newsletter subscription. Can't be undone.
   */
  async deleteAccount(candidate: CandidateRow): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(subscribers).where(eq(subscribers.email, candidate.email));
      await tx.delete(candidates).where(eq(candidates.id, candidate.id));
    });
    this.logger.log(`A candidate deleted their account (${candidate.signupMethod}).`);
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Once their email is confirmed, held applications go to the employers: visible from now, and
   * emailed by the scheduler (they count as sent now, so they're within its sending window).
   */
  private async releaseHeldApplications(candidateId: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(applications)
      .set({ awaitingConfirmation: false, createdAt: now, statusChangedAt: now, updatedAt: now })
      .where(and(eq(applications.candidateId, candidateId), eq(applications.awaitingConfirmation, true)));
  }


  private async signedIn(candidate: CandidateRow, created: boolean): Promise<CandidateSignedIn> {
    const session = await this.sessions.issue(candidate.id);
    return { session, candidate: await this.publicCandidate(candidate), created };
  }

  private async publicCandidate(candidate: CandidateRow): Promise<PublicCandidate> {
    const [subscriber] = await this.db
      .select({ unsubscribedAt: subscribers.unsubscribedAt })
      .from(subscribers)
      .where(eq(subscribers.email, candidate.email))
      .limit(1);
    return {
      id: candidate.id,
      name: candidate.name,
      email: candidate.email,
      avatarUrl: candidate.avatarUrl,
      emailVerified: candidate.emailVerifiedAt !== null,
      signupMethod: candidate.signupMethod,
      hasPassword: candidate.passwordHash !== null,
      subscribed: Boolean(subscriber && !subscriber.unsubscribedAt),
    };
  }

  private async event(candidateId: string, kind: CandidateEventKind, method: CandidateAuthMethod | null): Promise<void> {
    await this.db.insert(candidateEvents).values({ candidateId, kind, method });
  }

  private async limitSignIn(ip: string, email?: string): Promise<void> {
    const checks = [this.rateLimits.hit(limitKey("candidate-signin-ip", ip), 10, 600)];
    if (email) checks.push(this.rateLimits.hit(limitKey("candidate-signup-email", email), 5, 600));
    if ((await Promise.all(checks)).some((result) => !result.allowed)) {
      throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, "rate_limited", "Too many attempts. Please wait a few minutes and try again.");
    }
  }

  private accountExists(): ApiError {
    return new ApiError(
      HttpStatus.CONFLICT,
      "account_exists",
      "You already have an account with this email. Sign in, continue with Google, or reset your password.",
      { email: "You already have an account with this email" },
    );
  }

  private async sendConfirmation(candidate: CandidateRow): Promise<void> {
    const link = confirmEmailLink(await createCandidateToken(this.db, candidate.id, "confirm_email", CONFIRM_EMAIL_TTL_MS));
    await this.send(confirmEmailEmail(candidate, link), "confirmation link", link);
  }

  /** Sends one account email. Without email set up, development logs the link so you can still test. */
  private async send(email: OutgoingEmail, what: string, link: string): Promise<void> {
    const missing = this.mailer.missingConfig();
    if (missing) {
      if (isProduction()) this.logger.error(`Couldn't send a ${what}: email isn't set up (${missing}).`);
      else this.logger.warn(`Email isn't set up (${missing}). ${what} for ${email.to}: ${link}`);
      return;
    }
    const result = await this.mailer.sendBatch([email]);
    if (!result.ok) this.logger.warn(`Couldn't send a ${what} to ${email.to}: ${result.error}`);
  }
}
