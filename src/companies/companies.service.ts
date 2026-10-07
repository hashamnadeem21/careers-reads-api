import { HttpStatus, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import type { z } from "zod";
import { ApiError } from "../common/api-error.js";
import { AuditService } from "../common/audit.service.js";
import { RevalidateSiteService } from "../common/revalidate-site.service.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { companies, jobs, users, type CompanyRow } from "../db/schema.js";
import type { AuthUser } from "../auth/auth-user.js";
import { SessionsService } from "../auth/sessions.service.js";
import { type InviteCreated, InvitesService } from "../users/invites.service.js";
import * as queries from "./companies.queries.js";
import type { companySchema } from "./companies.schemas.js";

type CompanyInput = z.infer<typeof companySchema>;

const notFound = () => new ApiError(HttpStatus.NOT_FOUND, "not_found", "This company no longer exists.");
const nameTaken = () =>
  new ApiError(HttpStatus.CONFLICT, "name_taken", "A company with this name already exists.", {
    name: "A company with this name already exists",
  });

@Injectable()
export class CompaniesService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly audit: AuditService,
    private readonly revalidateSite: RevalidateSiteService,
    private readonly sessions: SessionsService,
    private readonly invites: InvitesService,
  ) {}

  list() {
    return queries.listCompanies(this.db);
  }

  /** Companies for the staff job form's "Company account" picker. */
  options(): Promise<{ id: string; name: string; website: string | null }[]> {
    return this.db
      .select({ id: companies.id, name: companies.name, website: companies.website })
      .from(companies)
      .orderBy(asc(companies.name));
  }

  async get(id: string): Promise<CompanyRow> {
    const [row] = await this.db.select().from(companies).where(eq(companies.id, id)).limit(1);
    if (!row) throw notFound();
    return row;
  }

  async people(id: string) {
    await this.get(id);
    return queries.getCompanyPeople(this.db, id);
  }

  /** Super admins see any company's numbers; a company account only its own. */
  async dashboard(user: AuthUser, id: string) {
    if (user.role === "company" && user.companyId !== id) {
      throw new ApiError(HttpStatus.FORBIDDEN, "forbidden", "You don't have access to this.");
    }
    const company = await this.get(id);
    const [totals, traffic, jobsPerformance] = await Promise.all([
      queries.getCompanyTotals(this.db, id),
      queries.getCompanyTraffic(this.db, id),
      queries.getCompanyJobPerformance(this.db, id),
    ]);
    return { company, totals, traffic, jobs: jobsPerformance };
  }

  private async assertNameFree(name: string, exceptId?: string): Promise<void> {
    const [row] = await this.db.select({ id: companies.id }).from(companies).where(eq(companies.name, name)).limit(1);
    if (row && row.id !== exceptId) throw nameTaken();
  }

  async create(admin: AuthUser, input: CompanyInput): Promise<CompanyRow> {
    await this.assertNameFree(input.name);
    const [company] = await this.db
      .insert(companies)
      .values({ name: input.name, website: input.website ?? null, autoPublish: input.autoPublish })
      .returning();
    await this.audit.log(admin, "created", "company", company.id, company.name);
    return company;
  }

  /** Rename, change website or trust level. Renaming updates the name shown on all its jobs. */
  async update(admin: AuthUser, id: string, input: CompanyInput): Promise<CompanyRow> {
    await this.assertNameFree(input.name, id);
    const before = await this.get(id);
    const company = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(companies)
        .set({ name: input.name, website: input.website ?? null, autoPublish: input.autoPublish })
        .where(eq(companies.id, id))
        .returning();
      if (before.name !== input.name) await tx.update(jobs).set({ company: input.name }).where(eq(jobs.companyId, id));
      return row;
    });
    await this.audit.log(admin, "updated", "company", id, input.name);
    if (before.name !== input.name) await this.revalidateSite.revalidate({ tags: ["jobs"], paths: ["/", "/jobs"] });
    return company;
  }

  /** Pausing signs everyone at the company out and blocks sign-in. Their jobs stay as they are. */
  async setActive(admin: AuthUser, id: string, active: boolean): Promise<{ message: string; company: CompanyRow }> {
    const [company] = await this.db.update(companies).set({ active }).where(eq(companies.id, id)).returning();
    if (!company) throw notFound();
    if (!active) {
      const members = await this.db.select({ id: users.id }).from(users).where(eq(users.companyId, id));
      await this.sessions.revokeAll(members.map((m) => m.id));
    }
    await this.audit.log(admin, active ? "reactivated" : "paused", "company", company.id, company.name);
    return {
      message: active ? `${company.name} can sign in again.` : `${company.name} is paused and signed out.`,
      company,
    };
  }

  /**
   * Deletes the company and its user accounts. Its jobs are kept (as Career Reads jobs,
   * with their stats) so nothing disappears from the site by accident.
   */
  async remove(admin: AuthUser, id: string): Promise<void> {
    const [company] = await this.db.delete(companies).where(eq(companies.id, id)).returning();
    if (!company) throw notFound();
    await this.audit.log(admin, "deleted", "company", null, company.name);
  }

  /** Invite someone from the company. They'll only ever see this company's jobs. */
  async invite(admin: AuthUser, id: string, input: { email: string; name: string }): Promise<InviteCreated> {
    const company = await this.get(id);
    if (!company.active) {
      throw new ApiError(HttpStatus.CONFLICT, "company_paused", "Reactivate the company before inviting people.");
    }
    return this.invites.create(admin, { ...input, role: "company", companyId: company.id });
  }
}
