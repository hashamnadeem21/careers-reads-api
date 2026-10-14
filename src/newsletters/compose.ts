import { env } from "../config/env.js";
import type { OutgoingEmail } from "../mail/mailer.service.js";
import { type NewsletterContent, renderNewsletter } from "./render.js";

/** What every email to subscribers is made of: newsletters and automations alike. */
export type EmailContent = NewsletterContent;

/** The live website: email images load from here when the configured site is only local. */
export const LIVE_SITE_URL = "https://careersreads.com";

/** Where email images load from (see EMAIL_ASSETS_URL). */
export function emailAssetsUrl(): string {
  const { EMAIL_ASSETS_URL, PUBLIC_SITE_URL } = env();
  if (EMAIL_ASSETS_URL) return EMAIL_ASSETS_URL;
  const { hostname } = new URL(PUBLIC_SITE_URL);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost") ? LIVE_SITE_URL : PUBLIC_SITE_URL;
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
    assetsUrl: emailAssetsUrl(),
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
    // The admin previews in the browser, where the site's own images load fine.
    unsubscribeUrl: "#unsubscribe",
    postalAddress: NEWSLETTER_POSTAL_ADDRESS,
  });
  return { html };
}
