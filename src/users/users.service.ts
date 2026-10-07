import { HttpStatus, Injectable } from "@nestjs/common";
import { and, asc, count, eq, gt, isNull, ne } from "drizzle-orm";
import { ApiError } from "../common/api-error.js";
import { AuditService } from "../common/audit.service.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { invites, users } from "../db/schema.js";
import type { AuthUser } from "../auth/auth-user.js";

const LAST_SUPER_ADMIN = "There must always be at least one super admin.";

@Injectable()
export class UsersService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** Staff accounts and pending staff invites (the Users page). */
  async listStaff(me: AuthUser) {
    const [members, pending] = await Promise.all([
      this.db
        .select({ id: users.id, name: users.name, email: users.email, role: users.role, createdAt: users.createdAt })
        .from(users)
        .where(ne(users.role, "company"))
        .orderBy(asc(users.createdAt)),
      this.db
        .select({ email: invites.email, name: invites.name, role: invites.role, expiresAt: invites.expiresAt })
        .from(invites)
        .where(and(gt(invites.expiresAt, new Date()), isNull(invites.companyId)))
        .orderBy(asc(invites.createdAt)),
    ]);
    return {
      members: members.map((m) => ({ ...m, isYou: m.id === me.id })),
      invites: pending,
    };
  }

  private async otherSuperAdminCount(excludeId: string): Promise<number> {
    const [{ n }] = await this.db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.role, "super_admin"), ne(users.id, excludeId)));
    return n;
  }

  /** Staff accounts only. The last super admin can never be demoted. */
  async changeRole(admin: AuthUser, id: string, role: "super_admin" | "editor"): Promise<{ message: string }> {
    const [target] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!target) throw new ApiError(HttpStatus.NOT_FOUND, "not_found", "User not found.");
    if (target.role === "company") {
      throw new ApiError(HttpStatus.BAD_REQUEST, "company_account", "Company accounts are managed from Companies.");
    }
    if (target.role === role) return { message: "No change." };
    if (target.role === "super_admin" && (await this.otherSuperAdminCount(target.id)) === 0) {
      throw new ApiError(HttpStatus.CONFLICT, "last_super_admin", LAST_SUPER_ADMIN);
    }
    await this.db.update(users).set({ role }).where(eq(users.id, id));
    await this.audit.log(admin, "role changed", "user", null, `${target.name} → ${role}`);
    return { message: `${target.name} is now ${role === "super_admin" ? "a super admin" : "an editor"}.` };
  }

  /** Signs the user out everywhere (sessions cascade). The last super admin can never be removed. */
  async remove(admin: AuthUser, id: string): Promise<{ message: string; companyId: string | null }> {
    const [target] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!target) throw new ApiError(HttpStatus.NOT_FOUND, "not_found", "Already removed.");
    if (target.id === admin.id) {
      throw new ApiError(HttpStatus.BAD_REQUEST, "remove_self", "You can't remove yourself. Ask another super admin.");
    }
    if (target.role === "super_admin" && (await this.otherSuperAdminCount(target.id)) === 0) {
      throw new ApiError(HttpStatus.CONFLICT, "last_super_admin", LAST_SUPER_ADMIN);
    }
    await this.db.delete(users).where(eq(users.id, id));
    await this.audit.log(admin, "removed", "user", null, target.name);
    return { message: `${target.name} was removed.`, companyId: target.companyId };
  }
}
