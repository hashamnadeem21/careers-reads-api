import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import type { AuthUser } from "../auth/auth-user.js";
import { CurrentUser, StaffOnly } from "../auth/decorators.js";
import { slugParam } from "../common/params.js";
import { ApiZodBody, ApiZodQuery, ZodPipe } from "../common/zod.js";
import {
  bulkPostsSchema,
  postListQuerySchema,
  type PostListQuery,
  type SavePostInput,
  savePostSchema,
} from "./posts.schemas.js";
import { PostsService } from "./posts.service.js";

/** Blog posts, keyed by slug. Staff only. */
@ApiTags("posts")
@Controller("posts")
@StaffOnly()
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  /** One page of posts (20) plus the status tab counts. */
  @Get()
  @ApiZodQuery(postListQuerySchema)
  list(@Query(new ZodPipe(postListQuerySchema)) query: PostListQuery) {
    return this.posts.list(query);
  }

  /** Blog categories and authors for the editor. */
  @Get("options")
  options() {
    return this.posts.editorOptions();
  }

  @Get(":slug")
  get(@Param("slug", slugParam) slug: string) {
    return this.posts.get(slug);
  }

  /** Create a post. `intent`: draft, publish, schedule (with `scheduleAt`) or autosave. */
  @Post()
  @ApiZodBody(savePostSchema)
  create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(savePostSchema)) body: SavePostInput) {
    return this.posts.save(user, null, body);
  }

  /** Save an existing post (the body's `slug` may rename it). Also: update, unpublish. */
  @Patch(":slug")
  @ApiZodBody(savePostSchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param("slug", slugParam) slug: string,
    @Body(new ZodPipe(savePostSchema)) body: SavePostInput,
  ) {
    return this.posts.save(user, slug, body);
  }

  @Delete(":slug")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() user: AuthUser, @Param("slug", slugParam) slug: string): Promise<void> {
    await this.posts.remove(user, slug);
  }

  @Post(":slug/duplicate")
  duplicate(@CurrentUser() user: AuthUser, @Param("slug", slugParam) slug: string) {
    return this.posts.duplicate(user, slug);
  }

  @Post("bulk")
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(bulkPostsSchema)
  bulk(@CurrentUser() user: AuthUser, @Body(new ZodPipe(bulkPostsSchema)) body: z.infer<typeof bulkPostsSchema>) {
    return this.posts.bulk(user, body);
  }
}
