import { randomBytes } from "node:crypto";
import { HttpStatus, Injectable } from "@nestjs/common";
import { and, eq, gt } from "drizzle-orm";
import { ApiError } from "../common/api-error.js";
import { AuditService } from "../common/audit.service.js";
import { limitKey, RateLimitService } from "../common/rate-limit.service.js";
import { env } from "../config/env.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { companies, invites, users, type Role } from "../db/schema.js";
import { roleLabels } from "../auth/auth-user.js";
import { AuthService, PAUSED_MESSAGE, type SignedIn } from "../auth/auth.service.js";
import { hashPassword } from "../auth/password.js";
import { hashToken, SessionsService } from "../auth/sessions.service.js";
import { MailerService } from "../mail/mailer.service.js";
import { inviteEmail } from "./invite-email.js";

const INVITE_DAYS = 7;

export interface InviteCreated {
  message: string;
  /** The one-time link, also emailed. It's only ever shown once: the database keeps a hash. */
  link: string;
  expiresAt: string;
  /** Whether the invite email went out. When false, `emailError` says why and the link must be sent by hand. */
  emailed: boolean;
  emailError?: string;
}

const looksLikeToken = (token: string) => token.length >= 20 && token.length <= 100;

@Injectable()
export class InvitesService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly audit: AuditService,
    private readonly rateLimits: RateLimitService,
    private readonly sessions: SessionsService,
    private readonly auth: AuthService,
    private readonly mailer: MailerService,
  ) {}

  /**
   * Creates a one-time invite link (valid 7 days) and emails it to them. The link is also returned
   * so it can be copied and sent another way; a failed email never fails the invite.
   * No permission check of its own: callers (users and companies controllers) check first.
   */
  async create(
    invitedBy: { id: string; name?: string },
    input: { email: string; name: string; role: Role; companyId: string | null },
  ): Promise<InviteCreated> {
    const { email, name, role, companyId } = input;
    const [existing] = await this.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) {
      throw new ApiError(HttpStatus.CONFLICT, "already_member", "That person already has an account.", {
        email: "Already has an account",
      });
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
    await this.db.transaction(async (tx) => {
      await tx.delete(invites).where(eq(invites.email, email)); // a new invite replaces older ones
      await tx
        .insert(invites)
        .values({ tokenHash: hashToken(token), email, name, role, companyId, invitedBy: invitedBy.id, expiresAt });
    });
    await this.audit.log(invitedBy, "invited", "user", null, `${name} (${roleLabels[role]})`);

    const link = `${env().ADMIN_URL}/invite/${token}`;
    const sent = await this.sendInvite({ email, name, role, companyId, link, expiresAt, inviterName: invitedBy.name });
    return {
      message: sent.ok
        ? `Invite emailed to ${email}. You can also copy the link below.`
        : `Invite created, but the email couldn't be sent. Copy the link below and send it to ${name}.`,
      link,
      expiresAt: expiresAt.toISOString(),
      emailed: sent.ok,
      ...(!sent.ok && { emailError: sent.error }),
    };
  }

  private async sendInvite(input: {
    email: string;
    name: string;
    role: Role;
    companyId: string | null;
    link: string;
    expiresAt: Date;
    inviterName?: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    const missing = this.mailer.missingConfig();
    if (missing) return { ok: false, error: `Email isn't set up on the server (${missing}).` };
    const companyName = input.companyId
      ? ((
          await this.db
            .select({ name: companies.name })
            .from(companies)
            .where(eq(companies.id, input.companyId))
            .limit(1)
        )[0]?.name ?? null)
      : null;
    const { PUBLIC_SITE_URL, NEWSLETTER_POSTAL_ADDRESS } = env();
    const email = inviteEmail(
      {
        to: input.email,
        name: input.name,
        inviterName: input.inviterName,
        companyName,
        roleLabel: roleLabels[input.role],
        link: input.link,
        expiresAt: input.expiresAt,
      },
      { siteUrl: PUBLIC_SITE_URL, postalAddress: NEWSLETTER_POSTAL_ADDRESS },
    );
    return this.mailer.sendBatch([email]);
  }

  async revoke(admin: { id: string }, email: string): Promise<void> {
    await this.db.delete(invites).where(eq(invites.email, email));
    await this.audit.log(admin, "revoked invite", "user", null, email);
  }

  /** What the invite page shows. Null when the link is unknown, used or expired. */
  async lookup(token: string) {
    if (!looksLikeToken(token)) return null;
    const [invite] = await this.db
      .select({ email: invites.email, name: invites.name, role: invites.role, companyName: companies.name })
      .from(invites)
      .leftJoin(companies, eq(companies.id, invites.companyId))
      .where(and(eq(invites.tokenHash, hashToken(token)), gt(invites.expiresAt, new Date())))
      .limit(1);
    return invite ?? null;
  }

  /** The invited person picks a password, the invite is used up, and they're signed in. */
  async accept(token: string, input: { name: string; password: string }): Promise<SignedIn> {
    await this.rateLimits.enforce(
      limitKey("invite", token.slice(0, 16)),
      10,
      900,
      "Too many attempts. Please wait a few minutes.",
    );
    const expired = new ApiError(
      HttpStatus.NOT_FOUND,
      "invite_invalid",
      "This invite link has expired or was already used. Ask an admin for a new one.",
    );
    if (!looksLikeToken(token)) throw expired;

    const [invite] = await this.db
      .select()
      .from(invites)
      .where(and(eq(invites.tokenHash, hashToken(token)), gt(invites.expiresAt, new Date())))
      .limit(1);
    if (!invite) throw expired;
    if (invite.companyId) {
      const [company] = await this.db
        .select({ active: companies.active })
        .from(companies)
        .where(eq(companies.id, invite.companyId))
        .limit(1);
      if (!company?.active) throw new ApiError(HttpStatus.FORBIDDEN, "company_paused", PAUSED_MESSAGE);
    }

    const [existing] = await this.db.select({ id: users.id }).from(users).where(eq(users.email, invite.email)).limit(1);
    if (existing) {
      await this.db.delete(invites).where(eq(invites.tokenHash, invite.tokenHash));
      throw new ApiError(
        HttpStatus.CONFLICT,
        "already_member",
        "An account with this email already exists. Sign in instead.",
      );
    }
    const passwordHash = await hashPassword(input.password);
    const [user] = await this.db.transaction(async (tx) => {
      await tx.delete(invites).where(eq(invites.tokenHash, invite.tokenHash)); // one-time
      return tx
        .insert(users)
        .values({
          email: invite.email,
          name: input.name,
          role: invite.role,
          companyId: invite.companyId,
          passwordHash,
          mustChangePassword: false,
        })
        .returning();
    });
    await this.sessions.revokeAll(user.id);
    await this.audit.log(user, "joined", "user", null, `${user.name} (${roleLabels[user.role]})`);
    return this.auth.signIn(user.id);
  }
}
