import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { env } from "../config/env.js";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Which of our own servers sent the request, judged by its `X-Api-Key` (constant-time compare). */
export function trustedCaller(request: Request): "admin" | "site" | null {
  const key = request.header("x-api-key");
  if (!key) return null;
  const { ADMIN_API_KEY, SITE_API_KEY } = env();
  if (ADMIN_API_KEY && safeEqual(key, ADMIN_API_KEY)) return "admin";
  if (SITE_API_KEY && safeEqual(key, SITE_API_KEY)) return "site";
  return null;
}

/**
 * The visitor's IP, for rate limits only (never stored raw). The admin and website call the API
 * from their servers, so they pass the visitor's address in `X-Client-IP`; it is only believed
 * when the request carries a valid server key. Otherwise it's the connecting address.
 */
export function clientIp(request: Request): string {
  const forwarded = request.header("x-client-ip")?.trim();
  if (forwarded && forwarded.length <= 64 && trustedCaller(request)) return forwarded;
  return request.ip ?? "unknown";
}
