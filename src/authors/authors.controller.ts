import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { AuthUser } from "../auth/auth-user.js";
import { CurrentUser, StaffOnly } from "../auth/decorators.js";
import { slugParam } from "../common/params.js";
import { ApiZodBody, formBody } from "../common/zod.js";
import { type AuthorBody, authorBodySchema } from "./authors.schemas.js";
import { AuthorsService } from "./authors.service.js";

@ApiTags("authors")
@Controller("authors")
@StaffOnly()
export class AuthorsController {
  constructor(private readonly authors: AuthorsService) {}

  /** By name, each with `posts` (how many they wrote). */
  @Get()
  list() {
    return this.authors.list();
  }

  @Post()
  @ApiZodBody(authorBodySchema)
  create(@CurrentUser() user: AuthUser, @Body(formBody(authorBodySchema)) body: AuthorBody) {
    return this.authors.save(user, null, body);
  }

  @Patch(":slug")
  @ApiZodBody(authorBodySchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param("slug", slugParam) slug: string,
    @Body(formBody(authorBodySchema)) body: AuthorBody,
  ) {
    return this.authors.save(user, slug, body);
  }

  /** 409 `in_use` while they have posts. */
  @Delete(":slug")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() user: AuthUser, @Param("slug", slugParam) slug: string): Promise<void> {
    await this.authors.remove(user, slug);
  }
}
