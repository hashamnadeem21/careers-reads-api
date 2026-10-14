import { Injectable, Logger } from "@nestjs/common";
import { env } from "../config/env.js";

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  /** Where replies go instead of NEWSLETTER_REPLY_TO (e.g. the candidate, on an application alert). */
  replyTo?: string;
}

export type BatchResult = { ok: true } | { ok: false; error: string };

/**
 * Resend's errors in plain words where they're confusing. The shared test sender (…@resend.dev)
 * can only email the Resend account's own address, but Resend reports that as an "invalid `to`".
 */
export function explainResendError(message: string, from: string): string {
  if (/@resend\.dev>?\s*$/i.test(from) && /invalid `?to`? field|testing email|own email address/i.test(message)) {
    return "Resend's test sender (onboarding@resend.dev) can only email the address you signed up to Resend with. Verify your domain in Resend and set NEWSLETTER_FROM to an address on it to email anyone else.";
  }
  return message;
}

/** Resend accepts up to 100 emails per batch call. */
export const MAX_BATCH = 100;

/**
 * Sends email through Resend (https://resend.com/docs/api-reference/emails/send-batch-emails).
 * The only class that talks to the email provider: tests replace it with a fake.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger("Mailer");

  /** What's missing before newsletters can go out, or null when ready. */
  missingConfig(): string | null {
    const { RESEND_API_KEY, NEWSLETTER_FROM, API_PUBLIC_URL } = env();
    const missing = [
      !RESEND_API_KEY && "RESEND_API_KEY",
      !NEWSLETTER_FROM && "NEWSLETTER_FROM",
      !API_PUBLIC_URL && "API_PUBLIC_URL",
    ].filter(Boolean);
    return missing.length ? missing.join(", ") : null;
  }

  /**
   * Sends up to 100 emails in one call. Resend checks the whole batch, so it all succeeds or all
   * fails. `idempotencyKey` makes a retried call a no-op on Resend's side (kept for 24 hours).
   */
  async sendBatch(emails: OutgoingEmail[], idempotencyKey?: string): Promise<BatchResult> {
    if (emails.length === 0) return { ok: true };
    if (emails.length > MAX_BATCH) throw new Error(`At most ${MAX_BATCH} emails per batch.`);
    const { RESEND_API_KEY, NEWSLETTER_FROM, NEWSLETTER_REPLY_TO } = env();
    if (!RESEND_API_KEY || !NEWSLETTER_FROM) return { ok: false, error: "Email sending isn't set up." };

    try {
      const response = await fetch("https://api.resend.com/emails/batch", {
        method: "POST",
        headers: {
          authorization: `Bearer ${RESEND_API_KEY}`,
          "content-type": "application/json",
          ...(idempotencyKey && { "idempotency-key": idempotencyKey }),
        },
        body: JSON.stringify(
          emails.map((email) => ({
            from: NEWSLETTER_FROM,
            to: [email.to],
            subject: email.subject,
            html: email.html,
            text: email.text,
            ...((email.replyTo ?? NEWSLETTER_REPLY_TO) && { reply_to: email.replyTo ?? NEWSLETTER_REPLY_TO }),
            ...(email.headers && { headers: email.headers }),
          })),
        ),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return { ok: true };
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      const error = explainResendError(body?.message ?? `Resend answered ${response.status}.`, NEWSLETTER_FROM);
      this.logger.error(`Batch of ${emails.length} failed: ${error}`);
      return { ok: false, error };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Batch of ${emails.length} failed: ${message}`);
      return { ok: false, error: "Couldn't reach the email service." };
    }
  }
}
