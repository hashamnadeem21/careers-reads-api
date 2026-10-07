import { eq, type SQL } from "drizzle-orm";
import type { AuthUser } from "../auth/auth-user.js";
import { type JobReview, jobs } from "../db/schema.js";

/**
 * Who may see and change which jobs, and what a save does to a job's status
 * (port of the admin's `lib/jobs/access.ts`). Every job query and action goes through these.
 */

type Actor = Pick<AuthUser, "role" | "companyId" | "companyAutoPublish">;

/** SQL filter limiting a query to the jobs this user may see. Staff: everything; companies: their own. */
export function jobScope(user: Actor): SQL | undefined {
  if (user.role !== "company") return undefined;
  if (!user.companyId) throw new Error("Company account without a company");
  return eq(jobs.companyId, user.companyId);
}

/** Same rule for a job row that is already loaded. */
export function canAccessJob(user: Actor, job: { companyId: string | null }): boolean {
  return user.role !== "company" || (user.companyId !== null && job.companyId === user.companyId);
}

export interface Publishing {
  status: "draft" | "published";
  review: JobReview | null;
}

/**
 * The status and review state that result when `user` saves a job asking for `requested`.
 *
 * Company accounts:
 *  - draft → hidden draft (any earlier review is cleared)
 *  - publish, trusted company → live immediately (approved)
 *  - publish, otherwise → stays hidden and goes to the review queue (pending). This also applies
 *    to edits of a live job, so a listing can't be changed after approval without another review.
 *
 * Staff: what they choose. Publishing a company's job approves it; saving it as a draft keeps
 * whatever review state it had.
 */
export function resolvePublishing(
  user: Actor,
  requested: "draft" | "published",
  job: { companyId: string | null; review: JobReview | null } | null,
): Publishing {
  if (user.role === "company") {
    if (requested === "draft") return { status: "draft", review: null };
    return user.companyAutoPublish
      ? { status: "published", review: "approved" }
      : { status: "draft", review: "pending" };
  }
  if (!job?.companyId) return { status: requested, review: null };
  return requested === "published"
    ? { status: "published", review: "approved" }
    : { status: "draft", review: job.review };
}

/** The audit log verb for a change from `before` to `after`. */
export function auditVerb(before: Publishing | null, after: Publishing): string {
  if (after.review === "pending" && before?.review !== "pending") return "submitted for review";
  if (after.status === "published" && before?.status !== "published") return "published";
  if (after.status === "draft" && before?.status === "published") return "unpublished";
  return before ? "updated" : "created";
}
