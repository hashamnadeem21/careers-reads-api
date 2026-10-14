import type { OutgoingEmail } from "../mail/mailer.service.js";
import { emailAssetsUrl } from "../newsletters/compose.js";
import { renderNewsletter, SITE_NAME } from "../newsletters/render.js";

export interface ApplicationEmailData {
  applicationId: string;
  name: string;
  email: string;
  location: string | null;
  job: { slug: string; title: string; company: string };
}

export interface EmailSettings {
  siteUrl: string;
  adminUrl: string;
  postalAddress?: string;
}

/** Candidate-supplied text inside Markdown: shown literally, never as links or formatting. */
export function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()<>#+\-.!|~]/g, (c) => `\\${c}`);
}

function render(
  settings: EmailSettings,
  subject: string,
  previewText: string,
  body: string,
  cta: [string, string],
  reason: string,
) {
  const { html, text } = renderNewsletter(
    { subject, previewText, body, ctaLabel: cta[0], ctaUrl: cta[1] },
    {
      siteUrl: settings.siteUrl,
      assetsUrl: emailAssetsUrl(),
      postalAddress: settings.postalAddress,
      reason,
      promo: false,
    },
  );
  return { subject, html, text };
}

/** To the employer: someone applied. Replies go straight to the candidate. */
export function employerEmail(to: string, data: ApplicationEmailData, settings: EmailSettings): OutgoingEmail {
  const job = escapeMarkdown(data.job.title);
  const who = escapeMarkdown(data.name);
  const where = data.location ? ` from ${escapeMarkdown(data.location)}` : "";
  return {
    to,
    replyTo: data.email,
    ...render(
      settings,
      `New application: ${data.job.title}`,
      `${data.name} applied for ${data.job.title}.`,
      [
        `## New application for ${job}`,
        `**${who}**${where} just applied on ${SITE_NAME}. Their CV and answers are waiting in your applicants list.`,
        "Reply to this email to contact them directly.",
      ].join("\n\n"),
      ["View application", `${settings.adminUrl}/applications/${data.applicationId}`],
      `You're receiving this because you post jobs on ${SITE_NAME}.`,
    ),
  };
}

/** To the candidate: a receipt for their application. */
export function candidateEmail(data: ApplicationEmailData, settings: EmailSettings): OutgoingEmail {
  const job = escapeMarkdown(data.job.title);
  const company = escapeMarkdown(data.job.company);
  return {
    to: data.email,
    ...render(
      settings,
      `Application sent: ${data.job.title} at ${data.job.company}`,
      `${data.job.company} has your CV and answers.`,
      [
        `## Your application is in`,
        `Hi ${escapeMarkdown(data.name.split(/\s+/)[0] ?? data.name)},`,
        `Thanks for applying for **${job}** at **${company}**. They have your CV and your answers, and will contact you directly if they'd like to talk.`,
        `Good luck! In the meantime, here are more jobs you might like.`,
      ].join("\n\n"),
      ["Browse more jobs", `${settings.siteUrl}/jobs`],
      `You're receiving this because you applied for a job on ${SITE_NAME}. Never pay anyone to apply for a job.`,
    ),
  };
}
