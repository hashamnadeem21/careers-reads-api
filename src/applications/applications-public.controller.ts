import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { ApiBody, ApiConsumes, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { Public } from "../auth/decorators.js";
import { slugParam } from "../common/params.js";
import { clientIp } from "../common/request.js";
import { SiteOnly } from "../common/site-key.guard.js";
import { ApplyService, type UploadedCv } from "./apply.service.js";
import { CvUploadInterceptor } from "./cv-upload.interceptor.js";

/** The website's application form: what to ask, and sending an application in. */
@ApiTags("public")
@Controller("public/jobs")
export class ApplicationsPublicController {
  constructor(private readonly apply: ApplyService) {}

  /** The job's screening questions. 404 `not_accepting` unless it's taking applications on Career Reads. */
  @Get(":slug/application-form")
  @Public()
  form(@Param("slug", slugParam) slug: string) {
    return this.apply.form(slug);
  }

  /**
   * Apply (multipart). The website forwards the visitor's address for the rate limit (5 an hour).
   * 400 `validation_failed` with `fields` (answers as `answers.<question id>`). A repeat application
   * gets the same 201 but changes nothing (so nobody can probe who applied where).
   */
  @Post(":slug/applications")
  @SiteOnly()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(CvUploadInterceptor)
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["name", "email", "phone", "consent", "cv"],
      properties: {
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        location: { type: "string" },
        linkedinUrl: { type: "string" },
        coverLetter: { type: "string" },
        answers: { type: "string", description: "JSON object of answers keyed by question id" },
        consent: { type: "string", enum: ["true"] },
        cv: { type: "string", format: "binary", description: "PDF, DOC or DOCX, up to 5 MB" },
      },
    },
  })
  async submit(
    @Req() request: Request,
    @Param("slug", slugParam) slug: string,
    @Body() body: unknown,
    @UploadedFile() cv: UploadedCv | undefined,
  ): Promise<{ message: string }> {
    await this.apply.apply(clientIp(request), slug, body, cv);
    return { message: "Application sent. We've emailed you a copy." };
  }
}
