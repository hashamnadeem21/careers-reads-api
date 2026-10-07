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
  UploadedFiles,
  UseInterceptors,
} from "@nestjs/common";
import { ApiBody, ApiConsumes, ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import type { AuthUser } from "../auth/auth-user.js";
import { CurrentUser, StaffOnly } from "../auth/decorators.js";
import { ApiError } from "../common/api-error.js";
import { uuidParam } from "../common/params.js";
import { ApiZodBody, ApiZodQuery, ZodPipe } from "../common/zod.js";
import { altSchema, mediaListQuerySchema, type MediaListQuery, updateMediaSchema } from "./media.schemas.js";
import { MediaService, type UploadedFile } from "./media.service.js";
import { UploadInterceptor } from "./upload.interceptor.js";

@ApiTags("media")
@Controller("media")
@StaffOnly()
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /** Upload up to 20 images (field `files`, optional `alt`). JPG, PNG, WebP or AVIF, 5 MB each. */
  @Post()
  @UseInterceptors(UploadInterceptor)
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["files"],
      properties: {
        files: { type: "array", items: { type: "string", format: "binary" } },
        alt: { type: "string", maxLength: 200 },
      },
    },
  })
  upload(
    @CurrentUser() user: AuthUser,
    @UploadedFiles() files: UploadedFile[] | undefined,
    @Body("alt", new ZodPipe(altSchema.default(""))) alt: string,
  ) {
    if (!files?.length) throw new ApiError(HttpStatus.BAD_REQUEST, "no_files", "Choose at least one image.");
    return this.media.upload(user, files, alt);
  }

  /** 48 images per page, newest first. `q` searches alt text and file names. */
  @Get()
  @ApiZodQuery(mediaListQuerySchema)
  list(@Query(new ZodPipe(mediaListQuerySchema)) query: MediaListQuery) {
    return this.media.list(query);
  }

  @Patch(":id")
  @ApiZodBody(updateMediaSchema)
  update(
    @Param("id", uuidParam) id: string,
    @Body(new ZodPipe(updateMediaSchema)) body: z.infer<typeof updateMediaSchema>,
  ) {
    return this.media.updateAlt(id, body.alt);
  }

  /** Posts and authors that use this image. */
  @Get(":id/usage")
  usage(@Param("id", uuidParam) id: string) {
    return this.media.usageOf(id);
  }

  /** Refused with 409 `in_use` (and `details.usage`) while a post or author uses it. */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() user: AuthUser, @Param("id", uuidParam) id: string): Promise<void> {
    await this.media.remove(user, id);
  }
}
