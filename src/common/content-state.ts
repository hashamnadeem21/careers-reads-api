/** Status pill states shown in the admin. */
export type ContentState = "live" | "draft" | "scheduled" | "expired" | "review" | "rejected";

type Dateish = Date | string | null | undefined;
const time = (d: Dateish) => (d ? new Date(d).getTime() : NaN);

/** Post state: draft, scheduled (future publish date) or live. */
export function articleState(a: { status: string; publishedAt: Dateish }, now = new Date()): ContentState {
  if (a.status !== "published") return "draft";
  return time(a.publishedAt) > now.getTime() ? "scheduled" : "live";
}

/**
 * Job state, matching isJobVisible (deadline = last day to apply, UTC).
 * Unpublished company jobs show their review state instead of plain "draft".
 */
export function jobState(
  j: { status: string; postedAt: Dateish; deadline: Dateish; review?: string | null },
  now = new Date(),
): ContentState {
  if (j.status !== "published")
    return j.review === "pending" ? "review" : j.review === "rejected" ? "rejected" : "draft";
  if (j.deadline && time(j.deadline) + 86_400_000 <= now.getTime()) return "expired";
  if (time(j.postedAt) > now.getTime()) return "scheduled";
  return "live";
}

/** Whole days until the end of the deadline day (0 = closes today). */
export function daysLeft(deadline: Dateish, now = new Date()): number | null {
  if (!deadline) return null;
  return Math.max(0, Math.ceil((time(deadline) + 86_400_000 - now.getTime()) / 86_400_000) - 1);
}
