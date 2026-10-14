import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
} from "@nestjs/common";
import { ApiBearerAuth, ApiProduces, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import type { z } from "zod";
import type { AuthUser } from "../auth/auth-user.js";
import { CurrentUser, SuperAdminOnly } from "../auth/decorators.js";
import { uuidParam } from "../common/params.js";
import { ApiZodBody, ApiZodQuery, ZodPipe } from "../common/zod.js";
import {
  applicationListQuerySchema,
  type ApplicationListQuery,
  bulkStatusSchema,
  cvQuerySchema,
  exportQuerySchema,
  forgetCandidateSchema,
  noteSchema,
  setStatusSchema,
} from "./applications.schemas.js";
import { ApplicationsService } from "./applications.service.js";

/** RFC 6266 filename, with a plain-ASCII fallback for old clients. */
function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Applications made on Career Reads. Every role; company accounts only ever see applications to
 * their own company's jobs, editors those to Career Reads' own jobs.
 */
@ApiTags("applications")
@ApiBearerAuth()
@Controller("applications")
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  /** One page (25), newest first, with the count for each status. */
  @Get()
  @ApiZodQuery(applicationListQuerySchema)
  list(@CurrentUser() user: AuthUser, @Query(new ZodPipe(applicationListQuerySchema)) query: ApplicationListQuery) {
    return this.applications.list(user, query);
  }

  /** How many are still "new" (the sidebar badge). */
  @Get("new-count")
  newCount(@CurrentUser() user: AuthUser) {
    return this.applications.newCount(user);
  }

  /** CSV of one job's applications (with a column per question), or of all of them. */
  @Get("export")
  @ApiZodQuery(exportQuerySchema)
  @ApiProduces("text/csv")
  async export(
    @CurrentUser() user: AuthUser,
    @Query(new ZodPipe(exportQuerySchema)) query: z.infer<typeof exportQuerySchema>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const csv = await this.applications.exportCsv(user, query.job);
    const name = `applications${query.job ? `-${query.job}` : ""}-${new Date().toISOString().slice(0, 10)}.csv`;
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": disposition("attachment", name),
      "Cache-Control": "private, no-store",
    });
    return `\uFEFF${csv}`; // the BOM makes Excel read it as UTF-8
  }

  @Post("bulk-status")
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(bulkStatusSchema)
  bulkStatus(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(bulkStatusSchema)) body: z.infer<typeof bulkStatusSchema>,
  ) {
    return this.applications.bulkStatus(user, body.ids, body.status);
  }

  /** Super admin: delete everything held about one person (a privacy request). */
  @Post("forget")
  @SuperAdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(forgetCandidateSchema)
  forget(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(forgetCandidateSchema)) body: z.infer<typeof forgetCandidateSchema>,
  ) {
    return this.applications.forgetCandidate(user, body.email);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id", uuidParam) id: string) {
    return this.applications.get(user, id);
  }

  /** The CV file. PDFs open in the browser unless `download=true`; Word files always download. */
  @Get(":id/cv")
  @ApiZodQuery(cvQuerySchema)
  @ApiProduces("application/pdf", "application/msword")
  async cv(
    @CurrentUser() user: AuthUser,
    @Param("id", uuidParam) id: string,
    @Query(new ZodPipe(cvQuerySchema)) query: z.infer<typeof cvQuerySchema>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { file, bytes } = await this.applications.cv(user, id);
    const inline = file.contentType === "application/pdf" && query.download !== "true";
    res.set({
      "Content-Type": file.contentType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": disposition(inline ? "inline" : "attachment", file.originalName),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    return new StreamableFile(bytes);
  }

  @Patch(":id/status")
  @ApiZodBody(setStatusSchema)
  setStatus(
    @CurrentUser() user: AuthUser,
    @Param("id", uuidParam) id: string,
    @Body(new ZodPipe(setStatusSchema)) body: z.infer<typeof setStatusSchema>,
  ) {
    return this.applications.setStatus(user, id, body.status);
  }

  /** A private note on the application. */
  @Post(":id/notes")
  @ApiZodBody(noteSchema)
  addNote(
    @CurrentUser() user: AuthUser,
    @Param("id", uuidParam) id: string,
    @Body(new ZodPipe(noteSchema)) body: z.infer<typeof noteSchema>,
  ) {
    return this.applications.addNote(user, id, body.note);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() user: AuthUser, @Param("id", uuidParam) id: string): Promise<void> {
    await this.applications.remove(user, id);
  }
}
