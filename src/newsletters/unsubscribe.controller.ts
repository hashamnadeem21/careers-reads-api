import { Controller, Get, Header, HttpCode, HttpStatus, Param, Post, Req } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Request } from "express";
import { Public } from "../auth/decorators.js";
import { limitKey, RateLimitService } from "../common/rate-limit.service.js";
import { clientIp } from "../common/request.js";
import { env } from "../config/env.js";
import { escapeHtml, SITE_NAME } from "./render.js";
import { SubscriptionsService } from "./subscriptions.service.js";

/** A small standalone page (subscribers land here from their inbox, not from the website). */
function page(title: string, body: string): string {
  const site = escapeHtml(env().PUBLIC_SITE_URL);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · ${SITE_NAME}</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<main style="max-width:440px;margin:24px;padding:32px;background:#fff;border-radius:16px;text-align:center;box-shadow:0 1px 3px rgba(15,23,42,.08)">
<h1 style="margin:0 0 12px;font-size:22px">${escapeHtml(title)}</h1>
${body}
<p style="margin:24px 0 0;font-size:14px"><a href="${site}" style="color:#2563eb">Back to ${SITE_NAME}</a></p>
</main>
</body>
</html>`;
}

const invalidLink = () =>
  page(
    "This link isn't valid",
    `<p style="color:#64748b">It may be from a test email or copied incompletely. Use the unsubscribe link at the bottom of any ${SITE_NAME} newsletter.</p>`,
  );

/**
 * Unsubscribe links in newsletters. GET shows a confirm button (so link scanners in mail filters
 * can't unsubscribe anyone); POST unsubscribes, and is also what one-click unsubscribe in Gmail
 * and Apple Mail calls (RFC 8058).
 */
@ApiExcludeController()
@Controller("public/unsubscribe")
@Public()
export class UnsubscribeController {
  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private limit(request: Request) {
    return this.rateLimit.enforce(limitKey("unsubscribe", clientIp(request)), 30, 600, "Too many attempts.");
  }

  @Get(":token")
  @Header("content-type", "text/html; charset=utf-8")
  @Header("cache-control", "no-store")
  async confirm(@Req() request: Request, @Param("token") token: string): Promise<string> {
    await this.limit(request);
    const subscriber = await this.subscriptions.findByToken(token);
    if (!subscriber) return invalidLink();
    if (subscriber.unsubscribed) {
      return page("You're unsubscribed", `<p style="color:#64748b">${escapeHtml(subscriber.email)} won't get any more newsletters.</p>`);
    }
    return page(
      "Unsubscribe?",
      `<p style="color:#64748b">${escapeHtml(subscriber.email)} will stop getting the ${SITE_NAME} newsletter.</p>
<form method="post" style="margin-top:20px">
<button type="submit" style="font:inherit;font-weight:600;padding:10px 20px;border:0;border-radius:10px;background:#2563eb;color:#fff;cursor:pointer">Unsubscribe</button>
</form>`,
    );
  }

  @Post(":token")
  @HttpCode(HttpStatus.OK)
  @Header("content-type", "text/html; charset=utf-8")
  @Header("cache-control", "no-store")
  async unsubscribe(@Req() request: Request, @Param("token") token: string): Promise<string> {
    await this.limit(request);
    if (!(await this.subscriptions.unsubscribe(token))) return invalidLink();
    return page(
      "You're unsubscribed",
      `<p style="color:#64748b">You won't get any more newsletters. Changed your mind? Sign up again on the website any time.</p>`,
    );
  }
}
