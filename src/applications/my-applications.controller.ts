import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { ApiBody, ApiConsumes, ApiProduces, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import type { z } from "zod";
import { CandidateOnly, CurrentCandidate } from "../candidates/candidate.guard.js";
import { uuidParam } from "../common/params.js";
import { ApiZodQuery, ZodPipe } from "../common/zod.js";
import type { CandidateRow } from "../db/schema.js";
import { setFileHeaders } from "../files/download.js";
import { cvQuerySchema } from "./applications.schemas.js";
import type { UploadedCv } from "./apply.service.js";
import { CvUploadInterceptor } from "./cv-upload.interceptor.js";
import { type MyApplications, MyApplicationsService, type SavedCv } from "./my-applications.service.js";

/**
 * "My applications" on the website: the signed-in candidate's applications with the employer's
 * status, and the CV saved on their account. Website server only (site key + X-Candidate-Session).
 */
@ApiTags("public")
@Controller("public/candidate")
export class MyApplicationsController {
  constructor(private readonly mine: MyApplicationsService) {}

  /** Their applications, newest first, and their saved CV. */
  @Get("applications")
  @CandidateOnly()
  list(@CurrentCandidate() candidate: CandidateRow): Promise<MyApplications> {
    return this.mine.list(candidate);
  }

  /** The CV sent with one of their applications. 404 `not_found` for anyone else's. */
  @Get("applications/:id/cv")
  @CandidateOnly()
  @ApiZodQuery(cvQuerySchema)
  @ApiProduces("application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
  async applicationCv(
    @CurrentCandidate() candidate: CandidateRow,
    @Param("id", uuidParam) id: string,
    @Query(new ZodPipe(cvQuerySchema)) query: z.infer<typeof cvQuerySchema>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { file, bytes } = await this.mine.applicationCv(candidate, id);
    setFileHeaders(res, file, bytes, query.download === "true");
    return new StreamableFile(bytes);
  }

  /** Their saved CV. 404 `not_found` when there isn't one. */
  @Get("cv")
  @CandidateOnly()
  @ApiZodQuery(cvQuerySchema)
  @ApiProduces("application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
  async cv(
    @CurrentCandidate() candidate: CandidateRow,
    @Query(new ZodPipe(cvQuerySchema)) query: z.infer<typeof cvQuerySchema>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { file, bytes } = await this.mine.savedCvFile(candidate);
    setFileHeaders(res, file, bytes, query.download === "true");
    return new StreamableFile(bytes);
  }

  /** Upload a new CV (multipart, `cv`: PDF or DOCX up to 5 MB). It's offered next time they apply. */
  @Post("cv")
  @CandidateOnly()
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(CvUploadInterceptor)
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["cv"],
      properties: { cv: { type: "string", format: "binary", description: "PDF or DOCX, up to 5 MB" } },
    },
  })
  async replaceCv(@CurrentCandidate() candidate: CandidateRow, @UploadedFile() cv: UploadedCv | undefined): Promise<{ cv: SavedCv }> {
    return { cv: await this.mine.replaceCv(candidate, cv) };
  }

  /** Remove the saved CV. Applications already sent keep theirs. */
  @Delete("cv")
  @CandidateOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeCv(@CurrentCandidate() candidate: CandidateRow): Promise<void> {
    await this.mine.removeCv(candidate);
  }
}
