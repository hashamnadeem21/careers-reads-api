import { and, eq, isNull, type SQL } from "drizzle-orm";
import type { AuthUser } from "../auth/auth-user.js";
import { applications } from "../db/schema.js";

/**
 * Who may see which applications. Every application query and action goes through these.
 *  - super admin: all of them
 *  - editor: applications to jobs Career Reads posted itself (no company)
 *  - company: only applications to its own company's jobs
 * Applications still waiting for the candidate to confirm their email are hidden from everyone.
 */
type Actor = Pick<AuthUser, "role" | "companyId">;

export function applicationScope(user: Actor): SQL {
  const released = eq(applications.awaitingConfirmation, false);
  if (user.role === "super_admin") return released;
  if (user.role === "editor") return and(released, isNull(applications.companyId)) as SQL;
  if (!user.companyId) throw new Error("Company account without a company");
  return and(released, eq(applications.companyId, user.companyId)) as SQL;
}

/** Same rule for an application that is already loaded. */
export function canAccessApplication(
  user: Actor,
  application: { companyId: string | null; awaitingConfirmation?: boolean },
): boolean {
  if (application.awaitingConfirmation) return false;
  if (user.role === "super_admin") return true;
  if (user.role === "editor") return application.companyId === null;
  return user.companyId !== null && application.companyId === user.companyId;
}
