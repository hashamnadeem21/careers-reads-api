import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { ApiError } from "../common/api-error.js";
import { fieldErrors } from "../common/zod.js";
import { limitKey, RateLimitService } from "../common/rate-limit.service.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import {
  applicationAnswers,
  applications,
  candidateEvents,
  type CandidateRow,
  candidates,
  companies,
  type JobRow,
  jobs,
} from "../db/schema.js";
import { checkCv } from "../files/cv-file.js";
import { PrivateFilesService } from "../files/private-files.service.js";
import { loadQuestions } from "../jobs/job-questions.js";
import { checkAnswers, type FormQuestion } from "../shared/jobs/questions.js";
import { isJobVisible } from "../shared/jobs/visibility.js";
import { applySchema } from "./applications.schemas.js";

/** 5 applications per visitor per hour: plenty for a person, little for a bot. */
/** submitted: on its way to the employer. held: waiting for the candidate to confirm their email. */
export type ApplyOutcome = "submitted" | "held" | "already_applied";

const APPLY_LIMIT = 5;
const APPLY_WINDOW_SECONDS = 60 * 60;
/** And 20 per email address per day, however many connections they come from. */
const EMAIL_LIMIT = 20;
const EMAIL_WINDOW_SECONDS = 24 * 60 * 60;

export interface ApplicationForm {
  job: { slug: string; title: string; company: string };
  questions: FormQuestion[];
}

export interface UploadedCv {
  originalname: string;
  buffer: Buffer;
}

const closed = () =>
  new ApiError(HttpStatus.NOT_FOUND, "not_accepting", "This job isn't taking applications on Career Reads.");

/** Applying on the website: the form a job shows, and taking an application in. */
@Injectable()
export class ApplyService {
  private readonly logger = new Logger("Apply");

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly rateLimit: RateLimitService,
    private readonly files: PrivateFilesService,
  ) {}

  /** The job, if it's on the site and taking applications on Career Reads right now. */
  private async openJob(slug: string): Promise<JobRow> {
    const [row] = await this.db
      .select({ job: jobs, allowed: sql<boolean>`coalesce(${companies.onsiteApplyEnabled}, true)` })
      .from(jobs)
      .leftJoin(companies, eq(companies.id, jobs.companyId))
      .where(eq(jobs.slug, slug))
      .limit(1);
    if (!row || !row.job.onsiteApply || !row.allowed) throw closed();
    const { status, postedAt, deadline, sample } = row.job;
    if (!isJobVisible({ status, sample, postedAt: postedAt.toISOString(), deadline: deadline?.toISOString() }))
      throw closed();
    return row.job;
  }

  async form(slug: string): Promise<ApplicationForm> {
    const job = await this.openJob(slug);
    return {
      job: { slug: job.slug, title: job.title, company: job.company },
      questions: await loadQuestions(this.db, job.id),
    };
  }

  /**
   * The signed-in candidate applies. Checks everything first (fields, answers, CV), stores the CV,
   * then saves the application and answers in one transaction. The CV is a new upload (which also
   * becomes their saved CV) or, with `useSavedCv`, the one already on their account. A CV whose
   * application never got saved is deleted by the files sweep. The emails go out from the scheduler.
   *
   * The email is always the account's own. From an account whose email isn't confirmed yet, the
   * application is held (hidden from the employer, not emailed) until they confirm.
   */
  async apply(
    ip: string,
    slug: string,
    body: unknown,
    cv: UploadedCv | undefined,
    candidate: CandidateRow,
  ): Promise<ApplyOutcome> {
    await this.rateLimit.enforce(
      limitKey("apply", ip),
      APPLY_LIMIT,
      APPLY_WINDOW_SECONDS,
      "Too many applications from your connection. Please try again in an hour.",
    );
    const job = await this.openJob(slug);

    const parsed = applySchema.safeParse(body);
    const errors: Record<string, string> = parsed.success ? {} : fieldErrors(parsed.error);
    if (parsed.success && parsed.data.website) {
      this.logger.warn(`Ignored a bot application for ${slug}`);
      return "submitted"; // looks like success to the bot
    }
    const questions = await loadQuestions(this.db, job.id);
    const answers = checkAnswers(questions, parsed.success ? parsed.data.answers : {});
    if (parsed.success) Object.assign(errors, answers.errors);
    // A new file wins; otherwise "use my saved CV" sends the one on their account.
    const useSaved = !cv && parsed.success && parsed.data.useSavedCv === "true";
    const savedFile = useSaved && candidate.cvFileId ? await this.files.get(candidate.cvFileId) : null;
    const cvCheck = cv ? checkCv(cv.buffer) : null;
    if (cvCheck && !cvCheck.ok) errors.cv = cvCheck.error;
    else if (!cv && !savedFile) errors.cv = useSaved ? "Your saved CV is no longer available. Please upload it again" : "Attach your CV";
    if (!parsed.success || Object.keys(errors).length) {
      throw new ApiError(HttpStatus.BAD_REQUEST, "validation_failed", "Please fix the highlighted fields.", errors);
    }
    const fields = { ...parsed.data, email: candidate.email };
    const [already] = await this.db
      .select({ id: applications.id })
      .from(applications)
      .where(and(eq(applications.jobId, job.id), eq(applications.candidateId, candidate.id)))
      .limit(1);
    if (already) return "already_applied";
    await this.rateLimit.enforce(
      limitKey("apply-email", fields.email),
      EMAIL_LIMIT,
      EMAIL_WINDOW_SECONDS,
      "Too many applications from this email address today. Please try again tomorrow.",
    );


    // A newly uploaded CV also becomes their saved CV, offered next time they apply.
    const uploaded = cv && cvCheck?.ok ? await this.files.saveCv(cv.buffer, cv.originalname, cvCheck.type, cvCheck.contentType) : null;
    const file = uploaded ?? savedFile;
    if (!file) throw new ApiError(HttpStatus.BAD_REQUEST, "validation_failed", "Please fix the highlighted fields.", { cv: "Attach your CV" });
    const now = new Date();
    const held = candidate.emailVerifiedAt === null;
    const saved = await this.db.transaction(async (tx) => {
      await tx
        .update(candidates)
        .set({ phone: fields.phone, ...(uploaded ? { cvFileId: uploaded.id } : {}), updatedAt: now })
        .where(eq(candidates.id, candidate.id));
      const [application] = await tx
        .insert(applications)
        .values({
          jobId: job.id,
          companyId: job.companyId,
          candidateId: candidate.id,
          resumeFileId: file.id,
          name: fields.name,
          email: fields.email,
          phone: fields.phone,
          location: fields.location ?? null,
          linkedinUrl: fields.linkedinUrl ?? null,
          coverLetter: fields.coverLetter ?? null,
          consentAt: now,
          awaitingConfirmation: held,
        })
        .onConflictDoNothing({ target: [applications.jobId, applications.candidateId] })
        .returning({ id: applications.id });
      if (!application) return false; // a second submit that raced the first
      const rows = questions.map((q, position) => ({
        applicationId: application.id,
        position,
        questionId: q.id,
        kind: q.kind,
        label: q.label,
        value: answers.values.get(q.id) ?? null,
      }));
      if (rows.length) await tx.insert(applicationAnswers).values(rows);
      await tx.insert(candidateEvents).values({ candidateId: candidate.id, kind: "applied", jobId: job.id });
      return true;
    });
    if (!saved) return "already_applied"; // a second submit that raced the first
    return held ? "held" : "submitted";
  }
}
