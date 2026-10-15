import { env } from "../config/env.js";
import type { OutgoingEmail } from "../mail/mailer.service.js";
import { emailAssetsUrl } from "../newsletters/compose.js";
import { escapeMarkdown, type NewsletterContent, renderNewsletter, SITE_NAME } from "../newsletters/render.js";

/** Where the website's account pages live (the API only builds the links). */
export const confirmEmailLink = (token: string) => `${env().PUBLIC_SITE_URL}/account/confirm-email?token=${encodeURIComponent(token)}`;
export const resetPasswordLink = (token: string) => `${env().PUBLIC_SITE_URL}/account/reset-password?token=${encodeURIComponent(token)}`;

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** `{{first_name}}` in an automation's subject or body becomes the candidate's first name. */
export const MERGE_FIRST_NAME = "{{first_name}}";
export function personalise(text: string, name: string, markdown: boolean): string {
  const value = markdown ? escapeMarkdown(firstName(name)) : firstName(name);
  return text.replaceAll(MERGE_FIRST_NAME, value);
}

/** The default "When a candidate signs up" automation, created the first time someone signs up. */
export const DEFAULT_WELCOME = {
  name: "Welcome new candidates",
  subject: `Welcome to ${SITE_NAME}, ${MERGE_FIRST_NAME} 🎉`,
  previewText: "Your next opportunity starts here.",
  body: [
    `## Welcome aboard, ${MERGE_FIRST_NAME}!`,
    `You've just taken a step many people put off: going after the next opportunity. We're really glad you're here.`,
    `Here's what you can do with ${SITE_NAME}:`,
    [
      `- **Apply in a few clicks.** Your details are ready whenever you find a role you like.`,
      `- **Discover fresh jobs** in tech, business, design, marketing, sales and remote roles.`,
      `- **Get better at the process** with short, practical guides on CVs, interviews and the skills employers look for.`,
    ].join("\n"),
    `Every application is practice, and every "no" brings you closer to the right "yes". Keep going. We're rooting for you.`,
    `The ${SITE_NAME} team`,
  ].join("\n\n"),
  ctaLabel: "Find your next job",
  ctaUrl: "/jobs",
};

const accountReason = (to: string) => `You're receiving this because a ${SITE_NAME} account was created with ${to}.`;

function render(content: NewsletterContent, to: string, promo: boolean): { html: string; text: string } {
  const { PUBLIC_SITE_URL, NEWSLETTER_POSTAL_ADDRESS } = env();
  return renderNewsletter(content, {
    siteUrl: PUBLIC_SITE_URL,
    assetsUrl: emailAssetsUrl(),
    postalAddress: NEWSLETTER_POSTAL_ADDRESS,
    reason: accountReason(to),
    promo,
  });
}

const copyLink = (link: string) => `If the button doesn't work, copy this link into your browser:\n<${link}>`;

/**
 * The welcome automation's email for one candidate. Accounts whose email isn't confirmed yet
 * (password sign-ups) get "Confirm your email" as the button, whatever the automation's own button is.
 */
export function candidateWelcomeEmail(
  content: NewsletterContent,
  candidate: { email: string; name: string },
  confirmLink: string | null,
): OutgoingEmail {
  const subject = personalise(content.subject, candidate.name, false);
  const personalised: NewsletterContent = {
    ...content,
    subject,
    previewText: personalise(content.previewText, candidate.name, false),
    body: personalise(content.body, candidate.name, true),
    ...(confirmLink
      ? {
          body: `${personalise(content.body, candidate.name, true)}\n\n**One last step:** confirm your email address so employers can receive your applications.`,
          ctaLabel: "Confirm your email",
          ctaUrl: confirmLink,
          afterButton: copyLink(confirmLink),
        }
      : {}),
  };
  const { html, text } = render(personalised, candidate.email, true);
  return { to: candidate.email, subject, html, text };
}

/** Just the confirmation (resend, or when no welcome automation is switched on). */
export function confirmEmailEmail(candidate: { email: string; name: string }, link: string): OutgoingEmail {
  const subject = `Confirm your email for ${SITE_NAME}`;
  const { html, text } = render(
    {
      subject,
      previewText: "One click and you're ready to apply.",
      body: [
        `## Confirm your email`,
        `Hi ${escapeMarkdown(firstName(candidate.name))},`,
        `Please confirm this is your email address so employers can receive your applications. The link works for 7 days.`,
      ].join("\n\n"),
      ctaLabel: "Confirm your email",
      ctaUrl: link,
      afterButton: `${copyLink(link)}\n\nDidn't create an account? You can ignore this email.`,
    },
    candidate.email,
    false,
  );
  return { to: candidate.email, subject, html, text };
}

export function resetPasswordEmail(candidate: { email: string; name: string }, link: string): OutgoingEmail {
  const subject = `Reset your ${SITE_NAME} password`;
  const { html, text } = render(
    {
      subject,
      previewText: "Choose a new password. The link works for 1 hour.",
      body: [
        `## Reset your password`,
        `Hi ${escapeMarkdown(firstName(candidate.name))},`,
        `Someone (hopefully you) asked to reset the password for your ${SITE_NAME} account. The link works once and expires in **1 hour**.`,
      ].join("\n\n"),
      ctaLabel: "Choose a new password",
      ctaUrl: link,
      afterButton: `${copyLink(link)}\n\nDidn't ask for this? You can ignore this email; your password stays the same.`,
    },
    candidate.email,
    false,
  );
  return { to: candidate.email, subject, html, text };
}
