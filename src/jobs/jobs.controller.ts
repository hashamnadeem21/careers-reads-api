import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import type { AuthUser } from "../auth/auth-user.js";
import { CurrentUser, StaffOnly } from "../auth/decorators.js";
import { slugParam } from "../common/params.js";
import { ApiZodBody, ApiZodQuery, ZodPipe } from "../common/zod.js";
import { type JobBody, jobBodySchema } from "./job-input.js";
import {
  bulkJobsSchema,
  jobListQuerySchema,
  type JobListQuery,
  jobStatusSchema,
  rejectJobSchema,
} from "./jobs.schemas.js";
import { JobsService } from "./jobs.service.js";

/** Job listings, keyed by slug. Every role; company accounts only ever see their own company's jobs. */
@ApiTags("jobs")
@ApiBearerAuth()
@Controller("jobs")
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  /** One page of jobs (20) plus the status tab counts. */
  @Get()
  @ApiZodQuery(jobListQuerySchema)
  list(@CurrentUser() user: AuthUser, @Query(new ZodPipe(jobListQuerySchema)) query: JobListQuery) {
    return this.jobs.list(user, query);
  }

  /** Job categories for the form. */
  @Get("options")
  options() {
    return this.jobs.categories();
  }

  /** Number of company jobs waiting for review. */
  @Get("review-count")
  @StaffOnly()
  reviewCount() {
    return this.jobs.pendingReviewCount();
  }

  /** The job and its all-time views and Apply clicks. */
  @Get(":slug")
  get(@CurrentUser() user: AuthUser, @Param("slug", slugParam) slug: string) {
    return this.jobs.get(user, slug);
  }

  @Post()
  @ApiZodBody(jobBodySchema)
  create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(jobBodySchema)) body: JobBody) {
    return this.jobs.save(user, null, body);
  }

  /** Save an existing job (the body's `slug` may change its address). */
  @Patch(":slug")
  @ApiZodBody(jobBodySchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param("slug", slugParam) slug: string,
    @Body(new ZodPipe(jobBodySchema)) body: JobBody,
  ) {
    return this.jobs.save(user, slug, body);
  }

  @Delete(":slug")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() user: AuthUser, @Param("slug", slugParam) slug: string): Promise<void> {
    await this.jobs.remove(user, slug);
  }

  @Post("bulk")
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(bulkJobsSchema)
  bulk(@CurrentUser() user: AuthUser, @Body(new ZodPipe(bulkJobsSchema)) body: z.infer<typeof bulkJobsSchema>) {
    return this.jobs.bulk(user, body);
  }

  @Post(":slug/duplicate")
  duplicate(@CurrentUser() user: AuthUser, @Param("slug", slugParam) slug: string) {
    return this.jobs.duplicate(user, slug);
  }

  /** Close applications now (deadline = yesterday). */
  @Post(":slug/close")
  @HttpCode(HttpStatus.OK)
  close(@CurrentUser() user: AuthUser, @Param("slug", slugParam) slug: string) {
    return this.jobs.close(user, slug);
  }

  /** Publish or unpublish. An untrusted company's publish goes to review instead. */
  @Post(":slug/status")
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(jobStatusSchema)
  status(
    @CurrentUser() user: AuthUser,
    @Param("slug", slugParam) slug: string,
    @Body(new ZodPipe(jobStatusSchema)) body: z.infer<typeof jobStatusSchema>,
  ) {
    return this.jobs.setStatus(user, slug, body.status);
  }

  @Post(":slug/approve")
  @StaffOnly()
  @HttpCode(HttpStatus.OK)
  approve(@CurrentUser() user: AuthUser, @Param("slug", slugParam) slug: string) {
    return this.jobs.approve(user, slug);
  }

  /** Send a company's job back with a note. */
  @Post(":slug/reject")
  @StaffOnly()
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(rejectJobSchema)
  reject(
    @CurrentUser() user: AuthUser,
    @Param("slug", slugParam) slug: string,
    @Body(new ZodPipe(rejectJobSchema)) body: z.infer<typeof rejectJobSchema>,
  ) {
    return this.jobs.reject(user, slug, body.note);
  }
}
