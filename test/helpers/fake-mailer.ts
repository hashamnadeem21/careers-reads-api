import type { BatchResult, OutgoingEmail } from "../../src/mail/mailer.service.js";

/** Records emails instead of sending them. Swap in with `overrideProvider(MailerService)`. */
export class FakeMailer {
  sent: OutgoingEmail[] = [];
  configured = true;
  /** Every batch fails with this error. */
  failWith: string | null = null;
  /** Like Resend: a batch containing this address fails as a whole. */
  badAddress: string | null = null;
  calls = 0;

  missingConfig() {
    return this.configured ? null : "RESEND_API_KEY";
  }

  async sendBatch(emails: OutgoingEmail[]): Promise<BatchResult> {
    this.calls++;
    if (this.failWith) return { ok: false, error: this.failWith };
    if (emails.some((email) => email.to === this.badAddress)) return { ok: false, error: `Invalid address: ${this.badAddress}` };
    this.sent.push(...emails);
    return { ok: true };
  }

  reset() {
    this.sent = [];
    this.configured = true;
    this.failWith = null;
    this.badAddress = null;
    this.calls = 0;
  }
}
