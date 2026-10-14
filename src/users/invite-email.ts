import type { OutgoingEmail } from "../mail/mailer.service.js";
import { emailAssetsUrl } from "../newsletters/compose.js";
import { escapeMarkdown, renderNewsletter, SITE_NAME } from "../newsletters/render.js";

export interface InviteEmailData {
  to: string;
  name: string;
  /** Who sent the invite, for "Hasham invited you…". */
  inviterName?: string;
  /** For company accounts: the company they'll post jobs for. */
  companyName?: string | null;
  /** For staff: "Editor", "Super admin". */
  roleLabel: string;
  link: string;
  expiresAt: Date;
}

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** The invite: a button to choose a password and sign in. The link is the only way in, so it's sent to them alone. */
export function inviteEmail(
  data: InviteEmailData,
  settings: { siteUrl: string; postalAddress?: string },
): OutgoingEmail {
  const who = data.inviterName ? escapeMarkdown(data.inviterName) : `The ${SITE_NAME} team`;
  const first = escapeMarkdown(data.name.split(/\s+/)[0] || data.name);
  const company = data.companyName ? escapeMarkdown(data.companyName) : null;
  const subject = data.companyName
    ? `You're invited to ${data.companyName} on ${SITE_NAME}`
    : `You're invited to the ${SITE_NAME} admin`;
  const body = [
    `## You're invited`,
    `Hi ${first},`,
    company
      ? `${who} has invited you to **${company}**'s employer account on ${SITE_NAME}. You'll be able to post and edit the company's jobs, see how they're doing, and review applicants.`
      : `${who} has invited you to the ${SITE_NAME} admin as **${escapeMarkdown(data.roleLabel)}**.`,
    `Choose your password to sign in. The link works once and expires on **${dateFormat.format(data.expiresAt)}**.`,
  ].join("\n\n");
  // The link is ours (admin URL + a URL-safe token), so it goes in as a plain autolink.
  const afterButton = [
    `If the button doesn't work, copy this link into your browser:\n<${data.link}>`,
    `Weren't expecting this? You can ignore this email; nothing happens unless you use the link.`,
  ].join("\n\n");
  const { html, text } = renderNewsletter(
    {
      subject,
      previewText: company ? `Join ${data.companyName} on ${SITE_NAME}` : `Join the ${SITE_NAME} admin`,
      body,
      ctaLabel: "Accept invite",
      ctaUrl: data.link,
      afterButton,
    },
    {
      siteUrl: settings.siteUrl,
      assetsUrl: emailAssetsUrl(),
      postalAddress: settings.postalAddress,
      reason: `You're receiving this because someone at ${SITE_NAME} invited ${data.to}.`,
      promo: false,
    },
  );
  return { to: data.to, subject, html, text };
}
