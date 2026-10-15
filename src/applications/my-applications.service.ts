import { HttpStatus, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { ApiError } from "../common/api-error.js";
import { limitKey, RateLimitService } from "../common/rate-limit.service.js";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { type ApplicationStatus, applications, type CandidateRow, candidates, jobs, type PrivateFileRow, privateFiles } from "../db/schema.js";
import { checkCv } from "../files/cv-file.js";
import { PrivateFilesService } from "../files/private-files.service.js";
import { isJobVisible } from "../shared/jobs/visibility.js";
import type { UploadedCv } from "./apply.service.js";

/** 20 CV uploads per candidate per hour: plenty for fixing a typo or two, little for abuse. */
const CV_UPLOAD_LIMIT = 20;
const CV_UPLOAD_WINDOW_SECONDS = 60 * 60;

export interface SavedCv {
  name: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface MyApplication {
  id: string;
  job: {
    title: string;
    company: string;
    slug: string;
    /** Still on the site, so its page can be linked. */
    open: boolean;
  };
  /** The employer's status. `awaitingConfirmation`: not sent yet (their email isn't confirmed). */
  status: ApplicationStatus;
  awaitingConfirmation: boolean;
  appliedAt: string;
  statusChangedAt: string;
  /** The CV sent with this application (it doesn't change when they replace their saved CV). */
  cv: { name: string } | null;
}

export interface MyApplications {
  cv: SavedCv | null;
  applications: MyApplication[];
}

const notFound = (message: string) => new ApiError(HttpStatus.NOT_FOUND, "not_found", message);

const savedCv = (file: PrivateFileRow): SavedCv => ({
  name: file.originalName,
  contentType: file.contentType,
  sizeBytes: file.sizeBytes,
  uploadedAt: file.createdAt.toISOString(),
});

/** A signed-in candidate's own side: their applications with the employer's status, and their saved CV. */
@Injectable()
export class MyApplicationsService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly files: PrivateFilesService,
    private readonly rateLimit: RateLimitService,
  ) {}

  async list(candidate: CandidateRow): Promise<MyApplications> {
    const rows = await this.db
      .select({ application: applications, job: jobs, cvName: privateFiles.originalName })
      .from(applications)
      .innerJoin(jobs, eq(jobs.id, applications.jobId))
      .leftJoin(privateFiles, eq(privateFiles.id, applications.resumeFileId))
      .where(eq(applications.candidateId, candidate.id))
      .orderBy(desc(applications.createdAt));
    const cv = await this.savedFile(candidate);
    return {
      cv: cv && savedCv(cv),
      applications: rows.map(({ application, job, cvName }) => ({
        id: application.id,
        job: {
          title: job.title,
          company: job.company,
          slug: job.slug,
          open: isJobVisible({
            status: job.status,
            sample: job.sample,
            postedAt: job.postedAt.toISOString(),
            deadline: job.deadline?.toISOString(),
          }),
        },
        status: application.status,
        awaitingConfirmation: application.awaitingConfirmation,
        appliedAt: application.createdAt.toISOString(),
        statusChangedAt: application.statusChangedAt.toISOString(),
        cv: cvName ? { name: cvName } : null,
      })),
    };
  }

  /** Their saved CV's record, or null. */
  async savedFile(candidate: CandidateRow): Promise<PrivateFileRow | null> {
    if (!candidate.cvFileId) return null;
    return this.files.get(candidate.cvFileId);
  }

  async savedCvFile(candidate: CandidateRow): Promise<{ file: PrivateFileRow; bytes: Buffer }> {
    const file = await this.savedFile(candidate);
    const bytes = file && (await this.files.read(file));
    if (!file || !bytes) throw notFound("You don't have a CV saved.");
    return { file, bytes };
  }

  /** The CV sent with one of their own applications. */
  async applicationCv(candidate: CandidateRow, id: string): Promise<{ file: PrivateFileRow; bytes: Buffer }> {
    const [row] = await this.db
      .select({ fileId: applications.resumeFileId })
      .from(applications)
      .where(and(eq(applications.id, id), eq(applications.candidateId, candidate.id)))
      .limit(1);
    const file = row && (await this.files.get(row.fileId));
    const bytes = file && (await this.files.read(file));
    if (!file || !bytes) throw notFound("This CV is no longer available.");
    return { file, bytes };
  }

  /** Uploads a new saved CV in place of the old one. Applications already sent keep the CV they went with. */
  async replaceCv(candidate: CandidateRow, cv: UploadedCv | undefined): Promise<SavedCv> {
    await this.rateLimit.enforce(
      limitKey("cv-upload", candidate.id),
      CV_UPLOAD_LIMIT,
      CV_UPLOAD_WINDOW_SECONDS,
      "Too many uploads. Please try again in an hour.",
    );
    const check = cv ? checkCv(cv.buffer) : ({ ok: false, error: "Choose your CV" } as const);
    if (!cv || !check.ok) {
      throw new ApiError(HttpStatus.BAD_REQUEST, "validation_failed", check.ok ? "Choose your CV" : check.error, {
        cv: check.ok ? "Choose your CV" : check.error,
      });
    }
    const file = await this.files.saveCv(cv.buffer, cv.originalname, check.type, check.contentType);
    await this.setSaved(candidate.id, file.id);
    return savedCv(file);
  }

  /** Forgets their saved CV. The file goes with the next sweep unless an application still uses it. */
  async removeCv(candidate: CandidateRow): Promise<void> {
    await this.setSaved(candidate.id, null);
  }

  private async setSaved(candidateId: string, fileId: string | null): Promise<void> {
    await this.db.update(candidates).set({ cvFileId: fileId, updatedAt: new Date() }).where(eq(candidates.id, candidateId));
  }
}
