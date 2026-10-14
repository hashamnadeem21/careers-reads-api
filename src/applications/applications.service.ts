import { HttpStatus, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, gt, ilike, inArray, or, type SQL } from "drizzle-orm";
import type { AuthUser } from "../auth/auth-user.js";
import { ApiError } from "../common/api-error.js";
import { AuditService } from "../common/audit.service.js";
import { escapeLike } from "../common/slug.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { type AnswerValue } from "../shared/jobs/questions.js";
import {
  applicationAnswers,
  applicationEvents,
  applications,
  type ApplicationRow,
  type ApplicationStatus,
  candidates,
  jobs,
  type PrivateFileRow,
  users,
} from "../db/schema.js";
import { PrivateFilesService } from "../files/private-files.service.js";
import { applicationScope, canAccessApplication } from "./application-access.js";
import { APPLICATION_STATUSES, type ApplicationListQuery } from "./applications.schemas.js";

export const APPLICATION_PAGE_SIZE = 25;

/** Opening the same CV again within this time isn't logged twice. */
const CV_VIEW_LOG_MINUTES = 60;

/** Never reveals whether another company's application exists. */
const notFound = () => new ApiError(HttpStatus.NOT_FOUND, "not_found", "This application no longer exists.");

export interface ApplicationListItem {
  id: string;
  name: string;
  email: string;
  phone: string;
  location: string | null;
  status: ApplicationStatus;
  createdAt: Date;
  job: { slug: string; title: string; company: string };
}

/** Spreadsheet apps run cells that start with these as formulas; a leading ' keeps them as text. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function answerText(value: AnswerValue): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join("; ");
  return String(value);
}

/**
 * Applications as employers and staff see them. Every query is limited by `applicationScope`, so a
 * company account can only ever reach applications to its own jobs.
 */
@Injectable()
export class ApplicationsService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly audit: AuditService,
    private readonly files: PrivateFilesService,
  ) {}

  private async load(user: AuthUser, id: string): Promise<ApplicationRow> {
    const [row] = await this.db.select().from(applications).where(eq(applications.id, id)).limit(1);
    if (!row || !canAccessApplication(user, row)) throw notFound();
    return row;
  }

  /** The filters shared by the list and its status counts (everything but the status). */
  private async filters(user: AuthUser, params: Pick<ApplicationListQuery, "job" | "q">): Promise<SQL[]> {
    const where: SQL[] = [];
    const scope = applicationScope(user);
    if (scope) where.push(scope);
    if (params.job) {
      const [job] = await this.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.slug, params.job)).limit(1);
      // An unknown job, or someone else's, simply has no applications.
      where.push(eq(applications.jobId, job?.id ?? "00000000-0000-0000-0000-000000000000"));
    }
    if (params.q) {
      const p = `%${escapeLike(params.q)}%`;
      where.push(or(ilike(applications.name, p), ilike(applications.email, p), ilike(applications.phone, p))!);
    }
    return where;
  }

  /** One page (25), newest first, with the count for each status tab. */
  async list(user: AuthUser, params: ApplicationListQuery) {
    const base = await this.filters(user, params);
    const where = params.status ? [...base, eq(applications.status, params.status)] : base;
    const condition = where.length ? and(...where) : undefined;

    const [rows, [{ total }], byStatus] = await Promise.all([
      this.db
        .select({
          id: applications.id,
          name: applications.name,
          email: applications.email,
          phone: applications.phone,
          location: applications.location,
          status: applications.status,
          createdAt: applications.createdAt,
          job: { slug: jobs.slug, title: jobs.title, company: jobs.company },
        })
        .from(applications)
        .innerJoin(jobs, eq(jobs.id, applications.jobId))
        .where(condition)
        .orderBy(desc(applications.createdAt), desc(applications.id))
        .limit(APPLICATION_PAGE_SIZE)
        .offset((params.page - 1) * APPLICATION_PAGE_SIZE),
      this.db.select({ total: count() }).from(applications).where(condition),
      this.db
        .select({ status: applications.status, n: count() })
        .from(applications)
        .where(base.length ? and(...base) : undefined)
        .groupBy(applications.status),
    ]);
    const counts = Object.fromEntries(APPLICATION_STATUSES.map((s) => [s, 0])) as Record<ApplicationStatus, number>;
    for (const { status, n } of byStatus) counts[status] = n;
    const all = byStatus.reduce((sum, r) => sum + r.n, 0);
    return {
      items: rows satisfies ApplicationListItem[],
      total,
      page: params.page,
      pageSize: APPLICATION_PAGE_SIZE,
      counts: { all, ...counts },
    };
  }

  /** Applications nobody has looked at yet (the sidebar badge). */
  async newCount(user: AuthUser): Promise<{ count: number }> {
    const [{ n }] = await this.db
      .select({ n: count() })
      .from(applications)
      .where(and(applicationScope(user), eq(applications.status, "new")));
    return { count: n };
  }

  /** Everything about one application: details, CV file info, answers and history. */
  async get(user: AuthUser, id: string) {
    const application = await this.load(user, id);
    const [[job], file, answers, events] = await Promise.all([
      this.db
        .select({ slug: jobs.slug, title: jobs.title, company: jobs.company })
        .from(jobs)
        .where(eq(jobs.id, application.jobId))
        .limit(1),
      this.files.get(application.resumeFileId),
      this.db
        .select({
          label: applicationAnswers.label,
          kind: applicationAnswers.kind,
          value: applicationAnswers.value,
        })
        .from(applicationAnswers)
        .where(eq(applicationAnswers.applicationId, id))
        .orderBy(asc(applicationAnswers.position)),
      this.db
        .select({
          id: applicationEvents.id,
          kind: applicationEvents.kind,
          fromStatus: applicationEvents.fromStatus,
          toStatus: applicationEvents.toStatus,
          note: applicationEvents.note,
          createdAt: applicationEvents.createdAt,
          userName: users.name,
        })
        .from(applicationEvents)
        .leftJoin(users, eq(users.id, applicationEvents.userId))
        .where(eq(applicationEvents.applicationId, id))
        .orderBy(desc(applicationEvents.createdAt), desc(applicationEvents.id)),
    ]);
    const {
      candidateId: _candidateId,
      resumeFileId: _resumeFileId,
      notifyAttempts: _notifyAttempts,
      ...details
    } = application;
    return {
      application: details,
      job,
      cv: file && { name: file.originalName, contentType: file.contentType, sizeBytes: file.sizeBytes },
      answers,
      events,
    };
  }

  /** The CV's bytes for viewing or download. Opening it is recorded in the application's history. */
  async cv(user: AuthUser, id: string): Promise<{ file: PrivateFileRow; bytes: Buffer }> {
    const application = await this.load(user, id);
    const file = await this.files.get(application.resumeFileId);
    const bytes = file && (await this.files.read(file));
    if (!file || !bytes) throw new ApiError(HttpStatus.NOT_FOUND, "not_found", "This CV is no longer available.");

    const since = new Date(Date.now() - CV_VIEW_LOG_MINUTES * 60_000);
    const [recent] = await this.db
      .select({ id: applicationEvents.id })
      .from(applicationEvents)
      .where(
        and(
          eq(applicationEvents.applicationId, id),
          eq(applicationEvents.userId, user.id),
          eq(applicationEvents.kind, "cv_viewed"),
          gt(applicationEvents.createdAt, since),
        ),
      )
      .limit(1);
    if (!recent)
      await this.db.insert(applicationEvents).values({ applicationId: id, userId: user.id, kind: "cv_viewed" });
    return { file, bytes };
  }

  /** Moves applications to a new status, recording each change. Ones already there are left alone. */
  private async changeStatus(user: AuthUser, rows: ApplicationRow[], status: ApplicationStatus): Promise<number> {
    const changing = rows.filter((r) => r.status !== status);
    if (!changing.length) return 0;
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(applications)
        .set({ status, statusChangedAt: now, updatedAt: now })
        .where(
          inArray(
            applications.id,
            changing.map((r) => r.id),
          ),
        );
      await tx.insert(applicationEvents).values(
        changing.map((r) => ({
          applicationId: r.id,
          userId: user.id,
          kind: "status_changed" as const,
          fromStatus: r.status,
          toStatus: status,
        })),
      );
    });
    return changing.length;
  }

  async setStatus(user: AuthUser, id: string, status: ApplicationStatus): Promise<{ message: string }> {
    const application = await this.load(user, id);
    await this.changeStatus(user, [application], status);
    return { message: "Status updated." };
  }

  /** Only applications this user may access are changed; others are silently skipped. */
  async bulkStatus(user: AuthUser, ids: string[], status: ApplicationStatus): Promise<{ message: string }> {
    const rows = await this.db
      .select()
      .from(applications)
      .where(and(inArray(applications.id, ids), applicationScope(user)));
    if (!rows.length) throw notFound();
    const changed = await this.changeStatus(user, rows, status);
    return { message: `${changed} application${changed === 1 ? "" : "s"} updated.` };
  }

  /** A private note, visible to everyone who can see the application (never to the candidate). */
  async addNote(user: AuthUser, id: string, note: string) {
    await this.load(user, id);
    const [event] = await this.db
      .insert(applicationEvents)
      .values({ applicationId: id, userId: user.id, kind: "note", note })
      .returning();
    return { ...event, userName: user.name };
  }

  /** Deletes one application. Its CV is removed by the files sweep within the hour. */
  async remove(user: AuthUser, id: string): Promise<void> {
    const application = await this.load(user, id);
    await this.db.delete(applications).where(eq(applications.id, id));
    await this.audit.log(user, "deleted", "application", id, application.name);
  }

  /**
   * Super admin, for privacy requests: deletes everything held about a person (all their
   * applications to every company, and their CVs).
   */
  async forgetCandidate(user: AuthUser, email: string): Promise<{ message: string }> {
    const [candidate] = await this.db
      .select({ id: candidates.id })
      .from(candidates)
      .where(eq(candidates.email, email))
      .limit(1);
    if (!candidate) return { message: "No applications from this email address." };
    const [{ n }] = await this.db
      .select({ n: count() })
      .from(applications)
      .where(eq(applications.candidateId, candidate.id));
    await this.db.delete(candidates).where(eq(candidates.id, candidate.id));
    await this.audit.log(user, "deleted personal data", "candidate", null, `${n} application${n === 1 ? "" : "s"}`);
    return { message: `Deleted ${n} application${n === 1 ? "" : "s"} and the CVs for this email address.` };
  }

  /** A CSV of applications (one job's, or all this user can see), with a column per question for one job. */
  async exportCsv(user: AuthUser, jobSlug?: string): Promise<string> {
    const where = await this.filters(user, { job: jobSlug });
    const rows = await this.db
      .select({
        id: applications.id,
        name: applications.name,
        email: applications.email,
        phone: applications.phone,
        location: applications.location,
        linkedinUrl: applications.linkedinUrl,
        status: applications.status,
        createdAt: applications.createdAt,
        jobTitle: jobs.title,
      })
      .from(applications)
      .innerJoin(jobs, eq(jobs.id, applications.jobId))
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(applications.createdAt))
      .limit(10_000);

    // Answers only make sense as columns for a single job.
    const answers = new Map<string, Map<string, AnswerValue>>();
    const labels: string[] = [];
    if (jobSlug && rows.length) {
      const all = await this.db
        .select()
        .from(applicationAnswers)
        .where(
          inArray(
            applicationAnswers.applicationId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(asc(applicationAnswers.position));
      for (const a of all) {
        if (!labels.includes(a.label)) labels.push(a.label);
        if (!answers.has(a.applicationId)) answers.set(a.applicationId, new Map());
        answers.get(a.applicationId)!.set(a.label, a.value ?? null);
      }
    }

    const header = ["Name", "Email", "Phone", "Location", "LinkedIn", "Job", "Status", "Applied", ...labels];
    const lines = rows.map((r) =>
      [
        r.name,
        r.email,
        r.phone,
        r.location ?? "",
        r.linkedinUrl ?? "",
        r.jobTitle,
        r.status,
        r.createdAt.toISOString().slice(0, 10),
        ...labels.map((l) => answerText(answers.get(r.id)?.get(l) ?? null)),
      ]
        .map(csvCell)
        .join(","),
    );
    return [header.map(csvCell).join(","), ...lines].join("\r\n") + "\r\n";
  }
}
