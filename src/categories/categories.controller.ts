import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import type { AuthUser } from "../auth/auth-user.js";
import { CurrentUser, StaffOnly } from "../auth/decorators.js";
import { slugParam } from "../common/params.js";
import { ApiZodBody, ApiZodQuery, formBody, ZodPipe } from "../common/zod.js";
import {
  categoryListQuerySchema,
  type CategoryInput,
  categorySchema,
  reorderCategoriesSchema,
} from "./categories.schemas.js";
import { CategoriesService } from "./categories.service.js";

@ApiTags("categories")
@Controller("categories")
@StaffOnly()
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  /** In display order, each with `used` (posts or jobs in it). `?kind=blog|job` to filter. */
  @Get()
  @ApiZodQuery(categoryListQuerySchema)
  list(@Query(new ZodPipe(categoryListQuerySchema)) query: z.infer<typeof categoryListQuerySchema>) {
    return this.categories.list(query.kind);
  }

  @Post()
  @ApiZodBody(categorySchema)
  create(@CurrentUser() user: AuthUser, @Body(formBody(categorySchema)) body: CategoryInput) {
    return this.categories.save(user, null, body);
  }

  @Post("reorder")
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(reorderCategoriesSchema)
  reorder(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(reorderCategoriesSchema)) body: z.infer<typeof reorderCategoriesSchema>,
  ) {
    return this.categories.reorder(user, body.kind, body.slugs);
  }

  /** The body's `slug` may rename it; posts and jobs follow. */
  @Patch(":slug")
  @ApiZodBody(categorySchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param("slug", slugParam) slug: string,
    @Body(formBody(categorySchema)) body: CategoryInput,
  ) {
    return this.categories.save(user, slug, body);
  }

  /** 409 `in_use` while posts or jobs use it. */
  @Delete(":slug")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() user: AuthUser, @Param("slug", slugParam) slug: string): Promise<void> {
    await this.categories.remove(user, slug);
  }
}
