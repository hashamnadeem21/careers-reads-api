import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from "@nestjs/common";
import { ApiHeader, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import type { z } from "zod";
import { Public } from "../auth/decorators.js";
import { ApiError } from "../common/api-error.js";
import { slugParam } from "../common/params.js";
import { clientIp } from "../common/request.js";
import { isSiteRequest, SiteOnly } from "../common/site-key.guard.js";
import { ApiZodBody, ApiZodQuery, ZodPipe } from "../common/zod.js";
import {
  articleQuerySchema,
  articlesQuerySchema,
  contactSchema,
  statsSchema,
  subscribeSchema,
} from "./public.schemas.js";
import { PublicService } from "./public.service.js";

/** `?preview=1` from anyone but the website's server is refused, never silently ignored. */
function wantsPreview(request: Request, preview: string | undefined): boolean {
  if (preview !== "1" && preview !== "true") return false;
  if (!isSiteRequest(request)) {
    throw new ApiError(HttpStatus.FORBIDDEN, "site_key_required", "Previews need the website's server key.");
  }
  return true;
}

/** Read-only endpoints for the website, plus its form and stats writes (those need its server key). */
@ApiTags("public")
@Controller("public")
export class PublicController {
  constructor(private readonly content: PublicService) {}

  @Get("articles")
  @Public()
  @ApiZodQuery(articlesQuerySchema)
  articles(
    @Req() request: Request,
    @Query(new ZodPipe(articlesQuerySchema)) query: z.infer<typeof articlesQuerySchema>,
  ) {
    const preview = wantsPreview(request, query.preview);
    return query.view === "summary" ? this.content.listArticleSummaries(preview) : this.content.listArticles(preview);
  }

  @Get("articles/:slug")
  @Public()
  @ApiZodQuery(articleQuerySchema)
  article(
    @Req() request: Request,
    @Param("slug", slugParam) slug: string,
    @Query(new ZodPipe(articleQuerySchema)) query: z.infer<typeof articleQuerySchema>,
  ) {
    return this.content.getArticle(slug, wantsPreview(request, query.preview));
  }

  @Get("jobs")
  @Public()
  jobs() {
    return this.content.listJobs();
  }

  @Get("jobs/:slug")
  @Public()
  job(@Param("slug", slugParam) slug: string) {
    return this.content.getJob(slug);
  }

  @Get("categories")
  @Public()
  categories() {
    return this.content.listCategories();
  }

  @Get("authors")
  @Public()
  authors() {
    return this.content.listAuthors();
  }

  @Get("authors/:slug")
  @Public()
  author(@Param("slug", slugParam) slug: string) {
    return this.content.getAuthor(slug);
  }

  @Get("settings")
  @Public()
  settings() {
    return this.content.getSettings();
  }

  @Post("contact")
  @SiteOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiZodBody(contactSchema)
  async contact(@Req() request: Request, @Body(new ZodPipe(contactSchema)) body: z.infer<typeof contactSchema>) {
    await this.content.contact(clientIp(request), body);
  }

  @Post("subscribe")
  @SiteOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiZodBody(subscribeSchema)
  async subscribe(@Req() request: Request, @Body(new ZodPipe(subscribeSchema)) body: z.infer<typeof subscribeSchema>) {
    await this.content.subscribe(clientIp(request), body.email);
  }

  /** The website forwards the visitor's user agent in `X-Client-User-Agent` so bots can be ignored. */
  @Post("stats")
  @SiteOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiHeader({ name: "x-client-user-agent", required: false })
  @ApiZodBody(statsSchema)
  async stats(@Req() request: Request, @Body(new ZodPipe(statsSchema)) body: z.infer<typeof statsSchema>) {
    const userAgent = request.header("x-client-user-agent") ?? request.header("user-agent") ?? "";
    await this.content.recordStat(clientIp(request), userAgent, body);
  }
}
