import type { Role } from "../db/schema.js";

/** The signed-in user for a request, loaded from the database on every request. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  mustChangePassword: boolean;
  /** Company accounts only (null for staff). */
  companyId: string | null;
  companyName: string | null;
  /** Whether the company may publish without review. */
  companyAutoPublish: boolean;
  theme: "light" | "dark" | "system";
  /** The session (refresh token) this request's access token belongs to. */
  sessionId: string;
}

export const STAFF_ROLES = ["super_admin", "editor"] as const satisfies readonly Role[];

export const roleLabels: Record<Role, string> = {
  super_admin: "Super admin",
  editor: "Editor",
  company: "Company",
};

export function isStaff(role: Role): boolean {
  return role === "super_admin" || role === "editor";
}

/** What the API returns about the signed-in user (no session id). */
export function publicUser({ sessionId: _sessionId, ...user }: AuthUser): Omit<AuthUser, "sessionId"> {
  return user;
}
