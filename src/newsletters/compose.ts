import { env } from "../config/env.js";
import type { OutgoingEmail } from "../mail/mailer.service.js";
import { renderNewsletter } from "./render.js";

/** What every email to subscribers is made of: newsletters and automations alike. */
export interface EmailContent {
  subject: string;
  previewText: string;
  body: string;
}

/** The page (served by this API) where a subscriber confirms they want to unsubscribe. */
export function unsubscribeUrl(apiPublicUrl: string, token: string): string {
  return `${apiPublicUrl}/public/unsubscribe/${encodeURIComponent(token)}`;
}

/** One subscriber's copy, with their own unsubscribe link (also as one-click headers, RFC 8058). */
export function composeEmail(content: EmailContent, to: string, token: string): OutgoingEmail {
  const { API_PUBLIC_URL, PUBLIC_SITE_URL, NEWSLETTER_POSTAL_ADDRESS } = env();
  const url = unsubscribeUrl(API_PUBLIC_URL ?? "", token);
  const { html, text } = renderNewsletter(content, {
    siteUrl: PUBLIC_SITE_URL,
    unsubscribeUrl: url,
    postalAddress: NEWSLETTER_POSTAL_ADDRESS,
  });
  return {
    to,
    subject: content.subject,
    html,
    text,
    headers: { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

/** The email as subscribers will see it, for the admin's live preview (no real unsubscribe link). */
export function previewEmail(content: EmailContent): { html: string } {
  const { PUBLIC_SITE_URL, NEWSLETTER_POSTAL_ADDRESS } = env();
  const { html } = renderNewsletter(content, {
    siteUrl: PUBLIC_SITE_URL,
    unsubscribeUrl: "#unsubscribe",
    postalAddress: NEWSLETTER_POSTAL_ADDRESS,
  });
  return { html };
}
