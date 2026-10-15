import type { CompanyRequestRow } from "../db/schema.js";
import type { OutgoingEmail } from "../mail/mailer.service.js";
import { emailAssetsUrl } from "../newsletters/compose.js";
import { escapeMarkdown, renderNewsletter, SITE_NAME } from "../newsletters/render.js";

export interface EmailSettings {
  siteUrl: string;
  adminUrl: string;
  postalAddress?: string;
}

type Request = Pick<CompanyRequestRow, "id" | "companyName" | "contactName" | "contactEmail" | "contactRole" | "industry" | "companySize" | "location">;

function render(settings: EmailSettings, subject: string, previewText: string, body: string, cta: [string, string], reason: string) {
  const { html, text } = renderNewsletter(
    { subject, previewText, body, ctaLabel: cta[0], ctaUrl: cta[1] },
    { siteUrl: settings.siteUrl, assetsUrl: emailAssetsUrl(), postalAddress: settings.postalAddress, reason, promo: false },
  );
  return { subject, html, text };
}

const firstName = (name: string) => escapeMarkdown(name.split(/\s+/)[0] ?? name);

/** To the company: we have their request, and what happens next. */
export function requestReceivedEmail(request: Request, settings: EmailSettings): OutgoingEmail {
  const company = escapeMarkdown(request.companyName);
  return {
    to: request.contactEmail,
    ...render(
      settings,
      `We've received your request: ${request.companyName}`,
      "We'll review it within two working days.",
      [
        "## Thanks for your request",
        `Hi ${firstName(request.contactName)},`,
        `We've received your request for a ${SITE_NAME} company account for **${company}**. Our team checks every company before it can post jobs, usually within two working days.`,
        "Once it's approved, you'll get an email with a link to set your password and sign in to your company dashboard, where you can post jobs and manage applicants.",
        "There's nothing more you need to do for now.",
      ].join("\n\n"),
      ["How it works", `${settings.siteUrl}/employers`],
      `You're receiving this because you asked for a company account on ${SITE_NAME}.`,
    ),
  };
}

/** To each super admin: a request is waiting. Replies go to the company's contact. */
export function reviewRequestEmail(to: string, request: Request, settings: EmailSettings): OutgoingEmail {
  return {
    to,
    replyTo: request.contactEmail,
    ...render(
      settings,
      `New company request: ${request.companyName}`,
      `${request.contactName} (${request.contactRole}) asked for a company account.`,
      [
        `## ${escapeMarkdown(request.companyName)} wants a company account`,
        `**${escapeMarkdown(request.contactName)}**, ${escapeMarkdown(request.contactRole)} · ${escapeMarkdown(request.contactEmail)}`,
        `${escapeMarkdown(request.industry)} · ${escapeMarkdown(request.companySize)} people · ${escapeMarkdown(request.location)}`,
        "Check their details, then approve the request to create the company and invite them, or turn it down. Reply to this email to ask them something first.",
      ].join("\n\n"),
      ["Review the request", `${settings.adminUrl}/company-requests/${request.id}`],
      `You're receiving this because you're a super admin on ${SITE_NAME}.`,
    ),
  };
}

/** To the company: the request wasn't approved, with the reviewer's reason when they gave one. */
export function requestDeclinedEmail(request: Request, reason: string | undefined, settings: EmailSettings): OutgoingEmail {
  return {
    to: request.contactEmail,
    ...render(
      settings,
      `Your ${SITE_NAME} company account request`,
      `About your request for ${request.companyName}.`,
      [
        "## About your request",
        `Hi ${firstName(request.contactName)},`,
        `Thank you for your interest in posting jobs on ${SITE_NAME}. We weren't able to approve the company account for **${escapeMarkdown(request.companyName)}** this time.`,
        ...(reason ? [`> ${escapeMarkdown(reason).replace(/\n+/g, "\n> ")}`] : []),
        "If you think we've got something wrong, or your details have changed, reply to this email or send a new request.",
      ].join("\n\n"),
      ["Contact us", `${settings.siteUrl}/contact`],
      `You're receiving this because you asked for a company account on ${SITE_NAME}.`,
    ),
  };
}
